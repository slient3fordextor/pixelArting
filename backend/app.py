import hashlib
import os
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

from .exports import export_bundle
from .images import MAX_UPLOAD_BYTES, composite, decode_png, encode_image, png_bytes
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

    @app.post("/api/projects/{project_id}/assets", status_code=201)
    async def upload(project_id: str, file: UploadFile = File(...), name: str = Form(""), cellWidth: int = Form(0), cellHeight: int = Form(0)):
        data = await file.read(MAX_UPLOAD_BYTES + 1)
        image = decode_png(data, max_side=2048)
        if cellWidth or cellHeight:
            if not (1 <= cellWidth <= 512 and 1 <= cellHeight <= 512) or image.width % cellWidth or image.height % cellHeight:
                raise ValueError("Sprite Sheet 必须可被单帧宽高完整切分")
            count = image.width // cellWidth * (image.height // cellHeight)
            if count > 64:
                raise ValueError("首版单个素材最多 64 帧")
            parts = [image.crop((x, y, x + cellWidth, y + cellHeight)) for y in range(0, image.height, cellHeight) for x in range(0, image.width, cellWidth)]
        else:
            if image.width > 512 or image.height > 512:
                raise ValueError("单图最大 512×512；更大的 Sheet 请明确单帧尺寸")
            parts = [image]
        source_id = hashlib.sha256(data).hexdigest()
        source_dir = store.root / "sources"
        source_dir.mkdir(exist_ok=True)
        source = source_dir / f"{source_id}.png"
        if not source.exists():
            source.write_bytes(data)
        document = Document(name=name.strip() or Path(file.filename or "素材.png").stem[:100] or "素材", layers=[Layer(id="base", name="原始图层")], frames=[Frame(id=f"frame_{i}", width=part.width, height=part.height, pixels={"base": encode_image(part)}) for i, part in enumerate(parts)], provenance={"kind": "upload", "originalRef": f"sources/{source_id}.png", "originalChecksum": source_id, "licenseStatus": "unknown"})
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
        return store.save_report(asset_id, body.versionId, inspect(document, body.config))

    @app.post("/api/assets/{asset_id}/preview")
    def preview(asset_id: str, body: PreviewRequest):
        document = store.document(asset_id, body.versionId)
        result = repair(document, body.config, body.actions)
        preview_id = store.preview(asset_id, body.versionId, result, [a.model_dump() for a in body.actions], body.config.model_dump())
        changes = []
        for old, new in zip(document.frames, result.frames):
            before, after = np.array(composite(document, old)), np.array(composite(result, new))
            changed = int(np.any(before != after, axis=2).sum()) if before.shape == after.shape else None
            changes.append({"frameId": old.id, "changedPixels": changed, "before": [old.width, old.height], "after": [new.width, new.height]})
        return {"previewId": preview_id, "document": result, "changes": changes, "report": inspect(result, body.config)}

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
