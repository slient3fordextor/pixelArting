"""MCP adapter for PixelArting.

The adapter deliberately calls the same Store and quality code as the HTTP API.
It is read-only unless PIXELART_MCP_ALLOW_WRITE=1 is set in the MCP process
environment. This makes it safe to add to an agent before granting mutations.

Run locally with:

    python -m backend.mcp_server

For an HTTP MCP endpoint:

    PIXELART_MCP_TRANSPORT=streamable-http python -m backend.mcp_server
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import numpy as np
from mcp.server.fastmcp import FastMCP, Image as McpImage
from mcp.types import ToolAnnotations
from PIL import Image

from .images import composite, encode_image, png_bytes
from .models import CheckConfig, Document, Frame, Layer, RepairAction
from .quality import inspect
from .repairs import repair
from .store import Store


ROOT = Path(__file__).resolve().parents[1]


def _data_root() -> Path:
    return Path(os.environ.get("PIXELART_DATA_DIR", ROOT / "data")).expanduser().resolve()


def _writes_enabled() -> bool:
    return os.environ.get("PIXELART_MCP_ALLOW_WRITE", "").lower() in {"1", "true", "yes"}


def _require_writes() -> None:
    if not _writes_enabled():
        raise PermissionError(
            "MCP 写入已关闭。仅在信任该 agent 时设置 PIXELART_MCP_ALLOW_WRITE=1。"
        )


def _error(error: Exception) -> dict[str, Any]:
    """Return a stable, agent-readable error without leaking provider secrets."""
    return {"ok": False, "error": type(error).__name__, "message": str(error)}


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


store = Store(_data_root())
mcp = FastMCP(
    "pixelarting",
    instructions=(
        "PixelArting is a local pixel-art workspace. Inspect projects and assets before editing. "
        "Write tools require PIXELART_MCP_ALLOW_WRITE=1 and use optimistic version IDs; pass the "
        "latest currentVersionId returned by get_asset to avoid overwriting another edit. "
        "Use inspect_asset after edits to verify palette, dimensions, transparency, and animation rules."
    ),
    host=os.environ.get("PIXELART_MCP_HOST", "127.0.0.1"),
    port=int(os.environ.get("PIXELART_MCP_PORT", "8765")),
    streamable_http_path="/mcp",
    stateless_http=True,
)

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)


@mcp.tool(annotations=READ_ONLY)
def pixelart_health() -> dict[str, Any]:
    """Return server status and whether this MCP process can write."""
    return {
        "ok": True,
        "service": "PixelArting",
        "mode": "local-single-user",
        "dataRoot": str(store.root),
        "writeEnabled": _writes_enabled(),
    }


@mcp.tool(annotations=READ_ONLY)
def list_projects() -> list[dict[str, Any]]:
    """List all PixelArting projects."""
    return store.list_projects()


@mcp.tool(annotations=READ_ONLY)
def list_assets(project_id: str) -> list[dict[str, Any]]:
    """List assets in a project, including dimensions, frame count, and current version."""
    try:
        return store.list_assets(project_id)
    except Exception as error:
        return [_error(error)]


@mcp.tool(annotations=READ_ONLY)
def get_asset(asset_id: str, include_document: bool = False) -> dict[str, Any]:
    """Read an asset's metadata and version history; optionally include its complete document."""
    try:
        asset = store.asset(asset_id)
        if not include_document:
            asset.pop("document", None)
        return asset
    except Exception as error:
        return _error(error)


@mcp.tool(annotations=READ_ONLY)
def get_asset_version(asset_id: str, version_id: str) -> dict[str, Any]:
    """Read a specific immutable asset version, including layer and frame pixel PNG data."""
    try:
        return store.document(asset_id, version_id).model_dump()
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
        asset = store.asset(asset_id)
        version = version_id or asset["currentVersionId"]
        document = store.document(asset_id, version)
        frame = next((item for item in document.frames if item.id == frame_id), None) if frame_id else document.frames[0]
        if frame is None:
            raise KeyError("素材帧不存在")
        image = composite(document, frame)
        image.thumbnail((max_size, max_size), Image.Resampling.NEAREST)
        return McpImage(data=png_bytes(image), format="png")
    except Exception as error:
        return _error(error)


@mcp.tool(annotations=READ_ONLY)
def get_project_config(project_id: str) -> dict[str, Any]:
    """Read the quality-check and export configuration for a project."""
    try:
        return store.project_config(project_id).model_dump()
    except Exception as error:
        return _error(error)


