import pytest

import backend.ai_drawing as drawing
from backend.ai_drawing import render_commands
from backend.images import composite, decode_image
from backend.models import AiGenerationCandidate, AiGenerationRequest, DrawingCommand


def request(**changes):
    return AiGenerationRequest(mode="agent_draw", prompt="A small pixel sprite", width=8, height=8, **changes)


def command(tool, **args):
    return {"tool": tool, "args": args}


def canvas(**changes):
    return command("create_canvas", **{"width": 8, "height": 8, **changes})


def candidate(*commands):
    return AiGenerationCandidate(id="candidate_1", summary="Pixel sprite", commands=list(commands))


def pixel(document, x, y, frame_index=0, layer="base"):
    return decode_image(document.frames[frame_index].pixels[layer]).getpixel((x, y))


def red_pixel(**changes):
    return command("set_pixel_batch", pixels=[{"x": 1, "y": 1, "color": "#FF0000", **changes}])


def test_draws_exact_rect_line_pixels_and_preserves_transparent_background():
    doc = render_commands(request(paletteLimit=2), candidate(
        canvas(name="A sprite"),
        command("set_palette", colors=["#FF0000", "#0000ff"]),
        command("draw_rect", x=1, y=1, width=2, height=3, color="#FF0000"),
        command("draw_line", x1=0, y1=7, x2=7, y2=0, color="#0000FF"),
        command("set_pixel_batch", pixels=[{"x": 7, "y": 7, "color": "#FF0000FF"}]),
        command("run_quality_check"),
    ))
    assert doc.name == "A sprite"
    assert pixel(doc, 1, 1) == (255, 0, 0, 255)
    assert pixel(doc, 2, 3) == (255, 0, 0, 255)
    assert pixel(doc, 3, 3) == (0, 0, 0, 0)
    assert pixel(doc, 0, 7) == (0, 0, 255, 255)
    assert pixel(doc, 7, 0) == (0, 0, 255, 255)
    assert pixel(doc, 7, 7) == (255, 0, 0, 255)
    assert doc.provenance["palette"] == ["#0000FF", "#FF0000"]
    assert doc.provenance["quality"]["colorCount"] == 2
    assert not doc.provenance["quality"]["findings"]


def test_rectangle_outline_and_connected_fill_do_not_cross_boundary():
    doc = render_commands(request(), candidate(
        canvas(),
        command("draw_rect", x=1, y=1, width=6, height=6, color="#FF0000", filled=False),
        command("fill_region", x=2, y=2, color="#0000FF"),
    ))
    assert pixel(doc, 1, 1) == (255, 0, 0, 255)
    assert pixel(doc, 6, 6) == (255, 0, 0, 255)
    assert pixel(doc, 5, 5) == (0, 0, 255, 255)
    assert pixel(doc, 0, 0) == (0, 0, 0, 0)
    assert pixel(doc, 7, 7) == (0, 0, 0, 0)


def test_layers_copy_independently_and_mirrors_metadata_in_both_axes():
    doc = render_commands(request(), candidate(
        canvas(frameId="front", layerId="body"),
        command("create_layer", id="hat", name="Hat"),
        command("set_pixel_batch", pixels=[{"x": 1, "y": 2, "color": "#FF0000"}]),
        command("set_pixel_batch", layerId="hat", pixels=[{"x": 2, "y": 1, "color": "#0000FF"}]),
        command("set_origin", x=1, y=2, baselineY=6),
        command("set_collision_rect", x=1, y=2, width=2, height=3),
        command("copy_frame", sourceFrameId="front", targetFrameId="back"),
        command("mirror_frame", frameId="back", axis="horizontal"),
        command("mirror_frame", frameId="back", axis="vertical"),
        command("set_pixel_batch", frameId="back", layerId="hat", pixels=[{"x": 0, "y": 0, "color": "#0000FF"}]),
        command("create_layer", id="glow"),
    ))
    assert [layer.id for layer in doc.layers] == ["body", "hat", "glow"]
    assert [frame.id for frame in doc.frames] == ["front", "back"]
    assert set(doc.frames[0].pixels) == {"body", "hat", "glow"}
    assert set(doc.frames[1].pixels) == {"body", "hat", "glow"}
    assert pixel(doc, 1, 2, layer="body") == (255, 0, 0, 255)
    assert pixel(doc, 6, 5, frame_index=1, layer="body") == (255, 0, 0, 255)
    assert pixel(doc, 5, 6, frame_index=1, layer="hat") == (0, 0, 255, 255)
    assert pixel(doc, 0, 0, layer="hat")[3] == 0
    assert doc.frames[0].origin.model_dump() == {"x": 1, "y": 2}
    assert doc.frames[0].baselineY == 6
    assert doc.frames[0].collisionRects[0].model_dump() == {"x": 1, "y": 2, "width": 2, "height": 3}
    assert doc.frames[1].origin.model_dump() == {"x": 6, "y": 5}
    assert doc.frames[1].baselineY == 1
    assert doc.frames[1].collisionRects[0].model_dump() == {"x": 5, "y": 3, "width": 2, "height": 3}


