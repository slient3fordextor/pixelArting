import hashlib
import io
import json
import re
import zipfile

from PIL import Image, PngImagePlugin
from pydantic import ValidationError

from .images import checksum, composite, decode_image, png_bytes, validate_images
from .models import Document

EXPORT_TARGETS = ("png", "frames", "sheet", "json", "godot")


def validate_export_document(document: Document, target: str) -> Document:
    if target not in EXPORT_TARGETS:
        raise ValueError("不支持的导出目标")
    try:
        validate_images(document)
        document = Document.model_validate(document.model_dump())
    except ValidationError as error:
        detail = error.errors(include_input=False)[0]
        location = ".".join(map(str, detail["loc"]))
        raise ValueError(f'导出预检失败：{location} {detail["msg"]}') from error
    except ValueError as error:
        raise ValueError(f"导出预检失败：{error}") from error
    if target == "godot" and not document.animations:
        raise ValueError("Godot 导出需要动作/方向映射；请先在时间轴中分配动画")
    if target == "sheet" and len({(frame.width, frame.height) for frame in document.frames}) != 1:
        raise ValueError("Sprite Sheet 导出要求所有帧尺寸一致，请先调整画布尺寸")
    return document


def _validate_png(data: bytes, size: tuple[int, int], path: str):
    try:
        # Generated sheets may exceed the upload pixel limit; verify the bounded
        # expected dimensions before asking the PNG decoder to allocate pixels.
        with PngImagePlugin.PngImageFile(io.BytesIO(data)) as image:
            if image.size != size:
                raise ValueError(f"{path} 尺寸为 {image.width}x{image.height}，应为 {size[0]}x{size[1]}")
            image.verify()
        with PngImagePlugin.PngImageFile(io.BytesIO(data)) as image:
            image.load()
    except (OSError, SyntaxError, EOFError) as error:
        raise ValueError(f"{path} 不是有效 PNG") from error


def _load_generated_png(data: bytes, size: tuple[int, int], path: str) -> Image.Image:
    _validate_png(data, size, path)
    try:
        with Image.open(io.BytesIO(data)) as image:
            return image.convert("RGBA").copy()
    except (OSError, SyntaxError, EOFError) as error:
        raise ValueError(f"{path} 不是有效 PNG") from error


def export_png(document: Document, frame_id: str | None = None) -> bytes:
    document = validate_export_document(document, "png")
    frame = next((frame for frame in document.frames if frame.id == frame_id), None) if frame_id else document.frames[0]
    if frame is None:
        raise KeyError("帧不存在")
    data = png_bytes(composite(document, frame))
    _validate_png(data, (frame.width, frame.height), f"frames/{frame.id}.png")
    return data


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"JSON 包含重复字段 {key}")
        result[key] = value
    return result


def _read_json(files: dict[str, bytes], path: str) -> dict:
    if path not in files:
        raise ValueError(f"缺少文件 {path}")
    try:
        result = json.loads(files[path], object_pairs_hook=_json_object)
    except (ValueError, UnicodeError) as error:
        raise ValueError(f"{path} JSON 无效：{error}") from error
    if not isinstance(result, dict):
        raise ValueError(f"{path} 必须是 JSON 对象")
    return result


