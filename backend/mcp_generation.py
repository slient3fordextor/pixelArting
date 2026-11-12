"""Typed local MCP task workflow without provider configuration or pixel payloads."""

import json
from typing import Any, Literal

from mcp.server.fastmcp import Image as McpImage
from mcp.types import ToolAnnotations
from pydantic import Field

from .images import composite, png_bytes
from .mcp_auth import current_principal
from .ai_candidates import _candidate_metadata
from .mcp_idempotency import OptionalIdempotencyKey, idempotent_write
from .mcp_contract import ContractModel, ToolFailure, error_result
from .mcp_asset_contract import QualityReport
from .models import AiCandidateSelect, AiCandidateState, AiGenerationRequest, Document
from .quality import inspect

Status = Literal['queued', 'running', 'succeeded', 'failed', 'cancelled']
READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)
GENERATE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=True)


class CandidateSummary(ContractModel):
    id: str
    summary: str
    width: int
    height: int
    colorCount: int
    hasTransparency: bool
    hasSemiTransparency: bool
    favorite: bool
    discarded: bool
    previewResourceUri: str


class GenerationView(ContractModel):
    ok: Literal[True] = True
    contractVersion: Literal['1'] = '1'
    id: str
    projectId: str | None
    mode: Literal['agent_draw', 'image_model']
    status: Status
    revision: int
    request: AiGenerationRequest
    candidates: list[CandidateSummary]
    error: str | None
    created: str
    updated: str
    resourceUri: str


class GenerationList(ContractModel):
    ok: Literal[True] = True
    contractVersion: Literal['1'] = '1'
    generations: list[GenerationView]


class CandidateImport(ContractModel):
    ok: Literal[True] = True
    contractVersion: Literal['1'] = '1'
    assetId: str
    projectId: str
    currentVersionId: str
    name: str
    report: QualityReport


def generation_view(task):
    candidates = []
    for item in (task.result or {}).get('candidates', []):
        metadata = item.get('metadata') or _candidate_metadata(Document.model_validate(item['document']), task.request)
        candidates.append(CandidateSummary(
            id=item['id'], summary=item.get('summary', ''),
            width=metadata['width'], height=metadata['height'], colorCount=metadata['colorCount'],
            hasTransparency=metadata['hasTransparency'], hasSemiTransparency=metadata['hasSemiTransparency'],
            favorite=item.get('favorite', False), discarded=item.get('discarded', False),
            previewResourceUri=f"pixelart://generations/{task.id}/candidates/{item['id']}/preview",
        ))
    return GenerationView(
        id=task.id, projectId=task.projectId, mode=task.mode, status=task.status, revision=task.revision,
        request=task.request, candidates=candidates,
        error='Generation failed; check the local provider configuration before retrying' if task.error else None,
        created=task.created, updated=task.updated, resourceUri=f'pixelart://generations/{task.id}',
    )


