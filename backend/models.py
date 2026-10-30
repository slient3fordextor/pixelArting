from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Point(Model):
    x: int
    y: int


class Rect(Point):
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class Layer(Model):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    name: str = Field(min_length=1, max_length=80)
    visible: bool = True
    locked: bool = False
    opacity: int = Field(default=255, ge=0, le=255)
    blendMode: Literal["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference", "exclusion"] = "normal"
    pixelsLocked: bool = False
    opacityLocked: bool = False
    groupId: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_-]{1,80}$")


class Frame(Model):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    width: int = Field(gt=0, le=512)
    height: int = Field(gt=0, le=512)
    pixels: dict[str, str]
    layerOverflow: dict[str, dict[str, str]] = Field(default_factory=dict)
    origin: Point | None = None
    baselineY: int | None = None
    collisionRects: list[Rect] = Field(default_factory=list, max_length=32)


class FrameRef(Model):
    frameId: str
    durationMs: int = Field(default=200, gt=0, le=60000)


class Animation(Model):
    action: Literal["idle", "walk"]
    direction: Literal["down", "left", "right", "up"]
    loop: bool = True
    frames: list[FrameRef] = Field(min_length=1, max_length=128)


class Document(Model):
    schemaVersion: Literal["1.1"] = "1.1"
    name: str = Field(min_length=1, max_length=100)
    type: Literal["image", "character"] = "image"
    layers: list[Layer] = Field(min_length=1, max_length=16)
    frames: list[Frame] = Field(min_length=1, max_length=64)
    animations: list[Animation] = Field(default_factory=list, max_length=8)
    provenance: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_structure(self):
        layer_ids = [layer.id for layer in self.layers]
        frame_ids = [frame.id for frame in self.frames]
        if len(set(layer_ids)) != len(layer_ids) or len(set(frame_ids)) != len(frame_ids):
            raise ValueError("图层和帧 ID 必须唯一")
        if sum(frame.width * frame.height for frame in self.frames) * len(self.layers) > 8_388_608:
            raise ValueError("素材总像素数超过上限")
        for frame in self.frames:
            if set(frame.pixels) != set(layer_ids):
                raise ValueError("每帧必须包含所有图层的图像")
            if set(frame.layerOverflow) - set(layer_ids):
                raise ValueError("越界像素引用了不存在的图层")
        pairs = [(a.action, a.direction) for a in self.animations]
        if len(set(pairs)) != len(pairs):
            raise ValueError("动作与方向组合不能重复")
        if any(ref.frameId not in frame_ids for a in self.animations for ref in a.frames):
            raise ValueError("动画引用不存在的帧")
        return self


RULES = (
    "size.grid", "palette.limit", "palette.membership", "transparency.halo",
    "animation.structure", "animation.baseline", "anchor.bounds", "export.integrity",
)


class CheckConfig(Model):
    targetWidth: int = Field(default=64, ge=1, le=512)
    targetHeight: int = Field(default=64, ge=1, le=512)
    maxColors: int = Field(default=32, ge=1, le=256)
    palette: list[str] = Field(default_factory=list, max_length=256)
    allowSemiTransparent: bool = False
    baselineTolerancePx: int = Field(default=0, ge=0, le=512)
    targetBaselineY: int | None = Field(default=None, ge=0, le=511)
    expectedIdleFrames: int = Field(default=1, ge=1, le=64)
    expectedWalkFrames: int = Field(default=4, ge=1, le=64)
    enabled: dict[str, bool] = Field(default_factory=lambda: dict.fromkeys(RULES, True))
    exportTarget: Literal["png", "frames", "sheet", "json", "godot"] = "png"
    godotVersion: Literal["4.7.2"] = "4.7.2"

    @model_validator(mode="after")
    def validate_config(self):
        import re

        if set(self.enabled) - set(RULES):
            raise ValueError("未知的规则 ID")
        self.enabled = {key: self.enabled.get(key, True) for key in RULES}
        if any(not re.fullmatch(r"#[0-9a-fA-F]{6}", color) for color in self.palette):
            raise ValueError("调色板必须使用 #RRGGBB")
        self.palette = [color.upper() for color in self.palette]
        if len(set(self.palette)) != len(self.palette):
            raise ValueError("调色板不能包含重复颜色")
        if self.targetBaselineY is not None and self.targetBaselineY >= self.targetHeight:
            raise ValueError("目标基线必须在画布内")
        return self


