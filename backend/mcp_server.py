"""MCP adapter for PixelArting.

The adapter deliberately calls the same Store and quality code as the HTTP API.
Each server instance is read-only unless its launcher explicitly grants writes.
The standalone CLI is pixelarting-mcp; the module entry retains repository defaults.

Run locally with:

    python -m backend.mcp_server

For an HTTP MCP endpoint:

    PIXELART_MCP_TRANSPORT=streamable-http python -m backend.mcp_server
"""

from __future__ import annotations

import os
import json
import asyncio
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import numpy as np
from mcp.server.fastmcp import FastMCP, Image as McpImage
from mcp.types import ToolAnnotations
from PIL import Image

from .images import composite, encode_image, png_bytes
from .models import CheckConfig, Document, Frame, Layer, RepairAction
from .quality import inspect
from .repairs import repair
from .exports import export_bundle, export_png
from .store import Store
from .generation_service import GenerationService
from .mcp_generation import register_generation_tools
from .mcp_imports import register_import_tools
from .mcp_project_imports import register_project_import_tools
from .mcp_lifecycle import WorkspaceMCP
from .mcp_idempotency import IDEMPOTENCY_URI, IDEMPOTENCY_RULES, OptionalIdempotencyKey, describe_idempotency, idempotent_write
from .mcp_auth import OAuthConfig, PinnedJWTVerifier, READ, WRITE as WRITE_SCOPE, GENERATE, ADMIN, current_principal
from .mcp_policy import MCPPolicy
from .mcp_permissions import PERMISSIONS_URI, TOOL_RULES, RESOURCE_RULES, PermissionsView, permissions_view
from mcp.server.auth.settings import AuthSettings
from mcp.server.transport_security import TransportSecuritySettings
from urllib.parse import urlsplit
from .mcp_contract import CONTRACT_VERSION, SERVICE_VERSION, Capabilities, ExportDescriptor, ToolFailure, error_result
from .mcp_asset_contract import (
    ActionsInput, AssetOutput, AssetSummary, CommitOutput, ConfigInput, ConfigOutput,
    DocumentInput, DocumentOutput, HealthOutput, InspectionOutput, PreviewOutput,
    ProjectInfo, ProjectOutput, ReportOutput, SaveOutput, WireObject,
)


ROOT = Path(__file__).resolve().parents[1]


def _data_root() -> Path:
    return Path(os.environ.get("PIXELART_DATA_DIR", ROOT / "data")).expanduser().resolve()


def _error(error: Exception) -> dict[str, Any]:
    return error_result(error).model_dump()


def _repair_changes(before: Document, after: Document) -> list[dict[str, Any]]:
    """Return compact visual and metadata changes for an agent preview."""
    changes = []
    for old, new in zip(before.frames, after.frames):
        old_pixels = np.array(composite(before, old))
        new_pixels = np.array(composite(after, new))
        height, width = max(old.height, new.height), max(old.width, new.width)
        old_buffer = np.zeros((height, width, 4), dtype=np.uint8)
        new_buffer = np.zeros_like(old_buffer)
        old_buffer[:old.height, :old.width] = old_pixels
        new_buffer[:new.height, :new.width] = new_pixels
        mask = np.any(old_buffer != new_buffer, axis=2)
        ys, xs = np.nonzero(mask)
        bounds = None
        if len(xs):
            bounds = {
                "x": int(xs.min()),
                "y": int(ys.min()),
                "width": int(xs.max() - xs.min() + 1),
                "height": int(ys.max() - ys.min() + 1),
            }
        before_metadata = {
            "origin": old.origin.model_dump() if old.origin else None,
            "baselineY": old.baselineY,
            "collisionRects": [rect.model_dump() for rect in old.collisionRects],
        }
        after_metadata = {
            "origin": new.origin.model_dump() if new.origin else None,
            "baselineY": new.baselineY,
            "collisionRects": [rect.model_dump() for rect in new.collisionRects],
        }
        changes.append({
            "frameId": old.id,
            "changedPixels": int(mask.sum()),
            "before": [old.width, old.height],
            "after": [new.width, new.height],
            "changedBounds": bounds,
            "metadataBefore": before_metadata,
            "metadataAfter": after_metadata,
            "metadataChanged": before_metadata != after_metadata,
        })
    return changes


READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)


