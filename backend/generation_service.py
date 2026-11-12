"""Durable AI workflow shared by the desktop API and the standalone MCP server.

Only the process holding the workspace lock recovers and executes queued jobs.
Other processes can enqueue, read, cancel and import through the same Store.
"""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import inspect
import json
import os
import threading

from .ai import AiProviderError, OpenAICompatibleProvider, contains_sensitive_string
from .ai_candidates import prepare_candidates
from .models import AiCandidateSelect, AiGenerationRequest, Document
from .store import Conflict, Store


class GenerationNotConfigured(Exception):
    pass


class WorkspaceWorkerLock:
    """Nonblocking OS lock, released by the kernel if the worker process dies."""

    def __init__(self, root):
        self.path = root / '.generation-worker.lock'
        self.file = None

    def acquire(self):
        handle = self.path.open('a+b')
        try:
            if os.name == 'nt':
                import msvcrt
                if self.path.stat().st_size == 0:
                    handle.write(b'0')
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, PermissionError):
            handle.close()
            return False
        except BaseException:
            handle.close()
            raise
        self.file = handle
        return True

    def release(self):
        if self.file is not None:
            if os.name == 'nt':
                import msvcrt
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            self.file.close()
            self.file = None


class GenerationService:
    def __init__(self, store: Store, *, provider_factory=OpenAICompatibleProvider):
        self.store = store
        self.provider_factory = provider_factory
        self._shutdown = threading.Event()
        self._thread = None
        self._guard = threading.Lock()
        self._profile_locks = {}
        self._events = {}

    def start(self):
        with self._guard:
            if self._thread is not None and self._thread.is_alive():
                return
            self._shutdown.clear()
            self._events.clear()
            self._thread = threading.Thread(target=self._dispatch, name='pixelart-ai-queue', daemon=True)
            self._thread.start()

    def stop(self):
        self._shutdown.set()
        with self._guard:
            for event in self._events.values():
                event.set()
        if self._thread is not None:
            self._thread.join()

    def submit(self, request: AiGenerationRequest, request_key: str | None = None):
        if request_key is not None:
            replay = self.store.generation_for_request(request, request_key)
            if replay is not None:
                return replay
        profile_id, config = self.store.ai_provider_snapshot()
        if not config.apiKey:
            raise GenerationNotConfigured('尚未配置 AI API Key，请在 AI 设置中填写')
        return self.store.create_generation(request, config, profile_id, request_key=request_key)

    def retry(self, generation_id: str, request_key: str):
        previous = self.store.generation(generation_id)
        operation = f'retry:{generation_id}'
        replay = self.store.generation_for_request(previous.request, request_key, operation)
        if replay is not None:
            return replay
        if previous.status not in {'failed', 'cancelled'}:
            raise Conflict('只能重试失败或已取消的任务')
        config = self.store.generation_config(generation_id)
        if config is None or not config.apiKey:
            raise GenerationNotConfigured('原任务的 AI 配置不可用，请重新提交生成请求')
        return self.store.create_generation(previous.request, config, self.store.generation_profile_id(generation_id), request_key=request_key, operation=operation)

    def cancel(self, generation_id: str, *, notify: bool = True):
        result = self.store.update_generation(generation_id, 'cancelled')
        if notify:
            self.signal_cancel(generation_id)
        return result

    def signal_cancel(self, generation_id: str):
        """Wake a local request after its durable cancellation has committed."""
        with self._guard:
            event = self._events.get(generation_id)
            if event is not None:
                event.set()

    def candidate(self, generation_id: str, candidate_id: str):
        task = self.store.generation(generation_id)
        if task.status != 'succeeded' or task.result is None:
            raise Conflict('AI 任务尚未成功')
        candidate = next((item for item in task.result.get('candidates', []) if item.get('id') == candidate_id), None)
        if candidate is None:
            raise KeyError('AI 候选不存在')
        return task, candidate

    def import_candidate(self, generation_id: str, selection: AiCandidateSelect):
        task, candidate = self.candidate(generation_id, selection.candidateId)
        project_id = selection.projectId or task.projectId
        if not project_id:
            raise ValueError('导入候选需要选择项目')
        if candidate.get('discarded'):
            raise Conflict('已淘汰的候选不能导入')
        document = Document.model_validate(candidate['document'])
        if selection.name:
            document.name = selection.name
        document.provenance.update({'kind': 'ai', 'mode': task.mode, 'generationId': task.id, 'candidateId': selection.candidateId, 'model': task.result.get('model'), 'prompt': task.request.prompt})
        return self.store.select_ai_candidate(task.id, selection.candidateId, project_id, document)

    def _dispatch(self):
        lock = WorkspaceWorkerLock(self.store.root)
        while not self._shutdown.is_set():
            if lock.acquire():
                break
            self._shutdown.wait(0.05)
        else:
            return
        try:
            # The lock prevents a second client from resetting a live task.
            self.store.recover_generations()
            with ThreadPoolExecutor(max_workers=2, thread_name_prefix='pixelart-ai') as executor:
                pending = {}
                try:
                    while not self._shutdown.is_set():
                        for task_id, future in list(pending.items()):
                            if future.done():
                                future.result()
                                del pending[task_id]
                                with self._guard:
                                    self._events.pop(task_id, None)
                            else:
                                try:
                                    if self.store.generation(task_id).status == 'cancelled':
                                        self._events[task_id].set()
                                except KeyError:
                                    self._events[task_id].set()
                        if len(pending) < 2:
                            # Store returns newest first; dispatch oldest first.
                            queued = reversed(self.store.list_generations(status='queued', limit=100))
                            for task in queued:
                                if len(pending) == 2:
                                    break
                                if task.id in pending:
                                    continue
                                with self._guard:
                                    event = self._events[task.id] = threading.Event()
                                    if self._shutdown.is_set():
                                        event.set()
                                pending[task.id] = executor.submit(self._run, task.id, event)
                        self._shutdown.wait(0.05)
                finally:
                    with self._guard:
                        for event in self._events.values():
                            event.set()
        finally:
            lock.release()

    def _run(self, generation_id, cancel_event):
        acquired = False
        profile_lock = None
        config = None
        try:
            config = self.store.generation_config(generation_id) or self.store.ai_config()
            profile_id = self.store.generation_profile_id(generation_id)
            key = f'profile:{profile_id}' if profile_id else hashlib.sha256(json.dumps(config.model_dump(exclude={'apiKey'}), sort_keys=True).encode()).hexdigest()
            with self._guard:
                profile_lock = self._profile_locks.setdefault(key, threading.Lock())
            while not acquired:
                if cancel_event.is_set():
                    return
                acquired = profile_lock.acquire(timeout=0.05)
            task = self.store.update_generation(generation_id, 'running')
            if task.status == 'cancelled' or cancel_event.is_set():
                return
            provider = self.provider_factory(config)
            generate = provider.generate_text if task.mode == 'agent_draw' else provider.generate_image
            for attempt in range(3):
                try:
                    try:
                        inspect.signature(generate).bind(task.request, cancel_event=cancel_event)
                    except (TypeError, ValueError):
                        result = generate(task.request)
                    else:
                        result = generate(task.request, cancel_event=cancel_event)
                    break
                except AiProviderError as error:
                    if error.category == 'cancelled' or cancel_event.is_set():
                        return
                    if error.category not in {'rate_limited', 'timeout', 'address_error', 'transient_error'} or attempt == 2:
                        raise
                    if cancel_event.wait(2 ** attempt):
                        return
            if cancel_event.is_set():
                return
            if config.apiKey and contains_sensitive_string(result, config.apiKey):
                raise AiProviderError('AI 服务结果包含敏感信息，已拒绝保存')
            result = prepare_candidates(result, task.request, self.store.root, config.requestTimeoutSeconds, cancel_event)
            if not cancel_event.is_set():
                self.store.update_generation(generation_id, 'succeeded', result=result)
        except AiProviderError as error:
            if error.category != 'cancelled' and not cancel_event.is_set():
                message = str(error)
                if config and config.apiKey and config.apiKey in message:
                    message = 'AI 服务请求失败，请检查配置后重试'
                self._fail(generation_id, message)
        except KeyError:
            pass  # Project deletion also deletes its tasks.
        except Exception:
            self._fail(generation_id, 'AI 生成失败，请检查配置后重试')
        finally:
            # Never release a lock owned by a different, still-running job.
            if acquired:
                profile_lock.release()

    def _fail(self, generation_id, message):
        try:
            self.store.update_generation(generation_id, 'failed', error=message)
        except (KeyError, Conflict):
            pass
