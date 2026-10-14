import hashlib
import io
import json
import re
import stat
import zipfile
import zlib
from typing import Literal

from pydantic import Field

from .exports import export_bundle
from .images import checksum, decode_png, encode_image
from .models import CheckConfig, Document, Model, ProjectCreate

MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_EXPANDED_BYTES = 160 * 1024 * 1024
MAX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_METADATA_BYTES = 4 * 1024 * 1024
MAX_ARCHIVE_FILES = 4096
MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024
MAX_PROJECT_ASSETS = 64
MAX_PROJECT_PIXELS = 67_108_864


class BackupAsset(Model):
    path: str = Field(max_length=240)
    sourceAssetId: str
    sourceVersionId: str


class ProjectArchive(Model):
    format: Literal["pixelart-project"]
    formatVersion: Literal[1]
    scope: Literal["current-versions"]
    project: ProjectCreate
    config: CheckConfig
    assets: list[BackupAsset] = Field(max_length=MAX_PROJECT_ASSETS)


def _safe_path(name: str) -> str:
    if not isinstance(name, str) or not name or len(name) > 240 or "\\" in name or ":" in name or "\0" in name:
        raise ValueError("ZIP 包含不安全的路径")
    if any(part in ("", ".", "..") for part in name.split("/")):
        raise ValueError("ZIP 包含不安全的路径")
    return name


def _read_archive(data: bytes) -> dict[str, bytes]:
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError("ZIP 文件不能超过 128 MB")
    files = {}
    try:
        # Inspect the end record before ZipFile allocates its entry objects.
        end_record = zipfile._EndRecData(io.BytesIO(data))
        if end_record is None:
            raise ValueError("无法读取 ZIP 文件")
        if end_record[zipfile._ECD_ENTRIES_TOTAL] > MAX_ARCHIVE_FILES or end_record[zipfile._ECD_SIZE] > MAX_CENTRAL_DIRECTORY_BYTES:
            raise ValueError("ZIP 文件数量或目录数据超过安全上限")
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ARCHIVE_FILES:
                raise ValueError("ZIP 文件数量超过上限")
            total, names = 0, set()
            for entry in entries:
                name = _safe_path(entry.orig_filename[:-1] if entry.is_dir() else entry.orig_filename)
                if name in names:
                    raise ValueError("ZIP 包含重复路径")
                names.add(name)
                mode = stat.S_IFMT(entry.external_attr >> 16)
                if mode not in (0, stat.S_IFREG, stat.S_IFDIR) or entry.flag_bits & 1:
                    raise ValueError("ZIP 不接受链接、特殊文件或加密文件")
                if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise ValueError("ZIP 压缩方式不受支持")
                total += entry.file_size
                if entry.file_size > MAX_MEMBER_BYTES or total > MAX_EXPANDED_BYTES:
                    raise ValueError("ZIP 解压数据超过安全上限")
                if entry.is_dir():
                    if entry.file_size:
                        raise ValueError("ZIP 目录不能包含文件数据")
                    continue
                with archive.open(entry) as member:
                    content = member.read(MAX_MEMBER_BYTES + 1)
                if len(content) != entry.file_size or len(content) > MAX_MEMBER_BYTES:
                    raise ValueError("ZIP 文件大小与目录记录不一致")
                files[name] = content
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError, EOFError, zlib.error) as error:
        raise ValueError("无法读取 ZIP 文件") from error
    return files


def _json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("JSON 包含重复字段")
        value[key] = item
    return value


def _metadata(files: dict[str, bytes], name: str) -> dict:
    if name not in files or len(files[name]) > MAX_METADATA_BYTES:
        raise ValueError("ZIP 缺少元数据或元数据超过上限")
    try:
        value = json.loads(files[name], object_pairs_hook=_json_object)
    except (UnicodeError, RecursionError) as error:
        raise ValueError("ZIP 元数据 JSON 无效") from error
    if not isinstance(value, dict):
        raise ValueError("ZIP 元数据必须是 JSON 对象")
    return value


def _verify_manifest(files: dict[str, bytes], prefix: str = "") -> dict:
    manifest = _metadata(files, prefix + "manifest.json")
    hashes = manifest.get("files")
    if manifest.get("schemaVersion") != "1.1" or not isinstance(hashes, dict):
        raise ValueError("ZIP 校验清单版本或格式无效")
    expected = {name[len(prefix):] for name in files if name.startswith(prefix) and name != prefix + "manifest.json"}
    if set(hashes) != expected:
        raise ValueError("ZIP 文件与校验清单不一致")
    for name, digest in hashes.items():
        _safe_path(name)
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("ZIP 文件校验值无效")
        if hashlib.sha256(files[prefix + name]).hexdigest() != digest:
            raise ValueError("ZIP 文件校验失败")
    return manifest