def _validate_spriteframes(files: dict[str, bytes], document: Document, asset_id: str):
    if "spriteframes.tres" not in files:
        raise ValueError("缺少 spriteframes.tres")
    text = files["spriteframes.tres"].decode("utf-8")
    header = f'[gd_resource type="SpriteFrames" load_steps={len(document.frames) + 1} format=3]'
    if not text.startswith(header + "\n"):
        raise ValueError("Godot SpriteFrames 资源头无效")
    resources = re.findall(r'^\[ext_resource type="Texture2D" path=("[^"\n]+") id=("[1-9]\d*")\]$', text, re.MULTILINE)
    expected_paths = {str(index): f"res://pixelart_{asset_id}/frames/{frame.id}.png" for index, frame in enumerate(document.frames, 1)}
    if len(resources) != len(expected_paths) or text.count("[ext_resource ") != len(resources):
        raise ValueError("Godot 纹理资源数量无效")
    paths = {json.loads(resource_id): json.loads(path) for path, resource_id in resources}
    if paths != expected_paths or any(path.removeprefix(f"res://pixelart_{asset_id}/") not in files for path in paths.values()):
        raise ValueError("Godot 纹理资源路径或引用无效")
    match = re.search(r"^animations = (.+)\Z", text, re.MULTILINE | re.DOTALL)
    if not match:
        raise ValueError("Godot 缺少动画数据")
    # Normalize the two Godot tokens this exporter emits, then parse the JSON values.
    encoded = re.sub(r'ExtResource\("([1-9]\d*)"\)', lambda token: json.dumps({"resourceId": token.group(1)}), match[1])
    encoded = re.sub(r'&(?=")', "", encoded)
    try:
        animations = json.loads(encoded, object_pairs_hook=_json_object)
    except ValueError as error:
        raise ValueError("Godot 动画数据无效") from error
    indices = {frame.id: str(index) for index, frame in enumerate(document.frames, 1)}
    expected = [{
        "name": f"{animation.action}_{animation.direction}", "loop": animation.loop, "speed": 1.0,
        "frames": [{"duration": ref.durationMs / 1000, "texture": {"resourceId": indices[ref.frameId]}} for ref in animation.frames],
    } for animation in document.animations]
    if animations != expected:
        raise ValueError("Godot 动画帧引用、顺序、循环或时长与指定版本不一致")


