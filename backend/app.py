import os
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

from .exports import export_bundle
from .images import MAX_UPLOAD_BYTES, composite, encode_image, png_bytes
from .imports import SheetLayout, imported_document, preview_import, retain_png
from .models import BlankAssetCreate, CheckConfig, CheckRequest, CommitRequest, CopyAssetRequest, DeleteAssetRequest, Document, Frame, Layer, PreviewRequest, ProjectCreate, RenameAssetRequest, RestoreRequest, SaveRequest
from .quality import inspect
from .repairs import repair
from .sample import sample_document
from .store import Conflict, Store, uid

ROOT = Path(__file__).resolve().parents[1]


def create_app(data_root: Path | None = None):
    store = Store(data_root or Path(os.environ.get("PIXELART_DATA_DIR", ROOT / "data")))
    app = FastAPI(title="PixelArting", version="0.1.0")
    app.state.store = store

    @app.middleware("http")
    async def limit_request(request: Request, call_next):
        origin = request.headers.get("origin")
        ports = {5173, 5174, 8000, 8001, 8080}
        desktop_port = os.environ.get("PIXELART_DESKTOP_PORT", "")
        if desktop_port.isdigit() and 1 <= int(desktop_port) <= 65535:
            ports.add(int(desktop_port))
        allowed = {f"http://localhost:{p}" for p in ports} | {f"http://127.0.0.1:{p}" for p in ports}
        if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin not in allowed:
            return JSONResponse({"detail": "本地单用户模式不接受外部站点写入"}, status_code=403)
        if request.method in ("POST", "PUT", "PATCH"):
            body = await request.body()
            if len(body) > 20 * 1024 * 1024:
                return JSONResponse({"detail": "请求不能超过 20 MB"}, status_code=413)
        return await call_next(request)

    @app.exception_handler(ValueError)
    async def value_error(request, error):
        return JSONResponse({"detail": str(error)}, status_code=422)

    @app.exception_handler(KeyError)
    async def missing(request, error):
        return JSONResponse({"detail": str(error).strip("'")}, status_code=404)

    @app.exception_handler(Conflict)
    async def conflict(request, error):
        return JSONResponse({"detail": str(error)}, status_code=409)

    @app.get("/api/health")
    def health():
        return {"status": "ok", "mode": "local-single-user", "targetSize": [64, 64], "godotVersion": "4.7.2", "schemaVersion": "1.1"}

    @app.get("/api/projects")
    def projects():
        return store.list_projects()

    @app.post("/api/projects", status_code=201)
    def project(body: ProjectCreate):
        return store.project(body.name)

    @app.get("/api/projects/{project_id}/check-config")
    def project_config(project_id: str):
        return store.project_config(project_id)

    @app.put("/api/projects/{project_id}/check-config")
    def save_project_config(project_id: str, body: CheckConfig):
        return store.save_project_config(project_id, body)

    @app.post("/api/demo")
    def demo():
        projects = store.list_projects()
        if not projects:
            project = store.project("示例项目")
            store.create_asset(project["id"], sample_document())
            return project
        return projects[0]

    @app.get("/api/projects/{project_id}/assets")
    def assets(project_id: str):
        return store.list_assets(project_id)

    @app.post("/api/projects/{project_id}/assets/blank", status_code=201)
    def blank_asset(project_id: str, body: BlankAssetCreate):
        image = Image.new("RGBA", (body.width, body.height))
        document = Document(
            name=body.name.strip() or "未命名素材",
            layers=[Layer(id="base", name="图层 1")],
            frames=[Frame(id="frame_0", width=body.width, height=body.height, pixels={"base": encode_image(image)})],
            provenance={"kind": "created"},
        )
        return store.create_asset(project_id, document)

    @app.post("/api/projects/{project_id}/assets/copy", status_code=201)
    def copy_asset(project_id: str, body: CopyAssetRequest):
        source = None
        source_version = body.versionId
        if body.document is not None:
            source = body.document
        else:
            source_asset = store.asset(body.sourceAssetId)
            source_version = body.versionId or source_asset["currentVersionId"]
            source = store.document(body.sourceAssetId, source_version)
        return store.copy_asset(project_id, source, body.sourceAssetId, source_version)

    async def read_import_source(project_id: str, file: UploadFile):
        with store.connection() as connection:
            if not connection.execute("SELECT id FROM projects WHERE id=?", (project_id,)).fetchone():
                raise KeyError("项目不存在")
        return retain_png(store.root, await file.read(MAX_UPLOAD_BYTES + 1))

    @app.post("/api/projects/{project_id}/imports/preview")
    async def import_preview(project_id: str, file: UploadFile = File(...), cellWidth: int = Form(0), cellHeight: int = Form(0), marginX: int = Form(0), marginY: int = Form(0), spacingX: int = Form(0), spacingY: int = Form(0), rows: int = Form(0), columns: int = Form(0)):
        """预览行优先切分，不创建素材。marginX/Y 是左右/上下的对称边距，
        spacingX/Y 是单帧间距，rows/columns 为 0 时自动推算；布局必须精确覆盖 PNG。
        校验通过的原始 PNG 会保留到 sources/<sha256>.png，即使随后布局检查失败。
        """
        image, digest = await read_import_source(project_id, file)
        layout = SheetLayout(cellWidth=cellWidth, cellHeight=cellHeight, marginX=marginX, marginY=marginY, spacingX=spacingX, spacingY=spacingY, rows=rows, columns=columns)
        return preview_import(image, layout, digest)

    @app.post("/api/projects/{project_id}/assets", status_code=201)
    async def upload(project_id: str, file: UploadFile = File(...), name: str = Form(""), cellWidth: int = Form(0), cellHeight: int = Form(0), marginX: int = Form(0), marginY: int = Form(0), spacingX: int = Form(0), spacingY: int = Form(0), rows: int = Form(0), columns: int = Form(0), mapping: str = Form("[]"), mappingConfirmed: bool = Form(False)):
        """确认导入。布局参数与 imports/preview 相同。mapping 是 JSON 数组，
        每项包含从 0 开始的 frameIndex、action(idle/walk)、direction(down/left/right/up)，
        以及可选 durationMs(默认 200)。非空映射必须传 mappingConfirmed=true，
        同一动作方向按原 PNG 行优先帧序组成动画；未映射帧仍保留。
        """
        image, digest = await read_import_source(project_id, file)
        layout = SheetLayout(cellWidth=cellWidth, cellHeight=cellHeight, marginX=marginX, marginY=marginY, spacingX=spacingX, spacingY=spacingY, rows=rows, columns=columns)
        document = imported_document(image, layout, digest, file.filename, name, mapping, mappingConfirmed)
        return store.create_asset(project_id, document)

    @app.get("/api/assets/{asset_id}")
    def asset(asset_id: str):
        return store.asset(asset_id)

    @app.delete("/api/assets/{asset_id}")
    def delete_asset(asset_id: str, body: DeleteAssetRequest):
        store.delete_asset(asset_id, body.expectedCurrentVersionId)
        return {"deleted": True, "assetId": asset_id}

    @app.post("/api/assets/{asset_id}/rename")
    def rename_asset(asset_id: str, body: RenameAssetRequest):
        return store.rename(asset_id, body.expectedCurrentVersionId, body.name)

    @app.get("/api/assets/{asset_id}/thumbnail")
    def thumbnail(asset_id: str, versionId: str):
        document = store.document(asset_id, versionId)
        image = composite(document, document.frames[0])
        image.thumbnail((96, 96), Image.Resampling.NEAREST)
        return Response(png_bytes(image), media_type="image/png", headers={"Cache-Control": "private, max-age=31536000, immutable"})

    @app.get("/api/assets/{asset_id}/versions/{version_id}")
    def version(asset_id: str, version_id: str):
        return store.document(asset_id, version_id)

    @app.post("/api/assets/{asset_id}/save")
    def save(asset_id: str, body: SaveRequest):
        store.save(asset_id, body.expectedCurrentVersionId, body.document)
        return store.asset(asset_id)

    @app.post("/api/assets/{asset_id}/restore")
    def restore(asset_id: str, body: RestoreRequest):
        return store.restore(asset_id, body.expectedCurrentVersionId, body.versionId)

    @app.post("/api/assets/{asset_id}/check")
    def check(asset_id: str, body: CheckRequest):
        document = store.document(asset_id, body.versionId)
        config = body.config or store.asset_config(asset_id)
        return store.save_report(asset_id, body.versionId, inspect(document, config))

    @app.get("/api/assets/{asset_id}/reports")
    def reports(asset_id: str, versionId: str | None = None, limit: int = Query(default=50, ge=1, le=100), offset: int = Query(default=0, ge=0)):
        return store.list_reports(asset_id, versionId, limit, offset)

    @app.post("/api/assets/{asset_id}/preview")
    def preview(asset_id: str, body: PreviewRequest):
        document = store.document(asset_id, body.versionId)
        config = body.config or store.asset_config(asset_id)
        result = repair(document, config, body.actions)
        preview_id = store.preview(asset_id, body.versionId, result, [a.model_dump() for a in body.actions], config.model_dump())
        changes = []
        for old, new in zip(document.frames, result.frames):
            before, after = np.array(composite(document, old)), np.array(composite(result, new))
            height, width = max(old.height, new.height), max(old.width, new.width)
            old_pixels = np.zeros((height, width, 4), dtype=np.uint8)
            new_pixels = np.zeros_like(old_pixels)
            old_pixels[:old.height, :old.width] = before
            new_pixels[:new.height, :new.width] = after
            mask = np.any(old_pixels != new_pixels, axis=2)
            ys, xs = np.nonzero(mask)
            bounds = {"x": int(xs.min()), "y": int(ys.min()), "width": int(xs.max() - xs.min() + 1), "height": int(ys.max() - ys.min() + 1)} if len(xs) else None
            metadata_before = {"origin": old.origin.model_dump() if old.origin else None, "baselineY": old.baselineY, "collisionRects": [rect.model_dump() for rect in old.collisionRects]}
            metadata_after = {"origin": new.origin.model_dump() if new.origin else None, "baselineY": new.baselineY, "collisionRects": [rect.model_dump() for rect in new.collisionRects]}
            changes.append({
                "frameId": old.id, "changedPixels": int(mask.sum()), "before": [old.width, old.height], "after": [new.width, new.height],
                "changedBounds": bounds, "metadataBefore": metadata_before, "metadataAfter": metadata_after,
                "metadataChanged": metadata_before != metadata_after,
            })
        return {"previewId": preview_id, "baseVersionId": body.versionId, "actions": [action.model_dump() for action in body.actions], "document": result, "changes": changes, "report": inspect(result, config)}

    @app.post("/api/assets/{asset_id}/commit")
    def commit(asset_id: str, body: CommitRequest):
        version_id, config = store.commit(asset_id, body.previewId, body.expectedCurrentVersionId)
        document = store.document(asset_id, version_id)
        report = store.save_report(asset_id, version_id, inspect(document, CheckConfig.model_validate(config)))
        return {"asset": store.asset(asset_id), "report": report, "resultVersionId": version_id}

    @app.get("/api/assets/{asset_id}/export")
    def export(asset_id: str, versionId: str, target: str = "png", frameId: str | None = None):
        if target not in ("png", "json", "godot"):
            raise HTTPException(422, "不支持的导出目标")
        document = store.document(asset_id, versionId)
        if target == "png":
            frame = next((frame for frame in document.frames if frame.id == frameId), None) if frameId else document.frames[0]
            if not frame:
                raise KeyError("帧不存在")
            return Response(png_bytes(composite(document, frame)), media_type="image/png", headers={"Content-Disposition": 'attachment; filename="pixelart.png"'})
        return Response(export_bundle(document, asset_id, versionId, target), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="pixelart-{target}.zip"'})

    dist = ROOT / "frontend" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    return app


app = create_app()
