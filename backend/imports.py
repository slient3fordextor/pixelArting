import hashlib
from pathlib import Path
from typing import Literal

from PIL import Image
from pydantic import Field, TypeAdapter

from .images import decode_png, encode_image
from .models import Animation, Document, Frame, FrameRef, Layer, Model


class SheetLayout(Model):
    cellWidth: int = Field(default=0, ge=0, le=512)
    cellHeight: int = Field(default=0, ge=0, le=512)
    marginX: int = Field(default=0, ge=0, le=1024)
    marginY: int = Field(default=0, ge=0, le=1024)
    spacingX: int = Field(default=0, ge=0, le=2048)
    spacingY: int = Field(default=0, ge=0, le=2048)
    rows: int = Field(default=0, ge=0, le=64)
    columns: int = Field(default=0, ge=0, le=64)
    offsetX: int = Field(default=0, ge=0, le=2048)
    offsetY: int = Field(default=0, ge=0, le=2048)
    cropMode: Literal["strict", "clip"] = "strict"


class ImportMapping(Model):
    frameIndex: int = Field(ge=0, le=63)
    action: Literal["idle", "walk"]
    direction: Literal["down", "left", "right", "up"]
    durationMs: int = Field(default=200, gt=0, le=60000)


def retain_png(root: Path, data: bytes) -> tuple[Image.Image, str]:
    image = decode_png(data, max_side=2048)
    digest = hashlib.sha256(data).hexdigest()
    source_dir = root / "sources"
    source_dir.mkdir(exist_ok=True)
    source = source_dir / f"{digest}.png"
    if not source.exists():
        source.write_bytes(data)
    return image, digest


def normalized_layout(image: Image.Image, requested: SheetLayout) -> SheetLayout:
    if not requested.cellWidth and not requested.cellHeight:
        if any((requested.marginX, requested.marginY, requested.spacingX, requested.spacingY, requested.rows, requested.columns, requested.offsetX, requested.offsetY)):
            raise ValueError("Sprite Sheet 布局必须设置单帧宽高")
        if image.width > 512 or image.height > 512:
            raise ValueError("单图最大 512×512；更大的 Sheet 请明确单帧尺寸")
        return SheetLayout(cellWidth=image.width, cellHeight=image.height, rows=1, columns=1)
    if not requested.cellWidth or not requested.cellHeight:
        raise ValueError("Sprite Sheet 必须同时设置单帧宽高")

    def count(side: int, cell: int, margin: int, spacing: int, requested_count: int, offset: int, axis: str) -> int:
        usable = side - offset - 2 * margin
        if usable < cell:
            raise ValueError(f"{axis}边距过大，剩余区域不足一帧")
        value = requested_count or (usable + spacing) // (cell + spacing)
        occupied = offset + 2 * margin + value * cell + (value - 1) * spacing
        if requested.cropMode == "strict" and occupied != side:
            raise ValueError(f"{axis}布局未完整覆盖 PNG：图片 {side}px，布局 {occupied}px，请调整边距、间距或行列数")
        return value

    columns = count(image.width, requested.cellWidth, requested.marginX, requested.spacingX, requested.columns, requested.offsetX, "水平")
    rows = count(image.height, requested.cellHeight, requested.marginY, requested.spacingY, requested.rows, requested.offsetY, "垂直")
    if rows * columns > 64:
        raise ValueError("单个素材最多 64 帧")
    return requested.model_copy(update={"rows": rows, "columns": columns})


def sliced_frames(image: Image.Image, layout: SheetLayout) -> list[dict]:
    frames = []
    for row in range(layout.rows):
        for column in range(layout.columns):
            index = len(frames)
            x = layout.offsetX + layout.marginX + column * (layout.cellWidth + layout.spacingX)
            y = layout.offsetY + layout.marginY + row * (layout.cellHeight + layout.spacingY)
            if x + layout.cellWidth > image.width or y + layout.cellHeight > image.height:
                if layout.cropMode == "clip": continue
                raise ValueError("Sprite Sheet 切分区域超出图片边界")
            frames.append({
                "frameIndex": index,
                "frameId": f"frame_{index}",
                "row": row,
                "column": column,
                "rect": {"x": x, "y": y, "width": layout.cellWidth, "height": layout.cellHeight},
                "image": encode_image(image.crop((x, y, x + layout.cellWidth, y + layout.cellHeight))),
            })
    return frames


def preview_import(image: Image.Image, requested: SheetLayout, digest: str) -> dict:
    layout = normalized_layout(image, requested)
    layout_data = layout.model_dump()
    if layout.offsetX == 0: layout_data.pop("offsetX", None)
    if layout.offsetY == 0: layout_data.pop("offsetY", None)
    if layout.cropMode == "strict": layout_data.pop("cropMode", None)
    return {
        "source": {"width": image.width, "height": image.height, "checksum": digest, "originalRef": f"sources/{digest}.png"},
        "layout": layout_data,
        "frames": sliced_frames(image, layout),
    }


def imported_document(image: Image.Image, requested: SheetLayout, digest: str, filename: str | None, name: str, mapping: str, mapping_confirmed: bool) -> Document:
    preview = preview_import(image, requested, digest)
    mappings = TypeAdapter(list[ImportMapping]).validate_json(mapping)
    if mappings and not mapping_confirmed:
        raise ValueError("请先确认动作与方向映射")
    indices = [item.frameIndex for item in mappings]
    if len(set(indices)) != len(indices):
        raise ValueError("同一帧不能重复设置导入映射")
    if any(index >= len(preview["frames"]) for index in indices):
        raise ValueError("导入映射引用不存在的帧")
    grouped: dict[tuple[str, str], list[FrameRef]] = {}
    for item in sorted(mappings, key=lambda value: value.frameIndex):
        grouped.setdefault((item.action, item.direction), []).append(FrameRef(frameId=f"frame_{item.frameIndex}", durationMs=item.durationMs))
    animations = [Animation(action=action, direction=direction, frames=refs) for (action, direction), refs in grouped.items()]
    return Document(
        name=name.strip() or Path(filename or "素材.png").stem[:100] or "素材",
        type="character" if animations else "image",
        layers=[Layer(id="base", name="原始图层")],
        frames=[Frame(id=frame["frameId"], width=frame["rect"]["width"], height=frame["rect"]["height"], pixels={"base": frame["image"]}) for frame in preview["frames"]],
        animations=animations,
        provenance={"kind": "upload", "originalRef": f"sources/{digest}.png", "originalChecksum": digest, "licenseStatus": "unknown", "sheetLayout": preview["layout"], "importMapping": [item.model_dump() for item in sorted(mappings, key=lambda value: value.frameIndex)]},
    )