def _document(files: dict[str, bytes], prefix: str, pixel_budget: int = MAX_PROJECT_PIXELS) -> Document:
    manifest = _verify_manifest(files, prefix)
    metadata = _metadata(files, prefix + "asset.json")
    digest = metadata.get("checksum")
    source_asset = metadata.get("assetId")
    source_version = metadata.get("assetVersionId")
    if any(not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", value) for value in (source_asset, source_version)):
        raise ValueError("素材来源 ID 无效")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("素材校验值无效")
    if manifest.get("assetVersionId") != source_version:
        raise ValueError("素材版本与校验清单不一致")
    content = {key: value for key, value in metadata.items() if key not in {
        "assetId", "assetVersionId", "checksum", "targetEngine", "targetEngineVersion", "spriteSheet", "ignoredBySpriteFrames",
    }}
    frames = content.get("frames")
    if not isinstance(frames, list) or len(frames) > 64 or any(not isinstance(frame, dict) for frame in frames):
        raise ValueError("素材帧数据无效")
    for frame in frames:
        image_ref = frame.pop("imageRef", None)
        if not isinstance(image_ref, str) or prefix + _safe_path(image_ref) not in files:
            raise ValueError("素材缺少帧合成图像")
    document = Document.model_validate(content)
    if sum(frame.width * frame.height for frame in document.frames) * len(document.layers) > pixel_budget:
        raise ValueError("项目备份总像素数超过上限")
    for frame in document.frames:
        for layer_id, reference in frame.pixels.items():
            path = prefix + _safe_path(reference)
            if path not in files:
                raise ValueError("素材引用的图层图像不存在")
            image = decode_png(files[path])
            if image.size != (frame.width, frame.height):
                raise ValueError("图层尺寸必须与所在帧一致")
            frame.pixels[layer_id] = encode_image(image)
    if checksum(document) != digest:
        raise ValueError("素材内容校验失败")
    document.provenance = {**document.provenance, "importedFrom": {
        "assetId": source_asset, "versionId": source_version, "checksum": digest,
    }}
    return document


def import_bundle(data: bytes) -> Document:
    files = _read_archive(data)
    candidates = [name for name in files if name == "asset.json" or name.endswith("/asset.json")]
    if len(candidates) != 1:
        raise ValueError("分层包必须包含一个素材")
    prefix = candidates[0][:-len("asset.json")]
    if any(not name.startswith(prefix) for name in files):
        raise ValueError("分层包包含素材目录之外的文件")
    return _document(files, prefix)


def _archive(files: dict[str, bytes]) -> bytes:
    if len(files) + 1 > MAX_ARCHIVE_FILES or sum(map(len, files.values())) > MAX_EXPANDED_BYTES:
        raise ValueError("项目备份超过文件数量或数据大小上限")
    files["manifest.json"] = json.dumps({
        "schemaVersion": "1.1", "files": {name: hashlib.sha256(value).hexdigest() for name, value in files.items()},
    }, ensure_ascii=False).encode()
    if sum(map(len, files.values())) > MAX_EXPANDED_BYTES:
        raise ValueError("项目备份超过数据大小上限")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    result = buffer.getvalue()
    if len(result) > MAX_ARCHIVE_BYTES:
        raise ValueError("项目备份超过 128 MB，请拆分项目后备份")
    return result


def export_project(snapshot: dict) -> bytes:
    if len(snapshot["assets"]) > MAX_PROJECT_ASSETS:
        raise ValueError("项目备份最多支持 64 个素材")
    if sum(sum(frame.width * frame.height for frame in asset["document"].frames) * len(asset["document"].layers) for asset in snapshot["assets"]) > MAX_PROJECT_PIXELS:
        raise ValueError("项目备份总像素数超过上限")
    files, assets = {}, []
    for asset in snapshot["assets"]:
        prefix = f'assets/{asset["id"]}/'
        package = export_bundle(asset["document"], asset["id"], asset["currentVersionId"], "json")
        for name, content in _read_archive(package).items():
            if name in ("asset.json", "manifest.json") and len(content) > MAX_METADATA_BYTES:
                raise ValueError("项目素材元数据超过备份上限")
            files[prefix + name] = content
        assets.append({"path": prefix + "asset.json", "sourceAssetId": asset["id"], "sourceVersionId": asset["currentVersionId"]})
        if len(files) >= MAX_ARCHIVE_FILES or sum(map(len, files.values())) > MAX_EXPANDED_BYTES:
            raise ValueError("项目备份超过文件数量或数据大小上限")
    metadata = ProjectArchive(format="pixelart-project", formatVersion=1, scope="current-versions", project=ProjectCreate(name=snapshot["name"]), config=snapshot["config"], assets=assets)
    files["project.json"] = metadata.model_dump_json().encode()
    return _archive(files)


def import_project(data: bytes) -> tuple[str, CheckConfig, list[Document]]:
    files = _read_archive(data)
    _verify_manifest(files)
    metadata = ProjectArchive.model_validate(_metadata(files, "project.json"))
    prefixes = []
    for asset in metadata.assets:
        if not re.fullmatch(r"assets/[a-zA-Z0-9_-]{1,80}/asset\.json", asset.path):
            raise ValueError("项目备份素材路径无效")
        prefixes.append(asset.path[:-len("asset.json")])
    if len(set(prefixes)) != len(prefixes):
        raise ValueError("项目备份包含重复素材")
    if any(name not in ("project.json", "manifest.json") and not any(name.startswith(prefix) for prefix in prefixes) for name in files):
        raise ValueError("项目备份包含未登记的文件")
    documents, remaining = [], MAX_PROJECT_PIXELS
    for prefix in prefixes:
        document = _document(files, prefix, remaining)
        documents.append(document)
        remaining -= sum(frame.width * frame.height for frame in document.frames) * len(document.layers)
    for asset, document in zip(metadata.assets, documents):
        source = document.provenance["importedFrom"]
        if source["assetId"] != asset.sourceAssetId or source["versionId"] != asset.sourceVersionId:
            raise ValueError("项目备份素材来源与索引不一致")
    return metadata.project.name, metadata.config, documents
