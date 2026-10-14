"""OpenAI-compatible providers for the optional AI workbench.

This module deliberately has no environment-key fallback. A provider is only
called after a user has configured it through the application settings.
"""

import json
import re
import time
from typing import Any

import httpx

from .models import AiGenerationCandidate, AiGenerationRequest, AiProviderConfig, DrawingCommand

MAX_PROVIDER_BYTES = 32 * 1024 * 1024


class AiProviderError(Exception):
    """A user-safe provider failure with no credentials in its message."""


def _json_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    raise AiProviderError("文本模型返回了无法识别的内容")


def _parse_json_object(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    try:
        value = json.loads(text)
    except (TypeError, json.JSONDecodeError) as error:
        raise AiProviderError("文本模型返回的绘画计划不是有效 JSON") from error
    if not isinstance(value, dict):
        raise AiProviderError("文本模型返回的绘画计划必须是 JSON 对象")
    return value


def _validate_command_bounds(command: DrawingCommand, request: AiGenerationRequest) -> DrawingCommand:
    """Reject obviously unsafe coordinates before a command reaches the editor."""

    args = command.args
    for key in ("x", "y", "x1", "y1", "x2", "y2"):
        value = args.get(key)
        if value is not None and (not isinstance(value, int) or isinstance(value, bool)):
            raise AiProviderError(f"绘画命令 {command.tool} 的 {key} 必须是整数")
        if isinstance(value, int):
            limit = request.width if key.startswith("x") else request.height
            if value < 0 or value >= limit:
                raise AiProviderError(f"绘画命令 {command.tool} 的 {key} 超出画布范围")
    for key, limit in (("width", request.width), ("height", request.height)):
        value = args.get(key)
        if value is not None and (not isinstance(value, int) or isinstance(value, bool) or value <= 0 or value > limit):
            raise AiProviderError(f"绘画命令 {command.tool} 的 {key} 超出画布范围")
    return command


def _candidate_payloads(raw: dict[str, Any], request: AiGenerationRequest) -> list[AiGenerationCandidate]:
    candidates = raw.get("candidates")
    if candidates is None and "commands" in raw:
        candidates = [{"id": "candidate_1", "commands": raw["commands"], "summary": raw.get("summary", "")}]
    if not isinstance(candidates, list) or not candidates:
        raise AiProviderError("文本模型没有返回绘画候选")
    if len(candidates) > request.variations:
        candidates = candidates[: request.variations]
    parsed = []
    for index, candidate in enumerate(candidates, start=1):
        if not isinstance(candidate, dict):
            raise AiProviderError("绘画候选必须是 JSON 对象")
        candidate_id = candidate.get("id", f"candidate_{index}")
        try:
            item = AiGenerationCandidate.model_validate({
                "id": candidate_id,
                "summary": candidate.get("summary", ""),
                "commands": candidate.get("commands", []),
            })
        except ValueError as error:
            raise AiProviderError("文本模型返回了不支持的绘画命令") from error
        if not item.commands:
            raise AiProviderError("绘画候选不能没有命令")
        parsed.append(item.model_copy(update={"commands": [_validate_command_bounds(command, request) for command in item.commands]}))
    if len({candidate.id for candidate in parsed}) != len(parsed):
        raise AiProviderError("文本模型返回的候选 ID 重复")
    return parsed


class OpenAICompatibleProvider:
    def __init__(self, config: AiProviderConfig, transport: httpx.BaseTransport | None = None):
        self.config = config
        self.transport = transport

    def _client(self) -> httpx.Client:
        if not self.config.apiKey:
            raise AiProviderError("尚未配置 AI API Key")
        return httpx.Client(
            base_url=self.config.baseUrl,
            headers={"Authorization": f"Bearer {self.config.apiKey}", "Content-Type": "application/json"},
            timeout=self.config.requestTimeoutSeconds,
            transport=self.transport,
        )

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            with self._client() as client:
                deadline = time.monotonic() + self.config.requestTimeoutSeconds
                with client.stream("POST", path, json=payload) as response:
                    response.raise_for_status()
                    chunks, size = [], 0
                    for chunk in response.iter_bytes():
                        if time.monotonic() > deadline:
                            raise AiProviderError("AI 服务请求超时，请稍后重试")
                        size += len(chunk)
                        if size > MAX_PROVIDER_BYTES:
                            raise AiProviderError("AI 服务返回内容超过 32 MB 上限")
                        chunks.append(chunk)
                    value = json.loads(b"".join(chunks))
        except AiProviderError:
            raise
        except httpx.HTTPStatusError as error:
            messages = {
                401: "AI 服务身份验证失败，请检查 API Key",
                403: "AI 服务拒绝访问，请检查模型权限",
                404: "AI 服务地址或模型不存在，请检查配置",
                429: "AI 服务额度不足或请求过多，请稍后重试",
            }
            detail = messages.get(error.response.status_code, "AI 服务返回错误，请稍后重试")
            raise AiProviderError(f"{detail} (HTTP {error.response.status_code})") from error
        except (httpx.HTTPError, ValueError, TypeError) as error:
            # Do not include response text or URL: compatible providers can echo
            # request headers and that would risk leaking the user's key.
            raise AiProviderError("AI 服务请求失败，请检查服务地址、模型和网络") from error
        if not isinstance(value, dict):
            raise AiProviderError("AI 服务返回格式无效")
        return value

    def generate_text(self, request: AiGenerationRequest) -> dict[str, Any]:
        model = request.model or self.config.textModel
        payload = {
            "model": model,
            "n": 1,
            self.config.tokenLimitParameter: self.config.maxOutputTokens,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是像素画工具规划器。只返回 JSON 对象，格式为 "
                        "{candidates:[{id,summary,commands:[{tool,args}]}]}。"
                        "工具只能是 create_canvas,create_layer,set_palette,draw_rect,draw_line,fill_region,"
                        "set_pixel_batch,copy_frame,mirror_frame,set_collision_rect,set_origin,"
                        "run_quality_check。所有坐标必须在画布内，画布尺寸由用户请求决定。"
                        "首条命令必须 create_canvas {width,height,name?,frameId?:'frame_0',layerId?:'base',transparentBackground?,backgroundColor?}。"
                        "create_layer {id,name?}；set_palette {colors:[#RRGGBB]}；"
                        "draw_rect {frameId?,layerId?,x,y,width,height,color,filled?:true}；"
                        "draw_line {frameId?,layerId?,x1,y1,x2,y2,color}；"
                        "fill_region {frameId?,layerId?,x,y,color}；"
                        "set_pixel_batch {frameId?,layerId?,pixels:[{x,y,color}]}；"
                        "copy_frame {sourceFrameId,targetFrameId}；"
                        "mirror_frame {frameId?,axis:'horizontal'|'vertical'}；"
                        "set_collision_rect {frameId?,x,y,width,height}；"
                        "set_origin {frameId?,x,y,baselineY?}；run_quality_check {}。"
                        "颜色必须 #RRGGBB 或透明色 #00000000。最多 500 条命令，每个候选必须至少有一条绘图命令。"
                        "不透明画布默认白色，背景颜色计入调色板色数；可用 backgroundColor 指定背景。"
                        "set_palette 必须包含已用颜色，此后绘图颜色必须在调色板内；透明色不计入色数。"
                        "最多 64 帧、16 图层。run_quality_check 只能是最后一条命令。"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps({
                        "prompt": request.prompt,
                        "width": request.width,
                        "height": request.height,
                        "variations": request.variations,
                        "paletteLimit": request.paletteLimit,
                        "transparentBackground": request.transparentBackground,
                    }, ensure_ascii=False),
                },
            ],
        }
        body = self._post("chat/completions", payload)
        try:
            choice = body["choices"][0]
            content = _json_content(choice["message"]["content"])
        except (KeyError, IndexError, TypeError) as error:
            raise AiProviderError("文本模型返回格式无效") from error
        candidates = _candidate_payloads(_parse_json_object(content), request)
        return {
            "kind": "drawing_commands",
            "provider": "openai-compatible",
            "model": model,
            "calledExternally": True,
            "candidates": [candidate.model_dump() for candidate in candidates],
        }

    def generate_image(self, request: AiGenerationRequest) -> dict[str, Any]:
        model = request.model or self.config.imageModel
        payload = {
            "model": model,
            "prompt": request.prompt + ("\n透明背景，适合作为像素素材。" if request.transparentBackground else "\n使用完整不透明背景，适合作为像素素材。"),
            "size": self.config.imageSize,
            "n": request.variations,
        }
        if self.config.sendImageBackground:
            payload["background"] = "transparent" if request.transparentBackground else "opaque"
        body = self._post("images/generations", payload)
        data = body.get("data")
        if not isinstance(data, list) or not data:
            raise AiProviderError("图像模型没有返回候选图片")
        candidates = []
        for index, item in enumerate(data[: request.variations], start=1):
            if not isinstance(item, dict):
                raise AiProviderError("图像模型返回了无效候选")
            encoded = item.get("b64_json")
            url = item.get("url")
            if not isinstance(encoded, str) and not isinstance(url, str):
                raise AiProviderError("图像模型候选缺少图片数据")
            candidate = {"id": f"candidate_{index}", "mimeType": "image/png"}
            if isinstance(encoded, str):
                if len(encoded) > 20_000_000:
                    raise AiProviderError("图像模型返回的图片过大")
                candidate["b64Json"] = encoded
            else:
                candidate["url"] = url
            candidates.append(candidate)
        return {
            "kind": "image_candidates",
            "provider": "openai-compatible",
            "model": model,
            "calledExternally": True,
            "candidates": candidates,
        }

