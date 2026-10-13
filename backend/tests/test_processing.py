import io
import json
import zipfile

import pytest
from PIL import Image

from backend.exports import export_bundle
from backend.images import checksum, composite, decode_image, encode_image, png_bytes
from backend.models import Animation, CheckConfig, Document, Frame, FrameRef, Layer, Point, RepairAction
from backend.quality import inspect
from backend.repairs import repair
from backend.store import Conflict, Store


def document(size=(64, 64), color=(200, 20, 30, 255)):
    return Document(name="测试", layers=[Layer(id="base", name="底层")], frames=[Frame(id="frame_0", width=size[0], height=size[1], pixels={"base": encode_image(Image.new("RGBA", size, color))})])


def test_hidden_layers_preserved_and_opacity_composites():
    doc = document(color=(255, 0, 0, 255))
    doc.layers.append(Layer(id="top", name="上层", opacity=128))
    doc.frames[0].pixels["top"] = encode_image(Image.new("RGBA", (64, 64), (0, 0, 255, 255)))
    assert composite(doc, doc.frames[0]).getpixel((0, 0)) == (127, 0, 128, 255)
    doc.layers[-1].visible = False
    assert composite(doc, doc.frames[0]).getpixel((0, 0)) == (255, 0, 0, 255)
    assert decode_image(doc.frames[0].pixels["top"]).getpixel((0, 0)) == (0, 0, 255, 255)


def test_transparent_rgb_does_not_count_and_disabled_does_not_report():
    doc = document(color=(123, 45, 67, 0))
    config = CheckConfig(enabled={"size.grid": False}, targetWidth=32)
    report = inspect(doc, config)
    assert report["colorCount"] == 0
    assert not report["findings"]
    assert next(rule for rule in report["rules"] if rule["ruleId"] == "size.grid")["status"] == "disabled"
    assert next(rule for rule in report["rules"] if rule["ruleId"] == "palette.membership")["status"] == "skipped"


def test_palette_count_union_and_mapping_ties():
    doc = document(color=(1, 0, 0, 255))
    second = doc.frames[0].model_copy(deep=True)
    second.id = "frame_1"
    second.pixels["base"] = encode_image(Image.new("RGBA", (64, 64), (0, 2, 0, 255)))
    doc.frames.append(second)
    report = inspect(doc, CheckConfig(maxColors=1))
    assert report["colorCount"] == 2
    assert any(f["ruleId"] == "palette.limit" for f in report["findings"])
    result = repair(doc, CheckConfig(palette=["#000000", "#020000"]), [RepairAction(id="map-palette-v1")])
    assert decode_image(result.frames[0].pixels["base"]).getpixel((0, 0)) == (0, 0, 0, 255)
    assert decode_image(doc.frames[0].pixels["base"]).getpixel((0, 0)) == (1, 0, 0, 255)


def test_binary_alpha_boundary_and_layer_opacity_remains():
    doc = document(color=(20, 50, 100, 127))
    result = repair(doc, CheckConfig(), [RepairAction(id="remove-halo-v1")])
    assert decode_image(result.frames[0].pixels["base"]).getpixel((0, 0)) == (0, 0, 0, 0)
    doc.frames[0].pixels["base"] = encode_image(Image.new("RGBA", (64, 64), (20, 50, 100, 128)))
    doc.layers[0].opacity = 128
    result = repair(doc, CheckConfig(), [RepairAction(id="remove-halo-v1")])
    assert decode_image(result.frames[0].pixels["base"]).getpixel((0, 0))[3] == 255
    assert any(f["ruleId"] == "transparency.halo" for f in inspect(result, CheckConfig())["findings"])


def test_padding_preserves_all_layers_and_moves_metadata():
    doc = document((32, 32))
    doc.frames[0].origin = Point(x=15, y=31)
    doc.frames[0].baselineY = 31
    doc.layers.append(Layer(id="hidden", name="隐藏", visible=False))
    doc.frames[0].pixels["hidden"] = encode_image(Image.new("RGBA", (32, 32), (1, 2, 3, 255)))
    result = repair(doc, CheckConfig(), [RepairAction(id="pad-canvas-v1", offsetX=8, offsetY=8)])
    assert result.frames[0].origin == Point(x=23, y=39)
    assert result.frames[0].baselineY == 39
    assert decode_image(result.frames[0].pixels["hidden"]).getpixel((8, 8)) == (1, 2, 3, 255)
    assert decode_image(result.frames[0].pixels["hidden"]).getpixel((0, 0))[3] == 0
    assert doc.frames[0].width == 32


