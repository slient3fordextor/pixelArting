from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


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


class Frame(Model):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    width: int = Field(gt=0, le=512)
    height: int = Field(gt=0, le=512)
    pixels: dict[str, str]
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


class BlankAssetCreate(Model):
    name: str = Field(default="未命名素材", min_length=1, max_length=100)
    width: int = Field(default=64, ge=1, le=512)
    height: int = Field(default=64, ge=1, le=512)
