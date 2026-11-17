import math

import numpy as np
from PIL import Image

from .images import decode_image, encode_image, validate_images
from .models import MAX_DOCUMENT_PIXELS, CheckConfig, Document, RepairAction


def _resize_interval(coordinate: int, old_side: int, new_side: int) -> range:
    """Destinations whose nearest-neighbour sample selects this source pixel."""
    denominator = 2 * old_side
    first = (2 * coordinate * new_side - old_side + denominator - 1) // denominator
    last = (2 * (coordinate + 1) * new_side - old_side + denominator - 1) // denominator
    return range(first, last)


def _transform_overflow(frame, layer_id, image, action, dx, dy, remaining):
    transformed = {}
    for coordinate, color in frame.layerOverflow.get(layer_id, {}).items():
        x, y = map(int, coordinate.split(","))
        if 0 <= x < frame.width and 0 <= y < frame.height:
            raise ValueError("越界像素与画布重叠，请先整理图层再进行几何修复")
        if action.id == "resize-nearest-v1":
            xs = _resize_interval(x, frame.width, image.width)
            ys = _resize_interval(y, frame.height, image.height)
        else:
            xs, ys = range(x + dx, x + dx + 1), range(y + dy, y + dy + 1)
        count = len(xs) * len(ys)
        inside_x = max(0, min(xs.stop, image.width) - max(xs.start, 0))
        inside_y = max(0, min(ys.stop, image.height) - max(ys.start, 0))
        if count - inside_x * inside_y > remaining:
            raise ValueError("修复后的越界像素超过素材总像素上限")
        rgba = tuple(bytes.fromhex(color[1:]))
        for ny in ys:
            for nx in xs:
                if 0 <= nx < image.width and 0 <= ny < image.height:
                    image.putpixel((nx, ny), rgba)
                else:
                    if abs(nx) > 99999 or abs(ny) > 99999:
                        raise ValueError("修复后的越界像素坐标超过上限")
                    transformed[f"{nx},{ny}"] = color
                    remaining -= 1
    return transformed, remaining


def repair(document: Document, config: CheckConfig, actions: list[RepairAction]) -> Document:
    validate_images(document)
    result = document.model_copy(deep=True)
    geometric = {"resize-nearest-v1", "pad-canvas-v1", "align-frames-v1"}
    for action in actions:
        if any(layer.locked or layer.pixelsLocked for layer in result.layers):
            raise ValueError("修复不会修改锁定图层，请先解锁或使用手工编辑")
        if action.id == "map-palette-v1" and (not config.palette or len(config.palette) > config.maxColors):
            raise ValueError("调色板映射需要非空且不超过颜色上限的项目调色板")
        if action.id in geometric:
            canvas_pixels = (sum(frame.width * frame.height for frame in result.frames)
                             if action.id == "align-frames-v1" else
                             len(result.frames) * config.targetWidth * config.targetHeight)
            remaining = MAX_DOCUMENT_PIXELS - canvas_pixels * len(result.layers)
            if remaining < 0:
                raise ValueError("修复后的素材总像素数超过上限")
        for frame in result.frames:
            dx = dy = 0
            new_width, new_height = frame.width, frame.height
            if action.id in ("resize-nearest-v1", "pad-canvas-v1"):
                new_width, new_height = config.targetWidth, config.targetHeight
            if action.id == "pad-canvas-v1":
                dx, dy = action.offsetX, action.offsetY
                if frame.width + dx > new_width or frame.height + dy > new_height:
                    raise ValueError("透明画布补齐不能裁切原图，请增大画布或减小偏移")
            if action.id == "align-frames-v1":
                if frame.baselineY is None or config.targetBaselineY is None:
                    raise ValueError("帧对齐需要每帧基线和目标基线")
                dy = config.targetBaselineY - frame.baselineY
            sx, sy = new_width / frame.width, new_height / frame.height
            for layer in result.layers:
                image = decode_image(frame.pixels[layer.id])
                if action.id == "resize-nearest-v1":
                    image = image.resize((new_width, new_height), Image.Resampling.NEAREST)
                elif action.id in ("pad-canvas-v1", "align-frames-v1"):
                    bounds = image.getbbox()
                    if bounds and (bounds[0] + dx < 0 or bounds[1] + dy < 0 or bounds[2] + dx > new_width or bounds[3] + dy > new_height):
                        raise ValueError("对齐会裁掉有效像素，已拒绝操作")
                    canvas = Image.new("RGBA", (new_width, new_height))
                    canvas.paste(image, (dx, dy))
                    image = canvas
                elif layer.visible:
                    array = np.array(image)
                    if action.id == "remove-halo-v1":
                        array[:, :, 3] = np.where(array[:, :, 3] < action.alphaThreshold, 0, 255)
                        array[array[:, :, 3] == 0, :3] = 0
                    elif action.id == "map-palette-v1":
                        palette = np.array([list(bytes.fromhex(color[1:])) for color in config.palette], dtype=np.int32)
                        mask = array[:, :, 3] > 0
                        rgb = array[mask, :3].astype(np.int32)
                        if len(rgb):
                            mapped = np.empty_like(rgb, dtype=np.uint8)
                            for start in range(0, len(rgb), 1024):
                                chunk = rgb[start:start + 1024]
                                nearest = ((chunk[:, None, :] - palette[None, :, :]) ** 2).sum(axis=2).argmin(axis=1)
                                mapped[start:start + len(chunk)] = palette[nearest].astype(np.uint8)
                            array[mask, :3] = mapped
                    image = Image.fromarray(array)
                if action.id in geometric:
                    overflow, remaining = _transform_overflow(frame, layer.id, image, action, dx, dy, remaining)
                    if overflow:
                        frame.layerOverflow[layer.id] = overflow
                    else:
                        frame.layerOverflow.pop(layer.id, None)
                frame.pixels[layer.id] = encode_image(image)
            if action.id in geometric:
                def tx(x):
                    return math.floor(x * sx + 0.5) if action.id == "resize-nearest-v1" else x + dx

                def ty(y):
                    return math.floor(y * sy + 0.5) if action.id == "resize-nearest-v1" else y + dy

                if frame.origin:
                    frame.origin.x, frame.origin.y = tx(frame.origin.x), ty(frame.origin.y)
                    if not (0 <= frame.origin.x < new_width and 0 <= frame.origin.y < new_height):
                        raise ValueError("修复后原点会越界，已拒绝操作")
                if frame.baselineY is not None:
                    frame.baselineY = ty(frame.baselineY)
                    if not 0 <= frame.baselineY < new_height:
                        raise ValueError("修复后基线会越界，已拒绝操作")
                for rect in frame.collisionRects:
                    left, top = tx(rect.x), ty(rect.y)
                    right, bottom = tx(rect.x + rect.width), ty(rect.y + rect.height)
                    if left < 0 or top < 0 or right > new_width or bottom > new_height or left >= right or top >= bottom:
                        raise ValueError("修复后碰撞框无效，已拒绝操作")
                    rect.x, rect.y, rect.width, rect.height = left, top, right - left, bottom - top
                frame.width, frame.height = new_width, new_height
    result = Document.model_validate(result.model_dump())
    result.validate_storage_budget()
    validate_images(result)
    return result