class AiProviderConfig(Model):
    """User-supplied OpenAI-compatible provider settings.

    ``apiKey`` is an internal field and is never serialized by an API response.
    Keeping it in a separate model makes accidental echoing harder to do.
    """

    baseUrl: str = Field(default="https://api.openai.com/v1", min_length=1, max_length=500)
    apiKey: str | None = Field(default=None, max_length=4096, repr=False)
    textModel: str = Field(default="gpt-4o-mini", min_length=1, max_length=200)
    imageModel: str = Field(default="gpt-image-1", min_length=1, max_length=200)
    imageSize: str = Field(default="1024x1024", min_length=1, max_length=40)
    requestTimeoutSeconds: int = Field(default=60, ge=1, le=300)
    maxOutputTokens: int = Field(default=8192, ge=256, le=32768)
    tokenLimitParameter: Literal["max_tokens", "max_completion_tokens"] = "max_tokens"
    sendImageBackground: bool = False

    @field_validator("baseUrl", mode="before")
    @classmethod
    def validate_base_url(cls, value):
        if not isinstance(value, str):
            raise ValueError("AI 服务地址必须是 HTTP(S) URL")
        value = value.strip().rstrip("/")
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.query or parsed.fragment or parsed.username or parsed.password:
            raise ValueError("AI 服务地址必须是无查询参数的 HTTP(S) URL")
        return value

    @field_validator("apiKey", mode="before")
    @classmethod
    def normalize_api_key(cls, value):
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("API Key 必须是字符串")
        value = value.strip()
        if any(ord(character) < 32 for character in value):
            raise ValueError("API Key 不能包含控制字符")
        return value or None

    @field_validator("textModel", "imageModel", mode="before")
    @classmethod
    def normalize_model_name(cls, value):
        if not isinstance(value, str):
            raise ValueError("模型名称必须是字符串")
        return value.strip()

    @field_validator("imageSize", mode="before")
    @classmethod
    def validate_image_size(cls, value):
        import re

        if value == "auto":
            return value
        if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,3}x[1-9][0-9]{0,3}", value):
            raise ValueError("图像生成尺寸必须是 auto 或 宽x高")
        width, height = (int(part) for part in value.split("x"))
        if width > 2048 or height > 2048 or width * height > 4_194_304:
            raise ValueError("图像生成尺寸不能超过 2048x2048")
        return value


class AiConfigUpdate(Model):
    baseUrl: str | None = Field(default=None, min_length=1, max_length=500)
    apiKey: str | None = Field(default=None, max_length=4096, repr=False)
    textModel: str | None = Field(default=None, min_length=1, max_length=200)
    imageModel: str | None = Field(default=None, min_length=1, max_length=200)
    imageSize: str | None = Field(default=None, min_length=1, max_length=40)
    requestTimeoutSeconds: int | None = Field(default=None, ge=1, le=300)
    maxOutputTokens: int | None = Field(default=None, ge=256, le=32768)
    tokenLimitParameter: Literal["max_tokens", "max_completion_tokens"] | None = None
    sendImageBackground: bool | None = None
    clearApiKey: bool = False

    @field_validator("baseUrl", mode="before")
    @classmethod
    def validate_optional_base_url(cls, value):
        if value is None:
            return value
        return AiProviderConfig.validate_base_url(value)

    @field_validator("apiKey", mode="before")
    @classmethod
    def normalize_optional_api_key(cls, value):
        return AiProviderConfig.normalize_api_key(value)

    @field_validator("textModel", "imageModel", mode="before")
    @classmethod
    def normalize_optional_model_name(cls, value):
        if value is None:
            return value
        return AiProviderConfig.normalize_model_name(value)

    @field_validator("imageSize", mode="before")
    @classmethod
    def validate_optional_image_size(cls, value):
        return None if value is None else AiProviderConfig.validate_image_size(value)


class AiProfileCreate(AiConfigUpdate):
    """Payload for creating a named provider profile.

    Omitted provider fields use the same defaults as ``AiProviderConfig``.
    ``apiKey`` is accepted only in the request body and is never part of a
    public profile response.
    """

    name: str = Field(min_length=1, max_length=80)

    @field_validator("name", mode="before")
    @classmethod
    def trim_profile_name(cls, value):
        if not isinstance(value, str):
            raise ValueError("AI 配置名称必须是字符串")
        return value.strip()


