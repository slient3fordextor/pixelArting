import base64
import hashlib
import io
import json
import warnings

import numpy as np
from PIL import Image

from .models import Document, Frame

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 4_194_304


def decode_png(data: bytes, max_side: int = 512) -> Image.Image:
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError("PNG 文件不能超过 8 MB")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.format != "PNG" or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("仅支持静态 PNG，暂不支持 APNG")
                if len(data) < 25 or data[24] != 8:
                    raise ValueError("首版仅接受 8 位 PNG，请先转换位深")
                if image.width > max_side or image.height > max_side:
                    raise ValueError(f"图像尺寸不能超过 {max_side}×{max_side}")
                if image.mode.startswith("I") or image.mode == "F":
                    raise ValueError("仅支持 8 位 PNG")
                return image.convert("RGBA")
        except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
            raise ValueError("图像像素数超过安全上限") from error
        except (OSError, SyntaxError) as error:
            raise ValueError("无法解码 PNG 文件") from error


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def encode_image(image: Image.Image) -> str:
    return "data:image/png;base64," + base64.b64encode(png_bytes(image)).decode("ascii")


def decode_image(value: str) -> Image.Image:
    prefix = "data:image/png;base64,"
    if not value.startswith(prefix) or len(value) > MAX_UPLOAD_BYTES * 4 // 3 + 64:
        raise ValueError("图层图像必须是大小受限的 PNG data URL")
    try:
        return decode_png(base64.b64decode(value[len(prefix):], validate=True))
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError("图层 PNG 数据无效") from error


def validate_images(document: Document):
    for frame in document.frames:
        for value in frame.pixels.values():
            image = decode_image(value)
            if image.size != (frame.width, frame.height):
                raise ValueError("图层尺寸必须与所在帧的画布一致")


def composite(document: Document, frame: Frame) -> Image.Image:
    result = Image.new("RGBA", (frame.width, frame.height))
    for layer in document.layers:
        if not layer.visible or not layer.opacity:
            continue
        image = decode_image(frame.pixels[layer.id])
        if layer.opacity != 255:
            array = np.array(image)
            array[:, :, 3] = ((array[:, :, 3].astype(np.uint16) * layer.opacity + 127) // 255).astype(np.uint8)
            image = Image.fromarray(array)
        result = Image.alpha_composite(result, image)
    return result


def checksum(document: Document) -> str:
    content = document.model_dump()
    content.pop("provenance", None)
    for frame in content["frames"]:
        frame["pixels"] = {
            key: hashlib.sha256(decode_image(value).tobytes()).hexdigest()
            for key, value in frame["pixels"].items()
        }
    serialized = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(serialized.encode()).hexdigest()
