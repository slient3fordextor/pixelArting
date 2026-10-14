import hashlib
import io
import json
import re
import stat
import struct
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
_ZIP_CHUNK_BYTES = 64 * 1024
_LOCAL_HEADER = struct.Struct("<4s5H3I2H")


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


def _member_content(data: memoryview, entry: zipfile.ZipInfo, end_offset: int, remaining: int) -> bytes:
    offset = entry.header_offset
    if offset < 0 or offset + _LOCAL_HEADER.size > end_offset:
        raise ValueError("ZIP 成员头无效或重叠")
    signature, version, flags, compression, _, _, crc, compressed, expanded, name_size, extra_size = _LOCAL_HEADER.unpack_from(data, offset)
    if signature != b"PK\x03\x04" or flags != entry.flag_bits or compression != entry.compress_type:
        raise ValueError("ZIP 成员头与目录记录不一致")
    if version > 20 or compressed == 0xFFFFFFFF or expanded == 0xFFFFFFFF:
        raise ValueError("ZIP64 成员不受支持，请使用普通 ZIP")
    if flags & (1 | 0x20 | 0x40):
        raise ValueError("ZIP 不接受加密或补丁文件")
    start = offset + _LOCAL_HEADER.size + name_size + extra_size
    end = start + entry.compress_size
    if start > end_offset or end > end_offset:
        raise ValueError("ZIP 成员数据无效或重叠")
    filename = bytes(data[offset + _LOCAL_HEADER.size:offset + _LOCAL_HEADER.size + name_size]).decode("utf-8" if flags & 0x800 else "cp437")
    if filename != entry.orig_filename:
        raise ValueError("ZIP 成员名称与目录记录不一致")
    expected = (entry.CRC, entry.compress_size, entry.file_size)
    descriptor_size = 0
    if flags & 8:
        if any(local not in (0, actual) for local, actual in zip((crc, compressed, expanded), expected)):
            raise ValueError("ZIP 成员头与目录记录不一致")
        # Streaming writers put the final sizes after the compressed stream.
        descriptor = bytes(data[end:min(end + 16, end_offset)])
        candidates = [struct.unpack_from("<3I", descriptor)] if len(descriptor) >= 12 else []
        if len(descriptor) >= 16 and descriptor[:4] == b"PK\x07\x08":
            candidates.append(struct.unpack_from("<3I", descriptor, 4))
        if expected not in candidates:
            raise ValueError("ZIP 数据描述符与目录记录不一致")
        descriptor_size = 16 if descriptor[:4] == b"PK\x07\x08" else 12
    elif (crc, compressed, expanded) != expected:
        raise ValueError("ZIP 成员头与目录记录不一致")
    if end + descriptor_size != end_offset:
        raise ValueError("ZIP 成员数据与下一个成员不连续")

    limit = min(entry.file_size, MAX_MEMBER_BYTES, remaining)
    if compression == zipfile.ZIP_STORED:
        if entry.compress_size != entry.file_size or entry.file_size > limit:
            raise ValueError("ZIP 文件大小与目录记录不一致")
        content = bytes(data[start:end])
        actual_crc = zlib.crc32(content)
    else:
        decoder = zlib.decompressobj(-zlib.MAX_WBITS)
        content = bytearray()
        actual_crc = 0
        position, pending = start, b""
        # ZipExtFile trusts file_size and silently truncates excess output. Read
        # the raw stream instead, limiting each call to the remaining budget.
        while position < end or pending:
            if not pending:
                next_position = min(position + _ZIP_CHUNK_BYTES, end)
                pending = data[position:next_position]
                position = next_position
            chunk = decoder.decompress(pending, min(_ZIP_CHUNK_BYTES, limit - len(content) + 1))
            content.extend(chunk)
            if len(content) > limit:
                raise ValueError("ZIP 真实解压大小超过声明或安全上限")
            actual_crc = zlib.crc32(chunk, actual_crc)
            pending = decoder.unconsumed_tail
            if decoder.eof:
                if decoder.unused_data or pending or position != end:
                    raise ValueError("ZIP 压缩流包含多余数据")
                break
        if not decoder.eof:
            raise ValueError("ZIP 压缩流未完整结束")
        if len(content) != entry.file_size:
            raise ValueError("ZIP 文件大小与目录记录不一致")
        content = bytes(content)
    if actual_crc != entry.CRC:
        raise ValueError("ZIP 文件 CRC 校验失败")
    return content


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
            offsets = sorted(entry.header_offset for entry in entries)
            if len(set(offsets)) != len(offsets) or any(offset < 0 or offset >= archive.start_dir for offset in offsets):
                raise ValueError("ZIP 成员头无效或重叠")
            ends = dict(zip(offsets, offsets[1:] + [archive.start_dir]))
            total, names = 0, set()
            raw = memoryview(data)
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
                if entry.file_size > MAX_MEMBER_BYTES or entry.file_size > MAX_EXPANDED_BYTES - total:
                    raise ValueError("ZIP 解压数据超过安全上限")
                if entry.is_dir():
                    if entry.file_size:
                        raise ValueError("ZIP 目录不能包含文件数据")
                content = _member_content(raw, entry, ends[entry.header_offset], MAX_EXPANDED_BYTES - total)
                total += len(content)
                if not entry.is_dir():
                    files[name] = content
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError, EOFError, UnicodeError, struct.error, zlib.error) as error:
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