def test_opaque_background_and_binary_alpha_are_preserved():
    doc = render_commands(request(transparentBackground=False, paletteLimit=2), candidate(
        canvas(backgroundColor="#0000FF"),
        command("set_palette", colors=["#0000FF", "#FF0000"]),
        command("create_layer", id="top"),
        command("set_pixel_batch", layerId="top", pixels=[
            {"x": 0, "y": 0, "color": "#FF0000"},
            {"x": 1, "y": 1, "color": "#ABCDEF00"},
        ]),
    ))
    image = composite(doc, doc.frames[0])
    assert image.getpixel((0, 0)) == (255, 0, 0, 255)
    assert image.getpixel((1, 1)) == (0, 0, 255, 255)
    assert image.getchannel("A").getextrema() == (255, 255)
    assert pixel(doc, 1, 1, layer="top") == (0, 0, 0, 0)


@pytest.mark.parametrize("operation", [
    command("draw_rect", x=7, y=0, width=2, height=1, color="#FF0000"),
    command("draw_rect", x=0, y=7, width=1, height=2, color="#FF0000"),
    command("draw_line", x1=0, y1=0, x2=8, y2=0, color="#FF0000"),
    command("draw_line", x1=0, y1=8, x2=0, y2=0, color="#FF0000"),
    command("fill_region", x=8, y=0, color="#FF0000"),
    red_pixel(x=-1),
    red_pixel(y=8),
    command("set_origin", x=8, y=0),
    command("set_origin", x=0, y=0, baselineY=8),
    command("set_collision_rect", x=7, y=0, width=2, height=1),
    command("draw_rect", x=0, y=0, width=0, height=1, color="#FF0000"),
])
def test_rejects_out_of_bounds_and_degenerate_operations(operation):
    with pytest.raises(ValueError):
        render_commands(request(), candidate(canvas(), red_pixel(), operation))


@pytest.mark.parametrize("operation", [
    command("draw_rect", x=True, y=0, width=1, height=1, color="#FF0000"),
    command("draw_line", x1=0.0, y1=0, x2=1, y2=0, color="#FF0000"),
    command("fill_region", x="0", y=0, color="#FF0000"),
    command("draw_rect", x=0, y=0, width=1, height=1, color="#FF0000", filled=1),
    command("draw_rect", x=0, y=0, width=1, height=1, color="#FF0000", code="open('/tmp/file')"),
    red_pixel(path="/tmp/file"),
    command("set_pixel_batch", pixels=[{"x": 1, "y": 1, "color": "#FF0000", "opacity": 10}]),
    command("run_quality_check", command="eval"),
    command("create_layer", id="../outside"),
    command("mirror_frame", axis="diagonal"),
    command("copy_frame", sourceFrameId="frame_0", targetFrameId="other", path="/tmp/file"),
])
def test_rejects_unknown_fields_wrong_types_and_unsafe_identifiers(operation):
    with pytest.raises(ValueError):
        render_commands(request(), candidate(canvas(), red_pixel(), operation))


@pytest.mark.parametrize("color", ["red", "#FFF", "#FF000080", "rgba(1,2,3,1)", "#GG0000", "__import__('os')"])
def test_rejects_invalid_and_semitransparent_colors(color):
    with pytest.raises(ValueError, match="color"):
        render_commands(request(), candidate(canvas(), red_pixel(color=color)))


def test_rejects_color_outside_palette_and_requested_palette_limit():
    with pytest.raises(ValueError, match="outside"):
        render_commands(request(), candidate(canvas(), command("set_palette", colors=["#0000FF"]), red_pixel()))
    with pytest.raises(ValueError, match="palette limit"):
        render_commands(request(paletteLimit=1), candidate(canvas(), red_pixel(), red_pixel(color="#0000FF")))
    with pytest.raises(ValueError, match="palette limit"):
        render_commands(request(paletteLimit=1), candidate(canvas(), command("set_palette", colors=["#FF0000", "#0000FF"]), red_pixel()))
    with pytest.raises(ValueError, match="omits"):
        render_commands(request(), candidate(canvas(), red_pixel(), command("set_palette", colors=["#0000FF"])))
    with pytest.raises(ValueError, match="duplicate"):
        render_commands(request(), candidate(canvas(), command("set_palette", colors=["#FF0000", "#ff0000"]), red_pixel()))


@pytest.mark.parametrize("operation", [
    red_pixel(),
    canvas(width=7),
    canvas(transparentBackground=False),
    canvas(backgroundColor="#FF0000"),
    canvas(path="/tmp/output.png"),
    canvas(width=True),
])
def test_rejects_inconsistent_or_missing_canvas(operation):
    with pytest.raises(ValueError):
        render_commands(request(), candidate(operation, red_pixel()))


