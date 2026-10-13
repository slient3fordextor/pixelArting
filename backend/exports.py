import hashlib
import io
import json
import zipfile

from PIL import Image

from .images import checksum, composite, decode_image, png_bytes
from .models import Document


def export_bundle(document: Document, asset_id: str, version_id: str, target: str) -> bytes:
    files = {}
    manifest = document.model_dump()
    manifest.update(assetId=asset_id, assetVersionId=version_id, checksum=checksum(document), targetEngine="godot" if target == "godot" else None, targetEngineVersion="4.7.2" if target == "godot" else None)
    for frame, data in zip(document.frames, manifest["frames"]):
        path = f"frames/{frame.id}.png"
        files[path] = png_bytes(composite(document, frame))
        data["imageRef"] = path
        data["pixels"] = {}
        for layer in document.layers:
            layer_path = f"layers/{layer.id}/{frame.id}.png"
            files[layer_path] = png_bytes(decode_image(frame.pixels[layer.id]))
            data["pixels"][layer.id] = layer_path
    if len({(f.width, f.height) for f in document.frames}) == 1:
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
        manifest["spriteSheet"] = {"imageRef": "spritesheet.png", "regions": regions}
    if target == "godot":
        if not document.animations:
            raise ValueError("Godot 导出需要动作/方向映射；请先在时间轴中分配动画")
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
    files["asset.json"] = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
    files["manifest.json"] = json.dumps({"schemaVersion": "1.1", "assetVersionId": version_id, "files": {path: hashlib.sha256(value).hexdigest() for path, value in files.items()}}, indent=2).encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, value in files.items():
            archive.writestr((f"pixelart_{asset_id}/" if target == "godot" else "") + path, value)
    return buffer.getvalue()