def create_mcp_server(
    data_root: Path | None = None,
    *,
    allow_write: bool = False,
    host: str = "127.0.0.1",
    port: int = 8765,
    oauth: OAuthConfig | None = None,
) -> FastMCP:
    """Create one isolated workspace adapter without opening its database.

    Optional OAuth JWT verification uses a pinned issuer and public keys.
    HTTP stays on loopback; remote deployments require an HTTPS reverse proxy.
    Callers must explicitly opt into writes; settings cannot change mid-session.
    """
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Unauthenticated MCP must bind to a loopback address")
    if not 1 <= port <= 65535:
        raise ValueError("MCP port must be between 1 and 65535")
    root = (data_root or _data_root()).expanduser().resolve()

    @lru_cache(maxsize=1)
    def workspace() -> Store:
        return Store(root)

    def _require_writes():
        if not allow_write:
            raise PermissionError("MCP writes are disabled")

    security = MCPPolicy(oauth, workspace, root, allow_write) if oauth else None

    @lru_cache(maxsize=1)
    def generations() -> GenerationService:
        return GenerationService(workspace())

    @asynccontextmanager
    async def lifespan(server):
        if allow_write:
            generations().start()
        try:
            yield
        finally:
            if allow_write:
                await asyncio.to_thread(generations().stop)

    mcp = WorkspaceMCP(
        "pixelarting",
        instructions=(
            "PixelArting local workspace, contract v1. Read get_capabilities before use. "
            "Inspect assets before editing; pass the latest currentVersionId from get_asset. "
            "Use inspect_asset after changes. Review repair preview before committing. "
            "Authorization is enforced by the server when OAuth mode is configured."
        ),
        host=host,
        port=port,
        streamable_http_path="/mcp",
        stateless_http=True,
        workspace_lifespan=lifespan,
        security=security,
        token_verifier=PinnedJWTVerifier(oauth) if oauth else None,
        auth=AuthSettings(issuer_url=oauth.issuer, resource_server_url=oauth.resource,
                          required_scopes=[READ], validate_token_resource=True) if oauth else None,
        transport_security=TransportSecuritySettings(
            allowed_hosts=[urlsplit(oauth.resource).netloc, f"127.0.0.1:{port}", f"localhost:{port}"],
            allowed_origins=[],
        ) if oauth else None,
    )

    register_generation_tools(mcp, workspace, generations, _require_writes, oauth)
    register_import_tools(mcp, workspace, _require_writes)
    register_project_import_tools(mcp, workspace, _require_writes)

    @mcp.resource('pixelart://contract/openapi/v1', mime_type='application/json')
    async def openapi_resource() -> str:
        return json.dumps(await mcp.openapi(), ensure_ascii=False)

    @mcp.tool(annotations=READ_ONLY)
    def get_capabilities() -> Capabilities:
        """Use this first to discover v1 features, limits and local write permissions."""
        principal = current_principal(oauth)
        return Capabilities(writeEnabled=allow_write and (principal is None or principal.can_write),
                            writeConfirmationRequired=bool(oauth and oauth.require_write_confirmation),
                            authentication="oauth-jwt" if oauth else "local-process-only",
                            mode="authenticated-single-workspace" if oauth else "local-single-user",
                            features=Capabilities.model_fields['features'].default + (["oauth-jwt", "project-authorization", "audit", "rate-limits"] if oauth else []) + (["write-confirmation"] if oauth and oauth.require_write_confirmation else []),
                            unavailable=[feature for feature in Capabilities.model_fields['unavailable'].default if feature != 'write-confirmation' or not (oauth and oauth.require_write_confirmation)])

    @mcp.tool(annotations=READ_ONLY)
    def get_permissions() -> PermissionsView:
        """Read current scope/project constraints and per-tool admission flags, without opening the asset database.

        Flags describe scope, process gate and configured confirmation separately;
        they are not a guarantee that a particular target exists or is allowed.
        Every call/resource is still authorized on the server. Local mode has no
        OAuth scopes and trusts the process owner; its write gate still applies.
        """
        return permissions_view(current_principal(oauth), allow_write=allow_write,
                                confirmation_required=bool(oauth and oauth.require_write_confirmation))

    @mcp.resource(PERMISSIONS_URI, mime_type='application/json')
    def permissions_contract() -> str:
        return json.dumps({
            'contractVersion': CONTRACT_VERSION,
            'tools': {name: rule.describe().model_dump() for name, rule in TOOL_RULES.items()},
            'resources': [rule.describe().model_dump() for rule in RESOURCE_RULES],
            'effectiveSchema': PermissionsView.model_json_schema(),
            'effectiveTool': 'get_permissions',
            'scopePolicy': 'Every OAuth tool/resource requires read; scopes are token/grant intersection. Admin does not imply write or generate. Local mode has no OAuth scopes.',
            'flagPolicy': 'scopeAllowed and writeGateAllowed are independent prerequisites, not a target authorization decision. Project ownership/existence, versions, domain validation, budgets, audit availability and configured confirmation remain checked for each operation.',
            'projectPolicy': 'Effective admin grants workspace project access. Otherwise explicit projectIds constrain every owner/argument and filter lists; listed IDs are grants, not evidence of existing projects. Unscoped generation requires admin.',
            'confirmationPolicy': 'confirmationRequired describes the configured gate, not an approval receipt. Every authorized write, including idempotent replay, needs fresh one-use consent when enabled.',
            'compatibilityPolicy': 'Discovery metadata is advisory. Unknown tools/resources are denied by the OAuth registry; changing returned metadata never grants permission. State can change after discovery; local flags do not configure OAuth.',
        }, ensure_ascii=False)

    @mcp.resource(IDEMPOTENCY_URI, mime_type='application/json')
    def idempotency_contract() -> str:
        return json.dumps({
            'contractVersion': '1',
            'tools': {name: describe_idempotency(name) for name in IDEMPOTENCY_RULES},
            'keySchema': {'type': 'string', 'minLength': 1, 'maxLength': 128, 'pattern': '^[a-zA-Z0-9_.:-]+$'},
            'scope': 'Keys are workspace-wide within the declared namespace; the mcp-writes namespace is shared by its tools. Required key namespaces remain unchanged.',
            'fingerprint': 'mcp-writes binds the tool and parsed arguments with defaults, excluding the key, to canonical JSON SHA-256. Different operation/arguments conflict.',
            'atomicity': 'mcp-writes commits local business changes and the original successful response in one immediate SQLite transaction. Failed calls roll back and reserve no key. Provider execution is outside this guarantee.',
            'replay': 'mcp-writes returns the original response snapshot without executing the operation or undoing later edits. Read current state before the next write. Missing original result resources conflict and are never recreated.',
            'legacy': 'Omitted/null optional keys retain existing semantics and do not gain automatic retry safety. Existing preview/candidate natural identities remain supported.',
            'authorization': 'Every replay rechecks scope, project, process gate, budgets, audit and configured one-use confirmation before receipt access. Keys grant no permission.',
            'retention': 'Receipts persist across restarts with the workspace; no expiry/cleanup policy yet. Do not delete receipts to retry an uncertain write.',
        }, ensure_ascii=False)

    @mcp.resource("pixelart://contract/v1", mime_type="application/json")
    def contract_resource() -> str:
        return json.dumps({
            "capabilities": get_capabilities().model_dump(),
            "errors": ToolFailure.model_json_schema(),
            "exports": ExportDescriptor.model_json_schema(),
            "taskContractUri": "pixelart://contract/tasks/v1",
            "importContractUri": "pixelart://contract/imports/v1",
            "projectImportContractUri": "pixelart://contract/project-imports/v1",
            "securityContractUri": "pixelart://contract/security/v1",
            "permissionsContractUri": PERMISSIONS_URI,
            "idempotencyContractUri": IDEMPOTENCY_URI,
            "openapiResourceUri": "pixelart://contract/openapi/v1",
            "workspaceApiBasePath": "/api/v1",
            "openapiPath": "/api/v1/openapi.json",
            "assetContracts": {
                "health": HealthOutput.model_json_schema(),
                "project": ProjectOutput.model_json_schema(),
                "asset": AssetOutput.model_json_schema(),
                "inspection": InspectionOutput.model_json_schema(),
                "repairPreview": PreviewOutput.model_json_schema(),
                "repairCommit": CommitOutput.model_json_schema(),
                "historicalReport": ReportOutput.model_json_schema(),
            },
            "versionPolicy": "Additive v1 changes; existing tool names and asset document schema are preserved",
            "writePolicy": "Read currentVersionId before asset updates; inspect_asset after writes",
        }, ensure_ascii=False)

    @mcp.resource("pixelart://contract/security/v1", mime_type="application/json")
    def security_contract() -> str:
        return json.dumps({
            "contractVersion": "1", "authentication": "oauth-jwt" if oauth else "local-process-only",
            "configurationSchema": OAuthConfig.model_json_schema(),
            "permissionsContractUri": PERMISSIONS_URI,
            "scopes": {READ: "Read allowed projects", WRITE_SCOPE: "Write allowed projects; also requires process write gate",
                       GENERATE: "Start/retry paid provider generation; also requires write scope", ADMIN: "Workspace-wide projects, project creation and project backup preview/import"},
            "projectPolicy": "Token scopes intersect operator grants; all tools and resources check project ownership",
            "auditPolicy": "OAuth tool/resource calls reserve shared rate budgets and persist argument-free attempt/outcome records",
            "writeConfirmation": {
                "required": bool(oauth and oauth.require_write_confirmation),
                "policy": "Exact OAuth write arguments, issuer/resource/workspace/subject/client binding; local operator review and one-use approval, expires after 600 seconds",
                "onRequired": "MCP tool error write_confirmation_required; details in _meta['pixelarting/writeConfirmation'] and text content, no business structuredContent; retry identical call after local approval",
                "operatorCommands": ["--review-write REQUEST_ID", "--approve-write REQUEST_ID --approval-digest DIGEST", "--reject-write REQUEST_ID"],
                "failurePolicy": "Approval is consumed before execution; inspect state after errors before requesting fresh approval",
            },
        }, ensure_ascii=False)

    def export_bytes(asset_id: str, version_id: str, target: str, frame_id: str) -> bytes:
        document = workspace().document(asset_id, version_id)
        data = export_png(document, frame_id) if target == "png" else export_bundle(document, asset_id, version_id, target)
        if len(data) > 16 * 1024 * 1024:
            raise ValueError("MCP exports are limited to 16 MiB; use the desktop HTTP export for larger assets")
        return data

    @mcp.resource("pixelart://exports/{asset_id}/{version_id}/png/{frame_id}", mime_type="image/png")
    def png_export_resource(asset_id: str, version_id: str, frame_id: str) -> bytes:
        return export_bytes(asset_id, version_id, "png", frame_id)

    @mcp.resource("pixelart://exports/{asset_id}/{version_id}/{target}/bundle", mime_type="application/zip")
    def bundle_export_resource(asset_id: str, version_id: str, target: str) -> bytes:
        if target not in {"frames", "sheet", "json", "godot"}:
            raise ValueError("Unsupported export target")
        return export_bytes(asset_id, version_id, target, "")

    @mcp.tool(annotations=READ_ONLY)
    def export_asset(
        asset_id: str,
        version_id: str,
        target: Literal["png", "frames", "sheet", "json", "godot"] = "png",
        frame_id: str | None = None,
    ) -> ExportDescriptor | ToolFailure:
        """Export an immutable version without changing it. Read resourceUri using resources/read for binary bytes.

        Use get_asset to choose a version first. PNG uses the requested frame or
        the first frame. ZIP exports include all frames and reject frame_id.
        The binary resource is limited to 16 MiB and never contains a local path.
        """
        try:
            document = workspace().document(asset_id, version_id)
            if target != "png" and frame_id is not None:
                raise ValueError("frame_id is only supported for PNG exports")
            frame = (frame_id or document.frames[0].id) if target == "png" else "bundle"
            data = export_bytes(asset_id, version_id, target, frame)
            extension = "png" if target == "png" else "zip"
            return ExportDescriptor(
                assetId=asset_id, versionId=version_id,
                frameId=frame if target == "png" else None, target=target,
                resourceUri=f"pixelart://exports/{asset_id}/{version_id}/{target}/{frame}",
                mimeType="image/png" if target == "png" else "application/zip",
                filename=f"pixelart-{asset_id}-{version_id}-{target}.{extension}",
                byteLength=len(data),
            )
        except Exception as error:
            return error_result(error)

    @mcp.tool(annotations=READ_ONLY)
    def pixelart_health() -> HealthOutput:
        """Return server status and whether this MCP process can write."""
        capabilities = get_capabilities()
        return {
            "ok": True,
            "service": "PixelArting",
            "mode": capabilities.mode,
            "dataRoot": None if oauth else str(workspace().root),
            "writeEnabled": capabilities.writeEnabled,
            "contractVersion": CONTRACT_VERSION,
            "serviceVersion": SERVICE_VERSION,
        }


    @mcp.tool(annotations=READ_ONLY)
    def list_projects() -> list[ProjectInfo]:
        """List all PixelArting projects."""
        projects = workspace().list_projects()
        principal = current_principal(oauth)
        return projects if principal is None or principal.admin else [item for item in projects if principal.allows_project(item['id'])]


    @mcp.tool(annotations=READ_ONLY)
    def list_assets(project_id: str) -> list[WireObject[AssetSummary | ToolFailure]]:
        """List assets in a project, including dimensions, frame count, and current version."""
        try:
            return workspace().list_assets(project_id)
        except Exception as error:
            return [_error(error)]


    @mcp.tool(annotations=READ_ONLY)
    def get_asset(asset_id: str, include_document: bool = False) -> AssetOutput:
        """Read an asset's metadata and version history; optionally include its complete document."""
        try:
            asset = workspace().asset(asset_id)
            if not include_document:
                asset.pop("document", None)
            return asset
        except Exception as error:
            return _error(error)


    @mcp.tool(annotations=READ_ONLY)
    def get_asset_version(asset_id: str, version_id: str) -> DocumentOutput:
        """Read a specific immutable asset version, including layer and frame pixel PNG data."""
        try:
            return workspace().document(asset_id, version_id).model_dump()
        except Exception as error:
            return _error(error)


    @mcp.tool(annotations=READ_ONLY)
    def get_asset_preview(
        asset_id: str,
        version_id: str | None = None,
        frame_id: str | None = None,
        max_size: int = 256,
    ) -> Any:
        """Return a rendered PNG preview of one asset frame for visual agents."""
        try:
            if not 16 <= max_size <= 1024:
                raise ValueError("max_size 必须在 16 到 1024 之间")
            asset = workspace().asset(asset_id)
            version = version_id or asset["currentVersionId"]
            document = workspace().document(asset_id, version)
            frame = next((item for item in document.frames if item.id == frame_id), None) if frame_id else document.frames[0]
            if frame is None:
                raise KeyError("素材帧不存在")
            image = composite(document, frame)
            image.thumbnail((max_size, max_size), Image.Resampling.NEAREST)
            return McpImage(data=png_bytes(image), format="png")
        except Exception as error:
            return _error(error)


    @mcp.tool(annotations=READ_ONLY)
    def get_project_config(project_id: str) -> ConfigOutput:
        """Read the quality-check and export configuration for a project."""
        try:
            return workspace().project_config(project_id).model_dump()
        except Exception as error:
            return _error(error)


    @mcp.tool(annotations=READ_ONLY)
    def list_reports(
        asset_id: str,
        version_id: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[ReportOutput]:
        """List stored quality reports for an asset."""
        try:
            return workspace().list_reports(asset_id, version_id, limit, offset)
        except Exception as error:
            return [_error(error)]


    @mcp.tool(annotations=READ_ONLY)
    def inspect_asset(asset_id: str, version_id: str | None = None) -> InspectionOutput:
        """Run PixelArting's quality rules without changing the asset or creating a report."""
        try:
            asset = workspace().asset(asset_id)
            version = version_id or asset["currentVersionId"]
            document = workspace().document(asset_id, version)
            report = inspect(document, workspace().asset_config(asset_id))
            return {"assetId": asset_id, "versionId": version, "report": report}
        except Exception as error:
            return _error(error)


    @mcp.tool(annotations=WRITE)
    @idempotent_write(workspace, _require_writes)
    def preview_asset_repair(
        asset_id: str,
        version_id: str,
        actions: ActionsInput,
        idempotency_key: OptionalIdempotencyKey = None,
    ) -> PreviewOutput:
        """Preview one or more deterministic quality repairs without changing the current asset version."""
        try:
            _require_writes()
            if not 1 <= len(actions) <= 5:
                raise ValueError("actions 必须包含 1 到 5 个修复动作")
            parsed_actions = [RepairAction.model_validate(action) for action in actions]
            before = workspace().document(asset_id, version_id)
            config = workspace().asset_config(asset_id)
            after = repair(before, config, parsed_actions)
            preview_id = workspace().preview(
                asset_id,
                version_id,
                after,
                [action.model_dump() for action in parsed_actions],
                config.model_dump(),
            )
            return {
                "ok": True,
                "previewId": preview_id,
                "baseVersionId": version_id,
                "actions": [action.model_dump() for action in parsed_actions],
                "changes": _repair_changes(before, after),
                "report": inspect(after, config),
            }
        except Exception as error:
            return _error(error)


    @mcp.tool(annotations=WRITE)
    @idempotent_write(workspace, _require_writes)
    def commit_asset_repair(
        asset_id: str,
        preview_id: str,
        expected_current_version_id: str,
        idempotency_key: OptionalIdempotencyKey = None,
    ) -> CommitOutput:
        """Commit a repair preview after confirming the asset version has not changed."""
        try:
            _require_writes()
            version_id, config_data = workspace().commit(asset_id, preview_id, expected_current_version_id)
            document = workspace().document(asset_id, version_id)
            report = workspace().save_report(asset_id, version_id, inspect(document, CheckConfig.model_validate(config_data)))
            return {
                "ok": True,
                "asset": workspace().asset(asset_id),
                "report": report,
                "resultVersionId": version_id,
            }
        except Exception as error:
            return _error(error)


    @mcp.tool(annotations=WRITE)
    @idempotent_write(workspace, _require_writes)
    def restore_asset_version(
        asset_id: str,
        expected_current_version_id: str,
        version_id: str,
        idempotency_key: OptionalIdempotencyKey = None,
    ) -> AssetOutput:
        """Restore an immutable earlier version with optimistic version checking."""
        try:
            _require_writes()
            return workspace().restore(asset_id, expected_current_version_id, version_id)
        except Exception as error:
            return _error(error)


    @mcp.tool(annotations=WRITE)
    @idempotent_write(workspace, _require_writes)
    def update_project_config(project_id: str, config: ConfigInput, idempotency_key: OptionalIdempotencyKey = None) -> ConfigOutput:
        """Replace a project's quality-check configuration. Requires write access."""
        try:
            _require_writes()
            return workspace().save_project_config(project_id, CheckConfig.model_validate(config)).model_dump()
        except Exception as error:
            return _error(error)


    @mcp.tool(annotations=WRITE)
    @idempotent_write(workspace, _require_writes)
    def create_project(name: str, idempotency_key: OptionalIdempotencyKey = None) -> ProjectOutput:
        """Create a project. Requires local write access granted at startup."""
        try:
            _require_writes()
            return workspace().project(name)
        except Exception as error:
            return _error(error)


    @mcp.tool(annotations=WRITE)
    @idempotent_write(workspace, _require_writes)
    def create_blank_asset(project_id: str, name: str, width: int = 64, height: int = 64, idempotency_key: OptionalIdempotencyKey = None) -> AssetOutput:
        """Create a transparent one-layer asset in a project. Requires write access."""
        try:
            _require_writes()
            if not 1 <= width <= 512 or not 1 <= height <= 512:
                raise ValueError("画布尺寸必须在 1 到 512 之间")
            image = Image.new("RGBA", (width, height))
            document = Document(
                name=name.strip() or "未命名素材",
                layers=[Layer(id="base", name="图层 1")],
                frames=[Frame(id="frame_0", width=width, height=height, pixels={"base": encode_image(image)})],
                provenance={"kind": "created", "source": "mcp"},
            )
            return workspace().create_asset(project_id, document)
        except Exception as error:
            return _error(error)


    @mcp.tool(annotations=WRITE)
    @idempotent_write(workspace, _require_writes)
    def update_asset_document(
        asset_id: str,
        expected_current_version_id: str,
        document: DocumentInput,
        operation: str = "agent_edit",
        idempotency_key: OptionalIdempotencyKey = None,
    ) -> SaveOutput:
        """Save a complete edited document as a new immutable version.

        Call get_asset(include_document=true) first. The expected version is mandatory
        so an agent cannot silently overwrite a newer UI edit.
        """
        try:
            _require_writes()
            parsed = Document.model_validate(document)
            if not 1 <= len(operation) <= 80:
                raise ValueError("operation 必须为 1 到 80 个字符")
            workspace().save(asset_id, expected_current_version_id, parsed, operation=operation)
            return {"ok": True, "asset": workspace().asset(asset_id)}
        except Exception as error:
            return _error(error)


    @mcp.tool(annotations=WRITE)
    @idempotent_write(workspace, _require_writes)
    def rename_asset(asset_id: str, expected_current_version_id: str, name: str, idempotency_key: OptionalIdempotencyKey = None) -> AssetOutput:
        """Rename an asset with optimistic version checking. Requires write access."""
        try:
            _require_writes()
            return workspace().rename(asset_id, expected_current_version_id, name)
        except Exception as error:
            return _error(error)


    return mcp


def main() -> None:
    from .mcp_cli import main as cli_main
    cli_main(legacy_data_root=_data_root())


if __name__ == "__main__":
    main()