def test_alignment_refuses_clipping_and_missing_marker():
    doc = document()
    with pytest.raises(ValueError, match="基线"):
        repair(doc, CheckConfig(targetBaselineY=10), [RepairAction(id="align-frames-v1")])
    doc.frames[0].baselineY = 30
    with pytest.raises(ValueError, match="裁掉"):
        repair(doc, CheckConfig(targetBaselineY=10), [RepairAction(id="align-frames-v1")])


def test_resize_refuses_degenerate_origin_and_locks():
    doc = document()
    doc.frames[0].origin = Point(x=63, y=63)
    with pytest.raises(ValueError, match="原点"):
        repair(doc, CheckConfig(targetWidth=1, targetHeight=1), [RepairAction(id="resize-nearest-v1")])
    doc.layers[0].locked = True
    with pytest.raises(ValueError, match="锁定"):
        repair(doc, CheckConfig(), [RepairAction(id="remove-halo-v1")])


def test_character_missing_directions_not_invented():
    doc = document()
    doc.type = "character"
    doc.animations = [Animation(action="idle", direction="down", frames=[FrameRef(frameId="frame_0")])]
    findings = inspect(doc, CheckConfig())["findings"]
    assert len([f for f in findings if f["ruleId"] == "animation.structure"]) == 7


def test_version_checksum_includes_layers_not_encoding():
    doc = document()
    before = checksum(doc)
    doc.provenance["source"] = "another path"
    assert checksum(doc) == before
    doc.layers[0].opacity = 128
    assert checksum(doc) != before


def test_store_atomic_versions_preview_idempotency_and_conflict(tmp_path):
    store = Store(tmp_path)
    project = store.project("测试")
    asset = store.create_asset(project["id"], document(color=(20, 30, 40, 128)))
    base = asset["currentVersionId"]
    doc = store.document(asset["id"], base)
    fixed = repair(doc, CheckConfig(), [RepairAction(id="remove-halo-v1")])
    preview_id = store.preview(asset["id"], base, fixed, [], CheckConfig().model_dump())
    result, _ = store.commit(asset["id"], preview_id, base)
    assert result != base
    assert store.commit(asset["id"], preview_id, base)[0] == result
    assert len(store.asset(asset["id"])["versions"]) == 2
    assert decode_image(store.document(asset["id"], base).frames[0].pixels["base"]).getpixel((0, 0))[3] == 128
    stale = store.preview(asset["id"], base, fixed, [], CheckConfig().model_dump())
    with pytest.raises(Conflict):
        store.commit(asset["id"], stale, base)
    with pytest.raises(Conflict):
        store.save(asset["id"], base, doc)
    restored = store.restore(asset["id"], result, base)
    assert restored["currentVersionId"] == base
    assert store.save(asset["id"], base, doc) == base


def test_export_preserves_hidden_layers_and_frame_duration():
    doc = document()
    doc.layers[0].visible = False
    doc.animations = [Animation(action="idle", direction="down", frames=[FrameRef(frameId="frame_0", durationMs=200)])]
    data = export_bundle(doc, "asset1", "version1", "godot")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        manifest = json.loads(archive.read("pixelart_asset1/asset.json"))
        assert manifest["targetEngineVersion"] == "4.7.2"
        assert not manifest["layers"][0]["visible"]
        assert Image.open(io.BytesIO(archive.read("pixelart_asset1/frames/frame_0.png"))).getpixel((0, 0))[3] == 0
        assert Image.open(io.BytesIO(archive.read("pixelart_asset1/layers/base/frame_0.png"))).getpixel((0, 0))[3] == 255
        text = archive.read("pixelart_asset1/spriteframes.tres").decode()
        assert '"duration": 0.200000' in text
        assert '"speed": 1.0' in text


def test_sprite_sheet_follows_explicit_animation_order():
    doc = document()
    second = doc.frames[0].model_copy(deep=True)
    second.id = "frame_up"
    doc.frames.insert(0, second)
    doc.animations = [Animation(action="idle", direction="up", frames=[FrameRef(frameId="frame_up")]), Animation(action="idle", direction="down", frames=[FrameRef(frameId="frame_0")])]
    with zipfile.ZipFile(io.BytesIO(export_bundle(doc, "asset", "version", "json"))) as archive:
        metadata = json.loads(archive.read("asset.json"))
        assert metadata["spriteSheet"]["regions"]["frame_0"]["x"] == 0
        assert metadata["spriteSheet"]["regions"]["frame_up"]["x"] == 64


@pytest.mark.parametrize("size", [(10, 10), (64, 64)])
def test_png_roundtrip(size):
    image = Image.new("RGBA", size, (31, 82, 64, 128))
    assert decode_image(encode_image(image)).tobytes() == image.tobytes()
    assert png_bytes(image).startswith(b"\x89PNG")
