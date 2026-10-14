import base64
import time
from urllib.parse import urlparse

import httpx
import numpy as np
from PIL import Image

from .ai import AiProviderError
from .images import MAX_UPLOAD_BYTES, composite, encode_image
from .imports import retain_png
from .models import AiGenerationCandidate, AiGenerationRequest, Document, Frame, Layer


def _image_bytes(candidate: dict, timeout_seconds: int) -> bytes:
    encoded = candidate.get("b64Json")
    if isinstance(encoded, str):
        if len(encoded) > MAX_UPLOAD_BYTES * 4 // 3 + 4:
            raise AiProviderError("候选 PNG 不能超过 8 MB")
        try:
            return base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise AiProviderError("候选图片编码无效") from error
    url = candidate.get("url")
    if not isinstance(url, str):
        raise AiProviderError("候选图片缺少数据")
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise AiProviderError("候选图片地址必须是 HTTP(S) URL")
    try:
        # Never forward a provider's authorization header to a returned URL.
        # Redirects are rejected instead of forwarding to an unexpected host.
        with httpx.Client(timeout=timeout_seconds, follow_redirects=False) as client:
            deadline = time.monotonic() + timeout_seconds
            with client.stream("GET", url) as response:
                if 300 <= response.status_code < 400:
                    raise AiProviderError("候选图片地址不允许重定向")
                response.raise_for_status()
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    if time.monotonic() > deadline:
                        raise AiProviderError("候选图片下载超时，请稍后重试")
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise AiProviderError("候选 PNG 不能超过 8 MB")
                    chunks.append(chunk)
                return b"".join(chunks)
    except AiProviderError:
        raise
    except httpx.HTTPError as error:
        raise AiProviderError("无法下载候选图片，请检查服务返回的地址") from error


def _pixelate(image: Image.Image, request: AiGenerationRequest) -> Image.Image:
    resized = image.resize((request.width, request.height), Image.Resampling.NEAREST)
    if not request.transparentBackground:
        resized = Image.alpha_composite(Image.new("RGBA", resized.size, "white"), resized)
    pixels = np.array(resized)
    if request.transparentBackground:
        pixels[:, :, 3] = np.where(pixels[:, :, 3] >= 128, 255, 0).astype(np.uint8)
        pixels[pixels[:, :, 3] == 0] = 0
    result = np.zeros_like(pixels)
    visible = pixels[:, :, 3] > 0
    if visible.any():
        # Invisible RGB values cannot consume palette entries or darken a
        # one-color sprite during quantization.
        strip = Image.fromarray(pixels[visible, :3].reshape((1, -1, 3)))
        colors = strip.quantize(
            colors=request.paletteLimit, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE,
        ).convert("RGB")
        result[visible, :3] = np.array(colors).reshape((-1, 3))
        result[:, :, 3] = pixels[:, :, 3]
    return Image.fromarray(result)


def prepare_candidates(result: dict, request: AiGenerationRequest, root, timeout_seconds: int = 60) -> dict:
    """Validate and render all candidates before publishing a successful task."""
    from .ai_drawing import render_commands

    prepared = []
    for item in result.get("candidates", []):
        if request.mode == "agent_draw":
            try:
                candidate = AiGenerationCandidate.model_validate(item)
                document = render_commands(request, candidate)
            except ValueError as error:
                raise AiProviderError("文本模型返回的绘画命令无法安全执行，请重试或调整描述") from error
            value = candidate.model_dump()
        else:
            data = _image_bytes(item, timeout_seconds)
            try:
                original, digest = retain_png(root, data)
            except ValueError as error:
                raise AiProviderError("图像模型返回的候选不是有效的静态 PNG") from error
            image = _pixelate(original, request)
            document = Document(
                name=request.prompt[:80] or "AI 候选",
                layers=[Layer(id="base", name="AI 图像")],
                frames=[Frame(id="frame_0", width=request.width, height=request.height, pixels={"base": encode_image(image)})],
                provenance={"kind": "ai", "originalRef": f"sources/{digest}.png", "originalChecksum": digest, "licenseStatus": "unknown"},
            )
            # Signed external URLs and raw unbounded provider payloads never
            # reach the renderer or get retained in the generation result.
            value = {"id": item["id"], "mimeType": "image/png", "source": {"width": original.width, "height": original.height, "checksum": digest, "originalRef": f"sources/{digest}.png"}}
        value.update({"document": document.model_dump(), "image": encode_image(composite(document, document.frames[0]))})
        prepared.append(value)
    if not prepared:
        raise AiProviderError("AI 服务没有返回可用候选")
    return {**result, "candidates": prepared}