@mcp.tool(annotations=READ_ONLY)
def list_reports(
    asset_id: str,
    version_id: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """List stored quality reports for an asset."""
    try:
        return store.list_reports(asset_id, version_id, limit, offset)
    except Exception as error:
        return [_error(error)]


@mcp.tool(annotations=READ_ONLY)
def inspect_asset(asset_id: str, version_id: str | None = None) -> dict[str, Any]:
    """Run PixelArting's quality rules without changing the asset or creating a report."""
    try:
        asset = store.asset(asset_id)
        version = version_id or asset["currentVersionId"]
        document = store.document(asset_id, version)
        report = inspect(document, store.asset_config(asset_id))
        return {"assetId": asset_id, "versionId": version, "report": report}
    except Exception as error:
        return _error(error)


@mcp.tool(annotations=WRITE)
def preview_asset_repair(
    asset_id: str,
    version_id: str,
    actions: list[dict[str, Any]],
) -> dict[str, Any]:
    """Preview one or more deterministic quality repairs without changing the current asset version."""
    try:
        _require_writes()
        if not 1 <= len(actions) <= 5:
            raise ValueError("actions 必须包含 1 到 5 个修复动作")
        parsed_actions = [RepairAction.model_validate(action) for action in actions]
        before = store.document(asset_id, version_id)
        config = store.asset_config(asset_id)
        after = repair(before, config, parsed_actions)
        preview_id = store.preview(
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
def commit_asset_repair(
    asset_id: str,
    preview_id: str,
    expected_current_version_id: str,
) -> dict[str, Any]:
    """Commit a repair preview after confirming the asset version has not changed."""
    try:
        _require_writes()
        version_id, config_data = store.commit(asset_id, preview_id, expected_current_version_id)
        document = store.document(asset_id, version_id)
        report = store.save_report(asset_id, version_id, inspect(document, CheckConfig.model_validate(config_data)))
        return {
            "ok": True,
            "asset": store.asset(asset_id),
            "report": report,
            "resultVersionId": version_id,
        }
    except Exception as error:
        return _error(error)


@mcp.tool(annotations=WRITE)
def restore_asset_version(
    asset_id: str,
    expected_current_version_id: str,
    version_id: str,
) -> dict[str, Any]:
    """Restore an immutable earlier version with optimistic version checking."""
    try:
        _require_writes()
        return store.restore(asset_id, expected_current_version_id, version_id)
    except Exception as error:
        return _error(error)


@mcp.tool(annotations=WRITE)
def update_project_config(project_id: str, config: dict[str, Any]) -> dict[str, Any]:
    """Replace a project's quality-check configuration. Requires write access."""
    try:
        _require_writes()
        return store.save_project_config(project_id, CheckConfig.model_validate(config)).model_dump()
    except Exception as error:
        return _error(error)


@mcp.tool(annotations=WRITE)
def create_project(name: str) -> dict[str, Any]:
    """Create a project. Requires PIXELART_MCP_ALLOW_WRITE=1."""
    try:
        _require_writes()
        return store.project(name)
    except Exception as error:
        return _error(error)


@mcp.tool(annotations=WRITE)
def create_blank_asset(project_id: str, name: str, width: int = 64, height: int = 64) -> dict[str, Any]:
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
        return store.create_asset(project_id, document)
    except Exception as error:
        return _error(error)


@mcp.tool(annotations=WRITE)
def update_asset_document(
    asset_id: str,
    expected_current_version_id: str,
    document: dict[str, Any],
    operation: str = "agent_edit",
) -> dict[str, Any]:
    """Save a complete edited document as a new immutable version.

    Call get_asset(include_document=true) first. The expected version is mandatory
    so an agent cannot silently overwrite a newer UI edit.
    """
    try:
        _require_writes()
        parsed = Document.model_validate(document)
        if not 1 <= len(operation) <= 80:
            raise ValueError("operation 必须为 1 到 80 个字符")
        store.save(asset_id, expected_current_version_id, parsed, operation=operation)
        return {"ok": True, "asset": store.asset(asset_id)}
    except Exception as error:
        return _error(error)


@mcp.tool(annotations=WRITE)
def rename_asset(asset_id: str, expected_current_version_id: str, name: str) -> dict[str, Any]:
    """Rename an asset with optimistic version checking. Requires write access."""
    try:
        _require_writes()
        return store.rename(asset_id, expected_current_version_id, name)
    except Exception as error:
        return _error(error)


def main() -> None:
    transport = os.environ.get("PIXELART_MCP_TRANSPORT", "stdio").lower()
    if transport not in {"stdio", "sse", "streamable-http"}:
        raise SystemExit("PIXELART_MCP_TRANSPORT 必须是 stdio、sse 或 streamable-http")
    mcp.run(transport=transport)  # type: ignore[arg-type]


if __name__ == "__main__":
    main()
