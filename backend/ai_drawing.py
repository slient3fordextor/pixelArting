"""Execute bounded, declarative pixel drawing commands without evaluating code."""

import re
from typing import Literal

from PIL import Image, ImageDraw, ImageOps
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .images import encode_image
from .models import AiGenerationCandidate, AiGenerationRequest, CheckConfig, Document, Frame, Layer, Point, Rect
from .quality import inspect

MAX_COMMANDS = 500
MAX_FRAMES = 64
MAX_LAYERS = 16
MAX_SURFACE_PIXELS = 8_388_608
MAX_WORK_PIXELS = 16_777_216
MAX_BATCH_PIXELS = 16_384

Identifier = str


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Canvas(_Args):
    width: int = Field(ge=1, le=512)
    height: int = Field(ge=1, le=512)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    frameId: Identifier = Field(default="frame_0", pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    layerId: Identifier = Field(default="base", pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    transparentBackground: bool | None = None
    backgroundColor: str | None = None


class _Palette(_Args):
    colors: list[str] = Field(min_length=1, max_length=256)


class _Layer(_Args):
    id: Identifier = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    name: str | None = Field(default=None, min_length=1, max_length=80)


class _FrameTarget(_Args):
    frameId: Identifier | None = Field(default=None, pattern=r"^[a-zA-Z0-9_-]{1,80}$")


class _PixelTarget(_FrameTarget):
    layerId: Identifier | None = Field(default=None, pattern=r"^[a-zA-Z0-9_-]{1,80}$")


class _DrawRect(_PixelTarget):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    color: str
    filled: bool = True


class _Line(_PixelTarget):
    x1: int = Field(ge=0)
    y1: int = Field(ge=0)
    x2: int = Field(ge=0)
    y2: int = Field(ge=0)
    color: str


class _Fill(_PixelTarget):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    color: str


class _Pixel(_Args):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    color: str


class _Batch(_PixelTarget):
    pixels: list[_Pixel] = Field(min_length=1, max_length=MAX_BATCH_PIXELS)


class _Copy(_Args):
    sourceFrameId: Identifier = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    targetFrameId: Identifier = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")


class _Mirror(_FrameTarget):
    axis: Literal["horizontal", "vertical"]


class _Collision(_FrameTarget):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class _Origin(_FrameTarget):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    baselineY: int | None = Field(default=None, ge=0)


_SCHEMAS = {
    "create_canvas": _Canvas,
    "set_palette": _Palette,
    "create_layer": _Layer,
    "draw_rect": _DrawRect,
    "draw_line": _Line,
    "fill_region": _Fill,
    "set_pixel_batch": _Batch,
    "copy_frame": _Copy,
    "mirror_frame": _Mirror,
    "set_collision_rect": _Collision,
    "set_origin": _Origin,
    "run_quality_check": _Args,
}


class _Renderer:
    def __init__(self, request: AiGenerationRequest, candidate: AiGenerationCandidate):
        self.request = request
        self.candidate = candidate
        self.layers: dict[str, Layer] = {}
        self.frames: dict[str, Frame] = {}
        self.images: dict[str, dict[str, Image.Image]] = {}
        self.palette: set[tuple[int, int, int]] | None = None
        self.used_colors: set[tuple[int, int, int]] = set()
        self.work = 0
        self.drawn = False
        self.check_requested = False
        self.name = candidate.summary[:100] or request.prompt[:100]
        self.default_frame = "frame_0"
        self.default_layer = "base"

    def charge(self, pixels: int):
        if self.work + pixels > MAX_WORK_PIXELS:
            raise ValueError("Drawing work exceeds the pixel budget")
        self.work += pixels

    def check_surface(self, frame_count: int, layer_count: int):
        if frame_count > MAX_FRAMES or layer_count > MAX_LAYERS:
            raise ValueError("Drawing exceeds the frame or layer limit")
        if self.request.width * self.request.height * frame_count * layer_count > MAX_SURFACE_PIXELS:
            raise ValueError("Drawing exceeds the total surface pixel budget")

    def position(self, x: int, y: int):
        if not 0 <= x < self.request.width or not 0 <= y < self.request.height:
            raise ValueError("Drawing coordinate is outside the canvas")

    def rectangle(self, x: int, y: int, width: int, height: int):
        self.position(x, y)
        self.position(x + width - 1, y + height - 1)

    def color(self, value: str) -> tuple[int, int, int, int]:
        if not re.fullmatch(r"#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?", value):
            raise ValueError("Drawing colors must be #RRGGBB or #RRGGBBAA")
        channels = tuple(bytes.fromhex(value[1:]))
        rgba = channels if len(channels) == 4 else (*channels, 255)
        if rgba[3] not in (0, 255):
            raise ValueError("Drawing colors cannot be semi-transparent")
        if rgba[3] == 0:
            return (0, 0, 0, 0)
        rgb = rgba[:3]
        if self.palette is not None and rgb not in self.palette:
            raise ValueError("Drawing color is outside the declared palette")
        if len(self.used_colors | {rgb}) > self.request.paletteLimit:
            raise ValueError("Drawing exceeds the requested palette limit")
        self.used_colors.add(rgb)
        return rgba

    def frame(self, frame_id: str | None) -> Frame:
        frame_id = frame_id or self.default_frame
        if frame_id not in self.frames:
            raise ValueError("Drawing references an unknown frame")
        return self.frames[frame_id]

    def image(self, args: _PixelTarget) -> Image.Image:
        frame = self.frame(args.frameId)
        layer_id = args.layerId or self.default_layer
        if layer_id not in self.layers:
            raise ValueError("Drawing references an unknown layer")
        return self.images[frame.id][layer_id]

    def execute(self, tool: str, args: _Args):
        area = self.request.width * self.request.height
        if tool == "create_canvas":
            if self.frames:
                raise ValueError("create_canvas can only be used once, as the first command")
            if (args.width, args.height) != (self.request.width, self.request.height):
                raise ValueError("Canvas dimensions must match the generation request")
            if args.transparentBackground is not None and args.transparentBackground != self.request.transparentBackground:
                raise ValueError("Canvas transparency must match the generation request")
            background = self.color(args.backgroundColor or ("#00000000" if self.request.transparentBackground else "#FFFFFF"))
            if self.request.transparentBackground != (background[3] == 0):
                raise ValueError("Canvas background must match the requested transparency")
            self.charge(area)
            self.default_frame, self.default_layer = args.frameId, args.layerId
            self.name = args.name or self.name
            self.layers[args.layerId] = Layer(id=args.layerId, name=args.layerId)
            self.frames[args.frameId] = Frame(id=args.frameId, width=args.width, height=args.height, pixels={})
            self.images[args.frameId] = {args.layerId: Image.new("RGBA", (args.width, args.height), background)}
        elif tool == "set_palette":
            if len(args.colors) > self.request.paletteLimit:
                raise ValueError("Declared palette exceeds the requested palette limit")
            if any(not re.fullmatch(r"#[0-9a-fA-F]{6}", color) for color in args.colors):
                raise ValueError("Palette colors must be #RRGGBB")
            palette = {tuple(bytes.fromhex(color[1:])) for color in args.colors}
            if len(palette) != len(args.colors):
                raise ValueError("Declared palette contains duplicate colors")
            if not self.used_colors <= palette:
                raise ValueError("Declared palette omits colors already used")
            self.palette = palette
        elif tool == "create_layer":
            if args.id in self.layers:
                raise ValueError("Drawing layer IDs must be unique")
            self.check_surface(len(self.frames), len(self.layers) + 1)
            self.charge(area * len(self.frames))
            self.layers[args.id] = Layer(id=args.id, name=args.name or args.id)
            for frame_images in self.images.values():
                frame_images[args.id] = Image.new("RGBA", (self.request.width, self.request.height))
        elif tool == "draw_rect":
            image = self.image(args)
            self.rectangle(args.x, args.y, args.width, args.height)
            color = self.color(args.color)
            self.charge(args.width * args.height)
            box = (args.x, args.y, args.x + args.width - 1, args.y + args.height - 1)
            ImageDraw.Draw(image).rectangle(box, **({"fill": color} if args.filled else {"outline": color}))
            self.drawn = True
        elif tool == "draw_line":
            image = self.image(args)
            self.position(args.x1, args.y1)
            self.position(args.x2, args.y2)
            color = self.color(args.color)
            self.charge(max(abs(args.x2 - args.x1), abs(args.y2 - args.y1)) + 1)
            ImageDraw.Draw(image).line((args.x1, args.y1, args.x2, args.y2), fill=color)
            self.drawn = True
        elif tool == "fill_region":
            image = self.image(args)
            self.position(args.x, args.y)
            color = self.color(args.color)
            self.charge(area)
            ImageDraw.floodfill(image, (args.x, args.y), color)
            self.drawn = True
        elif tool == "set_pixel_batch":
            image = self.image(args)
            self.charge(len(args.pixels))
            pixels = []
            for pixel in args.pixels:
                self.position(pixel.x, pixel.y)
                pixels.append((pixel.x, pixel.y, self.color(pixel.color)))
            for x, y, color in pixels:
                image.putpixel((x, y), color)
            self.drawn = True
        elif tool == "copy_frame":
            source = self.frame(args.sourceFrameId)
            if args.targetFrameId in self.frames:
                raise ValueError("Drawing frame IDs must be unique")
            self.check_surface(len(self.frames) + 1, len(self.layers))
            self.charge(area * len(self.layers))
            self.frames[args.targetFrameId] = source.model_copy(deep=True, update={"id": args.targetFrameId})
            self.images[args.targetFrameId] = {key: image.copy() for key, image in self.images[source.id].items()}
        elif tool == "mirror_frame":
            frame = self.frame(args.frameId)
            self.charge(area * len(self.layers))
            transform = ImageOps.mirror if args.axis == "horizontal" else ImageOps.flip
            self.images[frame.id] = {key: transform(image) for key, image in self.images[frame.id].items()}
            horizontal = args.axis == "horizontal"
            if frame.origin is not None:
                if horizontal:
                    frame.origin.x = frame.width - 1 - frame.origin.x
                else:
                    frame.origin.y = frame.height - 1 - frame.origin.y
            if not horizontal and frame.baselineY is not None:
                frame.baselineY = frame.height - 1 - frame.baselineY
            for rect in frame.collisionRects:
                if horizontal:
                    rect.x = frame.width - rect.x - rect.width
                else:
                    rect.y = frame.height - rect.y - rect.height
        elif tool == "set_collision_rect":
            frame = self.frame(args.frameId)
            self.rectangle(args.x, args.y, args.width, args.height)
            if len(frame.collisionRects) >= 32:
                raise ValueError("Drawing exceeds the collision rectangle limit")
            frame.collisionRects.append(Rect(x=args.x, y=args.y, width=args.width, height=args.height))
        elif tool == "set_origin":
            frame = self.frame(args.frameId)
            self.position(args.x, args.y)
            if args.baselineY is not None:
                self.position(0, args.baselineY)
            frame.origin = Point(x=args.x, y=args.y)
            if "baselineY" in args.model_fields_set:
                frame.baselineY = args.baselineY
        elif tool == "run_quality_check":
            self.check_requested = True
        else:
            raise ValueError("Unknown drawing tool")

    def document(self) -> Document:
        if not self.drawn:
            raise ValueError("A drawing candidate must contain at least one drawing command")
        for frame in self.frames.values():
            if not self.request.transparentBackground:
                flattened = Image.new("RGBA", (frame.width, frame.height))
                for image in self.images[frame.id].values():
                    flattened = Image.alpha_composite(flattened, image)
                if flattened.getchannel("A").getextrema()[0] != 255:
                    raise ValueError("Drawing contains transparency despite an opaque background request")
            frame.pixels = {key: encode_image(image) for key, image in self.images[frame.id].items()}
        palette = ["#" + bytes(color).hex().upper() for color in sorted(self.palette or self.used_colors)]
        document = Document(
            name=self.name,
            layers=list(self.layers.values()),
            frames=list(self.frames.values()),
            provenance={
                "kind": "ai", "mode": "agent_draw", "prompt": self.request.prompt,
                "candidateId": self.candidate.id, "commandCount": len(self.candidate.commands),
                "palette": palette, "licenseStatus": "unknown",
            },
        )
        if self.check_requested:
            document.provenance["quality"] = inspect(document, CheckConfig(
                targetWidth=self.request.width, targetHeight=self.request.height,
                maxColors=self.request.paletteLimit, palette=palette,
            ))
        return document


def render_commands(request: AiGenerationRequest, candidate: AiGenerationCandidate) -> Document:
    """Render one candidate in memory; no project, asset, or version is persisted."""
    request = AiGenerationRequest.model_validate(request.model_dump())
    candidate = AiGenerationCandidate.model_validate(candidate.model_dump())
    if request.mode != "agent_draw":
        raise ValueError("Drawing commands require agent_draw mode")
    if not candidate.commands or len(candidate.commands) > MAX_COMMANDS:
        raise ValueError("Drawing candidates must contain 1 to 500 commands")
    if candidate.commands[0].tool != "create_canvas":
        raise ValueError("The first drawing command must be create_canvas")
    renderer = _Renderer(request, candidate)
    for index, command in enumerate(candidate.commands, start=1):
        try:
            schema = _SCHEMAS.get(command.tool)
            if schema is None:
                raise ValueError("Unknown drawing tool")
            args = schema.model_validate(command.args)
            if command.tool == "run_quality_check" and index != len(candidate.commands):
                raise ValueError("run_quality_check must be the final command")
            renderer.execute(command.tool, args)
        except (ValidationError, ValueError) as error:
            raise ValueError(f"Drawing command {index} ({command.tool}) is invalid: {error}") from error
    return renderer.document()
