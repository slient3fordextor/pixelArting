import io
import json
import hashlib
import os
import subprocess
import zipfile

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.exports import export_bundle, validate_export_bundle
from backend.images import encode_image, png_bytes
from backend.models import Animation, Document, Frame, FrameRef, Layer


def complete_character() -> Document:
    frames = []
    for index in range(20):
        image = Image.new("RGBA", (16, 16), (index + 1, 30, 80, 255))
        hidden = Image.new("RGBA", (16, 16), (220, index + 1, 10, 255))
        frames.append(Frame(
            id=f"frame_{index:02d}", width=16, height=16,
            pixels={"base": encode_image(image), "hidden": encode_image(hidden)},
        ))
    animations = []
    directions = ("down", "left", "right", "up")
    for direction_index, direction in enumerate(directions):
        idle = direction_index * 5
        animations.append(Animation(action="idle", direction=direction, frames=[FrameRef(frameId=frames[idle].id, durationMs=150 + direction_index)]))
        animations.append(Animation(
            action="walk", direction=direction,
            frames=[FrameRef(frameId=frames[idle + offset].id, durationMs=200 + offset * 25) for offset in range(1, 5)],
        ))
    return Document(
        name="完整角色", type="character",
        layers=[Layer(id="base", name="底层"), Layer(id="hidden", name="隐藏", visible=False)],
        frames=frames, animations=animations,
    )


def files(data: bytes, prefix: str = "") -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {name[len(prefix):]: archive.read(name) for name in archive.namelist()}


def test_frames_export_preserves_real_frame_order_and_durations():
    document = complete_character()
    data = export_bundle(document, "character", "version1", "frames")
    exported = files(data)
    index = json.loads(exported["index.json"])
    assert index["assetId"] == "character"
    assert [frame["id"] for frame in index["frames"]] == [frame.id for frame in document.frames]
    assert [frame["imageRef"] for frame in index["frames"]] == [f"frames/{index:03d}_frame_{index:02d}.png" for index in range(20)]
    assert [animation["frames"][0]["frameId"] for animation in index["animations"][:2]] == ["frame_00", "frame_01"]
    assert len([path for path in exported if path.endswith(".png")]) == 20
    validate_export_bundle(data, document, "character", "version1", "frames")


def test_sheet_export_has_layout_and_uniform_regions():
    document = complete_character()
    exported = files(export_bundle(document, "character", "version1", "sheet"))
    layout = json.loads(exported["layout.json"])
    assert layout["layout"]["cellWidth"] == layout["layout"]["cellHeight"] == 16
    assert (layout["layout"]["columns"], layout["layout"]["rows"]) == (8, 3)
    assert len(layout["layout"]["regions"]) == 20
    assert layout["layout"]["frameOrder"] == [frame.id for frame in document.frames]
    assert Image.open(io.BytesIO(exported["spritesheet.png"])).size == (128, 48)


def test_godot_export_checks_all_animation_references_and_hidden_layer():
    document = complete_character()
    exported = files(export_bundle(document, "character", "version1", "godot"), "pixelart_character/")
    metadata = json.loads(exported["asset.json"])
    assert metadata["layers"][1]["visible"] is False
    assert metadata["animations"] == [animation.model_dump() for animation in document.animations]
    assert '"duration": 0.225000' in exported["spriteframes.tres"].decode("utf-8")


def test_export_preflight_rejects_bad_images_and_ignored_integrity_rule():
    document = complete_character()
    document.frames[0].pixels["base"] = "data:image/png;base64,not-valid"
    with pytest.raises(ValueError, match="导出预检失败"):
        export_bundle(document, "character", "version1", "frames")


def test_export_bundle_rejects_same_size_tampered_pixels_even_with_new_hash():
    document = complete_character()
    original = files(export_bundle(document, "character", "version1", "json"))
    original["frames/frame_00.png"] = png_bytes(Image.new("RGBA", (16, 16)))
    manifest = json.loads(original["manifest.json"])
    manifest["files"]["frames/frame_00.png"] = hashlib.sha256(original["frames/frame_00.png"]).hexdigest()
    original["manifest.json"] = json.dumps(manifest).encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, value in original.items():
            archive.writestr(path, value)
    with pytest.raises(ValueError, match="像素与指定版本不一致"):
        validate_export_bundle(buffer.getvalue(), document, "character", "version1", "json")


def test_export_endpoint_exposes_frames_and_sheet_and_reports_422(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project = client.post("/api/projects", json={"name": "导出测试"}).json()
        asset = client.post(f"/api/projects/{project['id']}/assets/blank", json={"name": "空白", "width": 16, "height": 16}).json()
        for target in ("frames", "sheet"):
            response = client.get(f"/api/assets/{asset['id']}/export", params={"versionId": asset["currentVersionId"], "target": target})
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("application/zip")
        response = client.get(f"/api/assets/{asset['id']}/export", params={"versionId": asset["currentVersionId"], "target": "invalid"})
        assert response.status_code == 422


@pytest.mark.skipif(not os.environ.get("PIXELART_GODOT_COMPAT_BINARY"), reason="Godot compatibility binary not configured")
def test_complete_character_godot_compatibility_roundtrip(tmp_path):
    binary = os.environ["PIXELART_GODOT_COMPAT_BINARY"]
    document = complete_character()
    with zipfile.ZipFile(io.BytesIO(export_bundle(document, "character", "version1", "godot"))) as archive:
        archive.extractall(tmp_path)
    (tmp_path / "project.godot").write_text('config_version=5\n[application]\nconfig/name="PixelArting export verification"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
    (tmp_path / "verify.gd").write_text('''extends SceneTree
func _init():
    var frames = load("res://pixelart_character/spriteframes.tres") as SpriteFrames
    assert(frames != null)
    for direction in ["down", "left", "right", "up"]:
        var idle = "idle_" + direction
        var walk = "walk_" + direction
        assert(frames.has_animation(idle))
        assert(frames.has_animation(walk))
        assert(frames.get_frame_count(idle) == 1)
        assert(frames.get_frame_count(walk) == 4)
        assert(is_equal_approx(frames.get_frame_duration(walk, 0) / frames.get_animation_speed(walk), 0.225))
        assert(frames.get_frame_texture(walk, 0).get_width() == 16)
        assert(frames.get_frame_texture(walk, 0).get_height() == 16)
    print("GODOT_COMPLETE_CHARACTER_OK")
    quit(0)
''')
    imported = subprocess.run([binary, "--headless", "--path", str(tmp_path), "--editor", "--import"], capture_output=True, text=True, timeout=90)
    assert imported.returncode == 0, imported.stdout + imported.stderr
    result = subprocess.run([binary, "--headless", "--path", str(tmp_path), "--script", "verify.gd"], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "GODOT_COMPLETE_CHARACTER_OK" in result.stdout