def register_generation_tools(mcp, workspace, runtime, require_writes, oauth=None):
    @mcp.resource('pixelart://contract/tasks/v1', mime_type='application/json')
    def task_contract() -> str:
        return json.dumps({
            'contractVersion': '1',
            'taskSchema': GenerationView.model_json_schema(),
            'importSchema': CandidateImport.model_json_schema(),
            'idempotency': 'Workspace-scoped key, 1..128 ASCII letters/digits/_.:-; same operation/request replays the same task, changed input or deleted task conflicts',
            'retry': 'Failed/cancelled tasks only; creates a new job using the saved provider snapshot; key is bound to the source task',
            'progress': 'Poll task resource or get_generation; revision increases on state changes; no push events or percentage estimate',
        }, ensure_ascii=False)

    @mcp.tool(annotations=GENERATE)
    def start_generation(request: AiGenerationRequest, idempotency_key: str = Field(min_length=1, max_length=128, pattern=r'^[a-zA-Z0-9_.:-]+$')) -> GenerationView | ToolFailure:
        """Enqueue AI generation using the locally configured provider. This can incur provider charges.

        Requires write access and an idempotency key: repeat the same key and
        request to resume polling the same job; different input conflicts.
        Never send provider credentials as tool arguments. Poll get_generation.
        """
        try:
            require_writes()
            return generation_view(runtime().submit(request, idempotency_key))
        except Exception as error:
            return error_result(error)

    @mcp.tool(annotations=READ)
    def get_generation(generation_id: str) -> GenerationView | ToolFailure:
        """Poll a durable job. Revision increases when its status or candidate state changes.

        Candidates are compact summaries; read previewResourceUri for PNG pixels.
        Queued/running jobs are recovered when a write-enabled service starts.
        """
        try:
            return generation_view(workspace().generation(generation_id))
        except Exception as error:
            return error_result(error)

    @mcp.tool(annotations=READ)
    def list_generations(project_id: str | None = None, status: Status | None = None, limit: int = Field(default=50, ge=1, le=100)) -> GenerationList | ToolFailure:
        """List bounded job snapshots, newest first, without provider secrets or pixel documents."""
        try:
            principal = current_principal(oauth)
            allowed = principal.projects if principal is not None and not principal.admin else None
            return GenerationList(generations=[generation_view(task) for task in workspace().list_generations(project_id, status, limit, allowed_projects=allowed)])
        except Exception as error:
            return error_result(error)

    @mcp.tool(annotations=WRITE)
    @idempotent_write(workspace, require_writes, after_commit=lambda arguments, result: runtime().signal_cancel(arguments['generation_id']))
    def cancel_generation(generation_id: str, idempotency_key: OptionalIdempotencyKey = None) -> GenerationView | ToolFailure:
        """Cancel queued/running work. Repeated cancellation returns the cancelled job.

        Completed successful/failed jobs cannot be cancelled. Provider requests
        may already have incurred costs before cancellation reaches them.
        """
        try:
            require_writes()
            return generation_view(runtime().cancel(generation_id, notify=idempotency_key is None))
        except Exception as error:
            return error_result(error)

    @mcp.tool(annotations=GENERATE)
    def retry_generation(generation_id: str, idempotency_key: str = Field(min_length=1, max_length=128, pattern=r'^[a-zA-Z0-9_.:-]+$')) -> GenerationView | ToolFailure:
        """Retry a failed/cancelled task using its saved provider/request snapshot.

        Creates one new task per idempotency key and can incur provider charges.
        Successful or active tasks must not be retried; start a new request instead.
        """
        try:
            require_writes()
            return generation_view(runtime().retry(generation_id, idempotency_key))
        except Exception as error:
            return error_result(error)

    @mcp.tool(annotations=READ)
    def get_candidate_preview(generation_id: str, candidate_id: str) -> Any:
        """Render a successful candidate as native MCP image content for visual review."""
        try:
            _, candidate = runtime().candidate(generation_id, candidate_id)
            document = Document.model_validate(candidate['document'])
            return McpImage(data=png_bytes(composite(document, document.frames[0])), format='png')
        except Exception as error:
            return error_result(error).model_dump()

    @mcp.tool(annotations=WRITE)
    @idempotent_write(workspace, require_writes)
    def update_candidate_state(generation_id: str, candidate_id: str, state: AiCandidateState, idempotency_key: OptionalIdempotencyKey = None) -> GenerationView | ToolFailure:
        """Set favorite/discarded state. Discarded candidates cannot be imported."""
        try:
            require_writes()
            return generation_view(workspace().update_candidate_state(generation_id, candidate_id, state.favorite, state.discarded))
        except Exception as error:
            return error_result(error)

    @mcp.tool(annotations=WRITE)
    @idempotent_write(workspace, require_writes)
    def import_generation_candidate(generation_id: str, candidate_id: str, project_id: str | None = None, name: str | None = Field(default=None, min_length=1, max_length=100), idempotency_key: OptionalIdempotencyKey = None) -> CandidateImport | ToolFailure:
        """Import a reviewed candidate as a new asset, once per job/candidate/project.

        Does not overwrite an asset. Use get_asset and inspect_asset afterwards;
        the returned report describes the saved version. A deleted prior import
        cannot be silently recreated by replaying this call.
        """
        try:
            require_writes()
            asset = runtime().import_candidate(generation_id, AiCandidateSelect(candidateId=candidate_id, projectId=project_id, name=name))
            document = Document.model_validate(asset['document'])
            return CandidateImport(assetId=asset['id'], projectId=asset['projectId'], currentVersionId=asset['currentVersionId'], name=asset['name'], report=inspect(document, workspace().asset_config(asset['id'])))
        except Exception as error:
            return error_result(error)

    @mcp.resource('pixelart://generations/{generation_id}', mime_type='application/json')
    def generation_resource(generation_id: str) -> str:
        return generation_view(workspace().generation(generation_id)).model_dump_json()

    @mcp.resource('pixelart://generations/{generation_id}/candidates/{candidate_id}/preview', mime_type='image/png')
    def candidate_resource(generation_id: str, candidate_id: str) -> bytes:
        _, candidate = runtime().candidate(generation_id, candidate_id)
        document = Document.model_validate(candidate['document'])
        return png_bytes(composite(document, document.frames[0]))
