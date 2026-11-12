"""Real Store/worker coordination; all provider calls are isolated test doubles."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import subprocess
import sys
import threading
import time

import pytest

from backend.generation_service import GenerationService, WorkspaceWorkerLock
from backend.models import AiConfigUpdate, AiGenerationRequest
from backend.store import Conflict, Store

KEY = 'sk-test-generation-service-only'


def drawing_result():
    return {'kind': 'drawing_commands', 'model': 'fixture-model', 'candidates': [
        {'id': 'one', 'summary': 'red pixel', 'commands': [
            {'tool': 'create_canvas', 'args': {'width': 8, 'height': 8}},
            {'tool': 'draw_rect', 'args': {'x': 1, 'y': 1, 'width': 1, 'height': 1, 'color': '#FF0000'}},
        ]},
    ]}


class DrawingProvider:
    def __init__(self, config):
        self.config = config

    def generate_text(self, request, cancel_event=None):
        return drawing_result()


@pytest.fixture
def store(tmp_path):
    value = Store(tmp_path)
    value.save_ai_config(AiConfigUpdate(apiKey=KEY))
    return value


def wait_for(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.01)
    pytest.fail('Worker did not reach the expected state')


@contextmanager
def running(store, provider=DrawingProvider):
    service = GenerationService(store, provider_factory=provider)
    service.start()
    try:
        yield service
    finally:
        service.stop()


def request(**extra):
    return AiGenerationRequest(mode='agent_draw', prompt='test icon', width=8, height=8, **extra)


def test_submission_key_is_atomic_and_survives_restart(store):
    service = GenerationService(store)
    with ThreadPoolExecutor(max_workers=8) as pool:
        tasks = list(pool.map(lambda _: service.submit(request(), 'one-request'), range(8)))
    assert len({task.id for task in tasks}) == 1
    replay = GenerationService(Store(store.root)).submit(request(), 'one-request')
    assert replay.id == tasks[0].id
    assert len(store.list_generations()) == 1
    with pytest.raises(Conflict):
        service.submit(request().model_copy(update={'prompt': 'different'}), 'one-request')
    with pytest.raises(ValueError):
        service.submit(request(), '../invalid')
    with store.connection() as connection:
        connection.execute('DELETE FROM ai_generations WHERE id=?', (replay.id,))
    with pytest.raises(Conflict):
        service.submit(request(), 'one-request')


def test_two_clients_share_one_executor_and_can_cancel_each_other(store):
    entered, cancelled = threading.Event(), threading.Event()
    calls = []

    class Blocking(DrawingProvider):
        def generate_text(self, request, cancel_event=None):
            calls.append(1)
            entered.set()
            if cancel_event.wait(5):
                cancelled.set()
            return drawing_result()

    with running(store, Blocking) as first:
        task = first.submit(request(), 'first')
        assert entered.wait(2)
        with running(Store(store.root), Blocking) as second:
            time.sleep(0.15)
            assert store.generation(task.id).status == 'running'
            assert calls == [1]
            second.cancel(task.id)
            assert cancelled.wait(2)
            assert second.cancel(task.id).status == 'cancelled'
        assert store.generation(task.id).status == 'cancelled'


def test_leader_release_allows_follower_to_resume_queued_work(store):
    first = GenerationService(store, provider_factory=DrawingProvider)
    second = GenerationService(Store(store.root), provider_factory=DrawingProvider)
    first.start()
    second.start()
    try:
        first.stop()
        task = second.submit(request(), 'handoff')
        wait_for(lambda: store.generation(task.id).status == 'succeeded')
    finally:
        first.stop()
        second.stop()


def test_os_lock_is_released_after_process_death(store):
    child = subprocess.Popen([sys.executable, '-c',
        'from pathlib import Path; from backend.generation_service import WorkspaceWorkerLock; import sys,time; lock=WorkspaceWorkerLock(Path(sys.argv[1])); assert lock.acquire(); print("locked",flush=True); time.sleep(30)', str(store.root)], stdout=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == 'locked'
        lock = WorkspaceWorkerLock(store.root)
        assert lock.acquire() is False
        child.kill()
        child.wait(timeout=5)
        assert lock.acquire() is True
        lock.release()
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        child.stdout.close()


def test_retry_is_idempotent_and_keeps_original_provider_snapshot(store):
    service = GenerationService(store)
    original = service.submit(request(), 'original')
    service.cancel(original.id)
    store.save_ai_config(AiConfigUpdate(apiKey='other-key', textModel='other-model'))
    first = service.retry(original.id, 'retry-once')
    second = GenerationService(Store(store.root)).retry(original.id, 'retry-once')
    assert first.id == second.id != original.id
    assert store.generation_config(first.id).apiKey == KEY
    assert store.generation_config(first.id).textModel != 'other-model'
    assert store.generation(original.id).status == 'cancelled'
    with pytest.raises(Conflict):
        service.retry(first.id, 'cannot-retry-active')


def test_cancelling_waiter_does_not_release_running_jobs_profile_lock(store):
    entered, release = threading.Event(), threading.Event()
    active = 0
    maximum = 0
    guard = threading.Lock()

    class Serial(DrawingProvider):
        def generate_text(self, request, cancel_event=None):
            nonlocal active, maximum
            with guard:
                active += 1
                maximum = max(maximum, active)
            entered.set()
            try:
                assert release.wait(5)
                return drawing_result()
            finally:
                with guard:
                    active -= 1

    with running(store, Serial) as service:
        first = service.submit(request(), 'owner')
        assert entered.wait(2)
        waiter = service.submit(request(), 'waiter')
        time.sleep(0.15)
        service.cancel(waiter.id)
        third = service.submit(request(), 'third')
        try:
            time.sleep(0.2)
            assert maximum == 1
            assert store.generation(first.id).status == 'running'
            assert store.generation(third.id).status == 'queued'
        finally:
            release.set()
        wait_for(lambda: store.generation(third.id).status == 'succeeded')
        assert maximum == 1