def validate_export_bundle(data: bytes, document: Document, asset_id: str, version_id: str, target: str):
    if target not in EXPORT_TARGETS or target == "png":
        raise ValueError("导出产物校验目标无效")
    if any(not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", value) for value in (asset_id, version_id)):
        raise ValueError("导出产物校验的素材或版本 ID 无效")
    prefix = f"pixelart_{asset_id}/" if target == "godot" else ""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise ValueError("ZIP 包含重复路径")
            if any(not name.startswith(prefix) or any(part in ("", ".", "..") for part in name.split("/")) or "\\" in name for name in names):
                raise ValueError("ZIP 路径无效")
            files = {name[len(prefix):]: archive.read(name) for name in names}
        manifest = _read_json(files, "manifest.json")
        hashes = manifest.get("files")
        if manifest.get("schemaVersion") != "1.1" or manifest.get("assetVersionId") != version_id:
            raise ValueError("manifest.json 版本绑定无效")
        if not isinstance(hashes, dict) or set(hashes) != set(files) - {"manifest.json"}:
            raise ValueError("manifest.json 文件清单与 ZIP 不一致")
        for path, digest in hashes.items():
            if digest != hashlib.sha256(files[path]).hexdigest():
                raise ValueError(f"{path} SHA256 校验失败")
        metadata_path = "index.json" if target == "frames" else "layout.json" if target == "sheet" else "asset.json"
        metadata = _read_json(files, metadata_path)
        if metadata.get("assetId") != asset_id or metadata.get("assetVersionId") != version_id or metadata.get("checksum") != checksum(document):
            raise ValueError(f"{metadata_path} 素材版本绑定无效")
        if metadata.get("animations") != [animation.model_dump() for animation in document.animations]:
            raise ValueError(f"{metadata_path} 动画帧引用、顺序或时长无效")
        frames = metadata.get("frames")
        if not isinstance(frames, list) or len(frames) != len(document.frames):
            raise ValueError(f"{metadata_path} 帧数量无效")
        required = {"manifest.json", metadata_path}
        for index, (exported, frame) in enumerate(zip(frames, document.frames)):
            expected = frame.model_dump(exclude={"pixels"})
            if not isinstance(exported, dict) or any(exported.get(key) != value for key, value in expected.items()):
                raise ValueError(f"{metadata_path} 帧 {frame.id} 尺寸或元数据无效")
            if target != "sheet":
                image_path = f"frames/{index:03d}_{frame.id}.png" if target == "frames" else f"frames/{frame.id}.png"
                if exported.get("imageRef") != image_path or image_path not in files:
                    raise ValueError(f"帧 {frame.id} 缺少合成 PNG 引用 {image_path}")
                generated = _load_generated_png(files[image_path], (frame.width, frame.height), image_path)
                if generated.tobytes() != composite(document, frame).tobytes():
                    raise ValueError(f"帧 {frame.id} 合成 PNG 像素与指定版本不一致")
                required.add(image_path)
            if target in ("json", "godot"):
                expected_layers = {layer.id: f"layers/{layer.id}/{frame.id}.png" for layer in document.layers}
                if exported.get("pixels") != expected_layers:
                    raise ValueError(f"帧 {frame.id} 图层引用无效")
                for path in expected_layers.values():
                    if path not in files:
                        raise ValueError(f"缺少图层 PNG {path}")
                    generated = _load_generated_png(files[path], (frame.width, frame.height), path)
                    layer_id = path.split("/", 2)[1]
                    if generated.tobytes() != decode_image(frame.pixels[layer_id]).tobytes():
                        raise ValueError(f"图层 PNG {path} 像素与指定版本不一致")
                    required.add(path)
        if target in ("json", "godot") and metadata.get("layers") != [layer.model_dump() for layer in document.layers]:
            raise ValueError("图层属性与指定版本不一致")
        uniform = len({(frame.width, frame.height) for frame in document.frames}) == 1
        if target == "sheet" or target in ("json", "godot") and uniform:
            sheet = metadata.get("spriteSheet")
            if not isinstance(sheet, dict) or sheet.get("imageRef") != "spritesheet.png" or "spritesheet.png" not in files:
                raise ValueError("缺少 Sprite Sheet PNG 或布局引用")
            if target == "sheet" and metadata.get("layout") != sheet:
                raise ValueError("布局 JSON 与 Sprite Sheet 引用不一致")
            width, height = document.frames[0].width, document.frames[0].height
            columns, rows = min(8, len(document.frames)), (len(document.frames) + 7) // 8
            sheet_image = _load_generated_png(files["spritesheet.png"], (columns * width, rows * height), "spritesheet.png")
            regions = sheet.get("regions")
            if not isinstance(regions, dict) or set(regions) != {frame.id for frame in document.frames}:
                raise ValueError("Sprite Sheet 帧区域引用无效")
            positions = set()
            for frame in document.frames:
                region = regions[frame.id]
                if not isinstance(region, dict) or set(region) != {"x", "y", "width", "height"} or any(type(value) is not int for value in region.values()):
                    raise ValueError(f"Sprite Sheet 帧 {frame.id} 区域无效")
                x, y = region["x"], region["y"]
                if (region["width"], region["height"]) != (width, height) or x < 0 or y < 0 or x % width or y % height or x + width > columns * width or y + height > rows * height or (x, y) in positions:
                    raise ValueError(f"Sprite Sheet 帧 {frame.id} 区域越界或重复")
                if sheet_image.crop((x, y, x + width, y + height)).tobytes() != composite(document, frame).tobytes():
                    raise ValueError(f"Sprite Sheet 帧 {frame.id} 像素与指定版本不一致")
                positions.add((x, y))
            frame_order = sheet.get("frameOrder")
            if not isinstance(frame_order, list) or any(not isinstance(value, str) for value in frame_order) or set(frame_order) != set(regions) or len(frame_order) != len(regions):
                raise ValueError("Sprite Sheet 帧顺序无效")
            for index, frame_id in enumerate(frame_order):
                if (regions[frame_id]["x"], regions[frame_id]["y"]) != ((index % columns) * width, (index // columns) * height):
                    raise ValueError("Sprite Sheet 帧顺序与区域不一致")
            if any(sheet.get(key) != value for key, value in {"cellWidth": width, "cellHeight": height, "columns": columns, "rows": rows}.items()):
                raise ValueError("Sprite Sheet 网格尺寸无效")
            required.add("spritesheet.png")
        if target == "godot":
            _validate_spriteframes(files, document, asset_id)
            required.add("spriteframes.tres")
        if set(files) != required:
            raise ValueError("ZIP 文件集合与导出目标不一致")
    except (ValueError, UnicodeError, zipfile.BadZipFile, RuntimeError) as error:
        raise ValueError(f"导出产物校验失败：{error}") from error


def export_bundle(document: Document, asset_id: str, version_id: str, target: str) -> bytes:
    if target == "png":
        raise ValueError("单帧 PNG 请使用 PNG 导出")
    document = validate_export_document(document, target)
    if any(not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", value) for value in (asset_id, version_id)):
        raise ValueError("导出预检失败：素材或版本 ID 无效")
    files = {}
    manifest = document.model_dump()
    manifest.update(assetId=asset_id, assetVersionId=version_id, checksum=checksum(document))
    if target in ("frames", "sheet"):
        manifest.pop("layers")
    else:
        manifest.update(targetEngine="godot" if target == "godot" else None, targetEngineVersion="4.7.2" if target == "godot" else None)
    for index, (frame, data) in enumerate(zip(document.frames, manifest["frames"])):
        data.pop("pixels")
        if target != "sheet":
            path = f"frames/{index:03d}_{frame.id}.png" if target == "frames" else f"frames/{frame.id}.png"
            files[path] = png_bytes(composite(document, frame))
            data["imageRef"] = path
        if target in ("json", "godot"):
            data["pixels"] = {}
            for layer in document.layers:
                layer_path = f"layers/{layer.id}/{frame.id}.png"
                files[layer_path] = png_bytes(decode_image(frame.pixels[layer.id]))
                data["pixels"][layer.id] = layer_path
    if target != "frames" and len({(f.width, f.height) for f in document.frames}) == 1:
        width, height = document.frames[0].width, document.frames[0].height
        columns = min(8, len(document.frames))
        rows = (len(document.frames) + columns - 1) // columns
        sheet = Image.new("RGBA", (columns * width, rows * height))
        regions = {}
        frame_map = {frame.id: frame for frame in document.frames}
        direction_rank = {value: index for index, value in enumerate(("down", "left", "right", "up"))}
        animations_by_order = sorted(document.animations, key=lambda a: (direction_rank[a.direction], 0 if a.action == "idle" else 1))
        ordered_ids = list(dict.fromkeys([ref.frameId for animation in animations_by_order for ref in animation.frames] + list(frame_map)))
        for index, frame_id in enumerate(ordered_ids):
            frame = frame_map[frame_id]
            x, y = (index % columns) * width, (index // columns) * height
            sheet.paste(composite(document, frame), (x, y))
            regions[frame.id] = {"x": x, "y": y, "width": width, "height": height}
        files["spritesheet.png"] = png_bytes(sheet)
        manifest["spriteSheet"] = {"imageRef": "spritesheet.png", "regions": regions, "cellWidth": width, "cellHeight": height, "columns": columns, "rows": rows, "frameOrder": ordered_ids}
        if target == "sheet":
            # Keep the dedicated layout document convenient for consumers while
            # retaining the shared spriteSheet metadata shape used by JSON/Godot.
            manifest["layout"] = manifest["spriteSheet"]
    if target == "godot":
        lines = [f'[gd_resource type="SpriteFrames" load_steps={len(document.frames) + 1} format=3]', ""]
        for index, frame in enumerate(document.frames, 1):
            lines.append(f'[ext_resource type="Texture2D" path="res://pixelart_{asset_id}/frames/{frame.id}.png" id="{index}"]')
        indices = {frame.id: index for index, frame in enumerate(document.frames, 1)}
        animations = []
        for animation in document.animations:
            references = [f'{{"duration": {ref.durationMs / 1000:.6f}, "texture": ExtResource("{indices[ref.frameId]}")}}' for ref in animation.frames]
            animations.append('{"frames": [' + ", ".join(references) + '], "loop": ' + str(animation.loop).lower() + ', "name": &' + json.dumps(f"{animation.action}_{animation.direction}") + ', "speed": 1.0}')
        lines.extend(["", "[resource]", "animations = [" + ",\n".join(animations) + "]"])
        files["spriteframes.tres"] = "\n".join(lines).encode()
        manifest["ignoredBySpriteFrames"] = ["origin", "baselineY", "collisionRects", "layers"]
    metadata_path = "index.json" if target == "frames" else "layout.json" if target == "sheet" else "asset.json"
    files[metadata_path] = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
    files["manifest.json"] = json.dumps({"schemaVersion": "1.1", "assetVersionId": version_id, "files": {path: hashlib.sha256(value).hexdigest() for path, value in files.items()}}, indent=2).encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, value in files.items():
            archive.writestr((f"pixelart_{asset_id}/" if target == "godot" else "") + path, value)
    data = buffer.getvalue()
    validate_export_bundle(data, document, asset_id, version_id, target)
    return data
