import io
import os
import subprocess
import zipfile

import pytest

from backend.exports import export_bundle
from backend.models import Animation, FrameRef
from backend.sample import sample_document


@pytest.mark.skipif(not os.environ.get("PIXELART_GODOT_BINARY"), reason="Godot 4.7.2 binary not configured")
def test_godot_472_import_roundtrip(tmp_path):
    binary = os.environ["PIXELART_GODOT_BINARY"]
    version = subprocess.run([binary, "--version"], check=True, capture_output=True, text=True).stdout
    assert version.startswith("4.7.2.")
    document = sample_document()
    document.animations = [Animation(action="idle", direction="down", frames=[FrameRef(frameId="frame_0", durationMs=200), FrameRef(frameId="frame_0", durationMs=400)])]
    with zipfile.ZipFile(io.BytesIO(export_bundle(document, "roundtrip", "version1", "godot"))) as archive:
        archive.extractall(tmp_path)
    (tmp_path / "project.godot").write_text('config_version=5\n[application]\nconfig/name="PixelArting verification"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
    (tmp_path / "verify.gd").write_text('''extends SceneTree
func _init():
    var frames = load("res://pixelart_roundtrip/spriteframes.tres") as SpriteFrames
    assert(frames != null)
    assert(frames.has_animation("idle_down"))
    assert(frames.get_frame_count("idle_down") == 2)
    assert(is_equal_approx(frames.get_frame_duration("idle_down", 0) / frames.get_animation_speed("idle_down"), 0.2))
    assert(is_equal_approx(frames.get_frame_duration("idle_down", 1) / frames.get_animation_speed("idle_down"), 0.4))
    assert(frames.get_frame_texture("idle_down", 0).get_width() == 64)
    assert(frames.get_frame_texture("idle_down", 0).get_height() == 64)
    print("GODOT_ROUNDTRIP_OK")
    quit(0)
''')
    imported = subprocess.run([binary, "--headless", "--path", str(tmp_path), "--editor", "--import"], capture_output=True, text=True, timeout=90)
    assert imported.returncode == 0, imported.stdout + imported.stderr
    result = subprocess.run([binary, "--headless", "--path", str(tmp_path), "--script", "verify.gd"], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "GODOT_ROUNDTRIP_OK" in result.stdout
    assert "ERROR:" not in result.stderr