class AiProfileUpdate(AiConfigUpdate):
    name: str | None = Field(default=None, min_length=1, max_length=80)

    @field_validator("name", mode="before")
    @classmethod
    def trim_optional_profile_name(cls, value):
        if value is None:
            return value
        if not isinstance(value, str):
            raise ValueError("AI 配置名称必须是字符串")
        return value.strip()


class AiGenerationRequest(Model):
    projectId: str | None = None
    mode: Literal["agent_draw", "image_model"]
    prompt: str = Field(min_length=1, max_length=10000)
    width: int = Field(default=64, ge=1, le=512)
    height: int = Field(default=64, ge=1, le=512)
    variations: int = Field(default=1, ge=1, le=8)
    paletteLimit: int = Field(default=32, ge=1, le=256)
    transparentBackground: bool = True
    model: str | None = Field(default=None, min_length=1, max_length=200)

    @field_validator("prompt", mode="before")
    @classmethod
    def trim_prompt(cls, value):
        if not isinstance(value, str):
            raise ValueError("生成描述必须是字符串")
        return value.strip()

    @field_validator("model", mode="before")
    @classmethod
    def trim_model(cls, value):
        if value is None:
            return value
        if not isinstance(value, str):
            raise ValueError("模型名称必须是字符串")
        return value.strip()


class DrawingCommand(Model):
    tool: Literal[
        "create_canvas", "create_layer", "set_palette", "draw_rect", "draw_line", "fill_region",
        "set_pixel_batch", "copy_frame", "mirror_frame", "set_collision_rect",
        "set_origin", "run_quality_check",
    ]
    args: dict[str, Any] = Field(default_factory=dict, max_length=32)


class AiGenerationCandidate(Model):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    summary: str = Field(default="", max_length=1000)
    commands: list[DrawingCommand] = Field(default_factory=list, max_length=500)


class AiGeneration(Model):
    id: str
    projectId: str | None = None
    mode: Literal["agent_draw", "image_model"]
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    request: AiGenerationRequest
    result: dict[str, Any] | None = None
    error: str | None = None
    created: str
    updated: str


class AiCandidateSelect(Model):
    candidateId: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    projectId: str | None = None
    name: str | None = Field(default=None, min_length=1, max_length=100)


class SaveRequest(Model):
    expectedCurrentVersionId: str
    document: Document


class RestoreRequest(Model):
    expectedCurrentVersionId: str
    versionId: str


class DeleteAssetRequest(Model):
    expectedCurrentVersionId: str


class RenameAssetRequest(Model):
    expectedCurrentVersionId: str
    name: str = Field(min_length=1, max_length=100)


class CopyAssetRequest(Model):
    sourceAssetId: str | None = None
    versionId: str | None = None
    document: Document | None = None

    @model_validator(mode="after")
    def require_source(self):
        if self.document is None and not self.sourceAssetId:
            raise ValueError("复制素材需要提供来源素材或完整快照")
        return self


class CheckRequest(Model):
    versionId: str
    # A missing config uses the owning project's persisted configuration.  Keeping
    # this optional preserves compatibility with clients that only send versionId.
    config: CheckConfig | None = None


class RepairAction(Model):
    id: Literal["resize-nearest-v1", "map-palette-v1", "remove-halo-v1", "pad-canvas-v1", "align-frames-v1"]
    alphaThreshold: int = Field(default=128, ge=1, le=255)
    offsetX: int = Field(default=0, ge=0, le=512)
    offsetY: int = Field(default=0, ge=0, le=512)


class PreviewRequest(CheckRequest):
    actions: list[RepairAction] = Field(min_length=1, max_length=5)


class CommitRequest(Model):
    previewId: str
    expectedCurrentVersionId: str


class ProjectCreate(Model):
    name: str = Field(min_length=1, max_length=80)


class RenameProjectRequest(Model):
    name: str = Field(min_length=1, max_length=80)
    expectedName: str = Field(min_length=1, max_length=80)

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value):
        return value.strip() if isinstance(value, str) else value


class DeleteProjectRequest(Model):
    expectedName: str = Field(min_length=1, max_length=80)
    expectedCurrentVersions: dict[str, str] = Field(max_length=10000)


class BlankAssetCreate(Model):
    name: str = Field(default="未命名素材", min_length=1, max_length=100)
    width: int = Field(default=64, ge=1, le=512)
    height: int = Field(default=64, ge=1, le=512)
