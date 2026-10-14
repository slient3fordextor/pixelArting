import hashlib
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.images import MAX_UPLOAD_BYTES, decode_image, png_bytes


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as value:
        yield value


def project(client):
    return client.post("/api/projects", json={"name": "Import project"}).json()["id"]


def sheet():
    layout = {"cellWidth": 4, "cellHeight": 3, "marginX": 1, "marginY": 2, "spacingX": 2, "spacingY": 1, "rows": 2, "columns": 3}
    image = Image.new("RGBA", (18, 11), (255, 0, 255, 255))
    for index in range(6):
        x, y = 1 + (index % 3) * 6, 2 + (index // 3) * 4
        image.paste((index * 30, 100, 200, 255), (x, y, x + 4, y + 3))
    return png_bytes(image), layout


def post_png(client, path, data, fields=None):
    return client.post(path, files={"file": ("sprite.png", data, "image/png")}, data=fields or {})


def test_preview_precisely_slices_margins_spacing_without_creating_assets(client):
    project_id = project(client)
    data, layout = sheet()
    response = post_png(client, f"/api/projects/{project_id}/imports/preview", data, layout)
    assert response.status_code == 200
    preview = response.json()
    assert preview["layout"] == layout
    assert preview["source"]["width"] == 18
    assert preview["source"]["height"] == 11
    assert preview["source"]["checksum"] == hashlib.sha256(data).hexdigest()
    assert preview["frames"][3]["rect"] == {"x": 1, "y": 6, "width": 4, "height": 3}
    for index, frame in enumerate(preview["frames"]):
        assert frame["frameId"] == f"frame_{index}"
        assert (frame["row"], frame["column"]) == (index // 3, index % 3)
        cropped = decode_image(frame["image"])
        assert cropped.size == (4, 3)
        assert cropped.tobytes() == bytes((index * 30, 100, 200, 255)) * 12
    assert client.get(f"/api/projects/{project_id}/assets").json() == []
    with client.app.state.store.connection() as connection:
        for table in ("assets", "versions", "previews", "reports"):
            assert connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
    original = client.app.state.store.root / preview["source"]["originalRef"]
    assert original.read_bytes() == data


def test_automatic_rows_and_columns_require_exact_coverage(client):
    project_id = project(client)
    data, layout = sheet()
    automatic = {**layout, "rows": 0, "columns": 0}
    response = post_png(client, f"/api/projects/{project_id}/imports/preview", data, automatic)
    assert response.status_code == 200
    assert response.json()["layout"] == layout


@pytest.mark.parametrize("changed", [
    {"cellWidth": 5}, {"cellHeight": 0}, {"marginX": 2}, {"marginY": 6},
    {"spacingX": 1}, {"rows": 1}, {"columns": 2}, {"rows": -1},
])
def test_invalid_layout_preserves_source_for_retry_without_assets(client, changed):
    project_id = project(client)
    data, layout = sheet()
    path = f"/api/projects/{project_id}/imports/preview"
    assert post_png(client, path, data, {**layout, **changed}).status_code == 422
    source = client.app.state.store.root / "sources" / f"{hashlib.sha256(data).hexdigest()}.png"
    assert source.read_bytes() == data
    assert client.get(f"/api/projects/{project_id}/assets").json() == []
    assert post_png(client, path, data, layout).status_code == 200


def test_confirmed_mapping_creates_character_with_row_major_animation_order(client):
    project_id = project(client)
    data, layout = sheet()
    mapping = [
        {"frameIndex": 4, "action": "walk", "direction": "down", "durationMs": 80},
        {"frameIndex": 3, "action": "walk", "direction": "down", "durationMs": 120},
        {"frameIndex": 0, "action": "idle", "direction": "up"},
        {"frameIndex": 1, "action": "idle", "direction": "up", "durationMs": 400},
    ]
    response = post_png(client, f"/api/projects/{project_id}/assets", data, {
        **layout, "name": "Mapped sprite", "mapping": json.dumps(mapping), "mappingConfirmed": "true",
    })
    assert response.status_code == 201
    asset = response.json()
    document = asset["document"]
    assert document["type"] == "character"
    assert document["name"] == "Mapped sprite"
    animations = {(item["action"], item["direction"]): item for item in document["animations"]}
    assert animations[("walk", "down")]["frames"] == [
        {"frameId": "frame_3", "durationMs": 120}, {"frameId": "frame_4", "durationMs": 80},
    ]
    assert animations[("idle", "up")]["frames"] == [
        {"frameId": "frame_0", "durationMs": 200}, {"frameId": "frame_1", "durationMs": 400},
    ]
    assert all(animation["loop"] for animation in document["animations"])
    assert len(document["frames"]) == 6
    assert document["provenance"]["sheetLayout"] == layout
    assert document["provenance"]["originalChecksum"] == hashlib.sha256(data).hexdigest()
    assert [item["frameIndex"] for item in document["provenance"]["importMapping"]] == [0, 1, 3, 4]
    assert len(asset["versions"]) == 1


@pytest.mark.parametrize("mapping,confirmed", [
    ([{"frameIndex": 0, "action": "idle", "direction": "up"}], False),
    ([{"frameIndex": 6, "action": "idle", "direction": "up"}], True),
    ([{"frameIndex": 0, "action": "run", "direction": "up"}], True),
    ([{"frameIndex": 0, "action": "idle", "direction": "up", "durationMs": 0}], True),
    ([{"frameIndex": 0, "action": "idle", "direction": "up"}] * 2, True),
    ("not JSON", True),
])
def test_invalid_or_unconfirmed_mapping_never_creates_asset(client, mapping, confirmed):
    project_id = project(client)
    data, layout = sheet()
    fields = {**layout, "mapping": json.dumps(mapping) if isinstance(mapping, list) else mapping, "mappingConfirmed": str(confirmed).lower()}
    assert post_png(client, f"/api/projects/{project_id}/assets", data, fields).status_code == 422
    assert client.get(f"/api/projects/{project_id}/assets").json() == []


def test_plain_png_and_legacy_sheet_upload_still_work(client):
    project_id = project(client)
    path = f"/api/projects/{project_id}"
    data = png_bytes(Image.new("RGBA", (16, 8), (1, 2, 3, 255)))
    preview = post_png(client, path + "/imports/preview", data).json()
    assert len(preview["frames"]) == 1
    assert preview["layout"]["cellWidth"] == 16
    assert preview["layout"]["cellHeight"] == 8
    single = post_png(client, path + "/assets", data).json()["document"]
    assert single["type"] == "image"
    assert single["animations"] == []
    cut = post_png(client, path + "/assets", data, {"cellWidth": 8, "cellHeight": 8}).json()["document"]
    assert len(cut["frames"]) == 2
    assert cut["provenance"]["sheetLayout"]["columns"] == 2


def test_import_limits_and_missing_project_do_not_retain_rejected_input(client):
    project_id = project(client)
    path = f"/api/projects/{project_id}/imports/preview"
    invalid = post_png(client, path, b"not a png")
    assert invalid.status_code == 422
    oversized = post_png(client, path, b"x" * (MAX_UPLOAD_BYTES + 1))
    assert oversized.status_code == 422
    data = png_bytes(Image.new("RGBA", (8, 8)))
    assert post_png(client, "/api/projects/missing/imports/preview", data).status_code == 404
    assert not (client.app.state.store.root / "sources").exists()
    too_many = png_bytes(Image.new("RGBA", (65, 1)))
    assert post_png(client, path, too_many, {"cellWidth": 1, "cellHeight": 1}).status_code == 422
    assert client.get(f"/api/projects/{project_id}/assets").json() == []