def test_rejects_second_canvas_empty_drawing_unknown_tool_and_wrong_mode():
    with pytest.raises(ValueError, match="once"):
        render_commands(request(), candidate(canvas(), red_pixel(), canvas()))
    with pytest.raises(ValueError, match="drawing command"):
        render_commands(request(), candidate(canvas()))
    with pytest.raises(ValueError):
        render_commands(request(), candidate())
    unsafe = AiGenerationCandidate.model_construct(id="candidate", summary="", commands=[
        DrawingCommand.model_construct(tool="execute_python", args={"code": "pass"}),
    ])
    with pytest.raises(ValueError):
        render_commands(request(), unsafe)
    image_request = AiGenerationRequest(mode="image_model", prompt="A sprite")
    with pytest.raises(ValueError, match="agent_draw"):
        render_commands(image_request, candidate(canvas(), red_pixel()))


@pytest.mark.parametrize("operation", [
    command("draw_rect", frameId="missing", x=0, y=0, width=1, height=1, color="#FF0000"),
    command("fill_region", layerId="missing", x=0, y=0, color="#FF0000"),
    command("copy_frame", sourceFrameId="missing", targetFrameId="other"),
    command("copy_frame", sourceFrameId="frame_0", targetFrameId="frame_0"),
    command("create_layer", id="base"),
    command("set_origin", frameId="missing", x=0, y=0),
    command("mirror_frame", frameId="missing", axis="horizontal"),
])
def test_rejects_missing_references_and_duplicate_ids(operation):
    with pytest.raises(ValueError):
        render_commands(request(), candidate(canvas(), red_pixel(), operation))


def test_rejects_quality_check_before_completion():
    with pytest.raises(ValueError, match="final"):
        render_commands(request(), candidate(canvas(), command("run_quality_check"), red_pixel()))


def test_origin_update_preserves_baseline_unless_explicitly_cleared():
    operations = [canvas(), red_pixel(), command("set_origin", x=1, y=1, baselineY=6)]
    doc = render_commands(request(), candidate(*operations, command("set_origin", x=2, y=2)))
    assert doc.frames[0].origin.model_dump() == {"x": 2, "y": 2}
    assert doc.frames[0].baselineY == 6
    cleared = render_commands(request(), candidate(*operations, command("set_origin", x=2, y=2, baselineY=None)))
    assert cleared.frames[0].baselineY is None


def test_rejects_transparency_in_opaque_final_image():
    with pytest.raises(ValueError, match="opaque background"):
        render_commands(request(transparentBackground=False), candidate(canvas(), red_pixel(color="#00000000")))


def test_enforces_command_batch_and_work_budgets(monkeypatch):
    with pytest.raises(ValueError):
        render_commands(request(), candidate(canvas(), *[red_pixel() for _ in range(500)]))
    with pytest.raises(ValueError, match="pixels"):
        render_commands(request(), candidate(canvas(), command("set_pixel_batch", pixels=[{"x": 0, "y": 0, "color": "#FF0000"}] * (drawing.MAX_BATCH_PIXELS + 1))))
    monkeypatch.setattr(drawing, "MAX_WORK_PIXELS", 127)
    with pytest.raises(ValueError, match="work"):
        render_commands(request(), candidate(canvas(), command("fill_region", x=0, y=0, color="#FF0000")))


def test_enforces_frame_layer_surface_and_metadata_budgets(monkeypatch):
    with pytest.raises(ValueError, match="frame or layer"):
        render_commands(request(), candidate(canvas(), red_pixel(), *[
            command("copy_frame", sourceFrameId="frame_0", targetFrameId=f"frame_{index}") for index in range(1, 65)
        ]))
    with pytest.raises(ValueError, match="frame or layer"):
        render_commands(request(), candidate(canvas(), red_pixel(), *[
            command("create_layer", id=f"layer_{index}") for index in range(16)
        ]))
    with pytest.raises(ValueError, match="collision rectangle"):
        render_commands(request(), candidate(canvas(), red_pixel(), *[
            command("set_collision_rect", x=0, y=0, width=1, height=1) for _ in range(33)
        ]))
    monkeypatch.setattr(drawing, "MAX_SURFACE_PIXELS", 127)
    with pytest.raises(ValueError, match="surface"):
        render_commands(request(), candidate(canvas(), red_pixel(), command("create_layer", id="top")))


def test_candidate_commands_are_not_modified():
    item = candidate(canvas(), red_pixel(), command("set_origin", x=1, y=1), command("mirror_frame", axis="horizontal"))
    before = item.model_dump()
    render_commands(request(), item)
    assert item.model_dump() == before
