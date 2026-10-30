import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.images import encode_image, png_bytes


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as value:
        yield value


def upload(client, image=None, fields=None):
    project = client.post("/api/projects", json={"name": "测试项目"}).json()
    return client.post(f'/api/projects/{project["id"]}/assets', files={"file": ("sprite.png", png_bytes(image or Image.new("RGBA", (64, 64), (255, 0, 0, 128))), "image/png")}, data=fields or {})


def test_upload_check_preview_commit_and_restore(client):
    response = upload(client)
    assert response.status_code == 201
    asset = response.json()
    path = f'/api/assets/{asset["id"]}'
    body = {"versionId": asset["currentVersionId"]}
    report = client.post(path + "/check", json=body).json()
    assert any(f["ruleId"] == "transparency.halo" for f in report["findings"])
    preview = client.post(path + "/preview", json={**body, "actions": [{"id": "remove-halo-v1"}]}).json()
    assert preview["changes"][0]["changedPixels"] == 4096
    commit = {"previewId": preview["previewId"], "expectedCurrentVersionId": asset["currentVersionId"]}
    saved = client.post(path + "/commit", json=commit)
    assert saved.status_code == 200
    assert saved.json()["report"]["findings"] == []
    assert client.post(path + "/commit", json=commit).json()["resultVersionId"] == saved.json()["resultVersionId"]
    assert client.post(path + "/save", json={"document": asset["document"], "expectedCurrentVersionId": asset["currentVersionId"]}).status_code == 409
    restored = client.post(path + "/restore", json={"versionId": asset["currentVersionId"], "expectedCurrentVersionId": saved.json()["resultVersionId"]})
    assert restored.status_code == 200


def test_multilayer_save_and_export(client):
    asset = upload(client, Image.new("RGBA", (64, 64), (255, 0, 0, 255))).json()
    doc = asset["document"]
    doc["layers"].append({"id": "top", "name": "上层", "visible": False, "locked": False, "opacity": 128})
    doc["frames"][0]["pixels"]["top"] = encode_image(Image.new("RGBA", (64, 64), (0, 0, 255, 255)))
    path = f'/api/assets/{asset["id"]}'
    saved = client.post(path + "/save", json={"document": doc, "expectedCurrentVersionId": asset["currentVersionId"]})
    assert saved.status_code == 200
    version = saved.json()["currentVersionId"]
    png = client.get(path + "/export", params={"versionId": version, "target": "png"})
    assert Image.open(io.BytesIO(png.content)).getpixel((0, 0)) == (255, 0, 0, 255)
    package = client.get(path + "/export", params={"versionId": version, "target": "json"})
    with zipfile.ZipFile(io.BytesIO(package.content)) as archive:
        exported = json.loads(archive.read("asset.json"))
        assert exported["layers"][1]["opacity"] == 128
        assert archive.read("layers/top/frame_0.png").startswith(b"\x89PNG")


def test_sheet_cut_and_invalid_layout(client):
    image = Image.new("RGBA", (128, 64))
    response = upload(client, image, {"cellWidth": 64, "cellHeight": 64})
    assert response.status_code == 201
    assert len(response.json()["document"]["frames"]) == 2
    assert upload(client, image, {"cellWidth": 63, "cellHeight": 64}).status_code == 422


def test_validation_limits_and_foreign_versions(client):
    assert client.post("/api/projects", json={"name": ""}).status_code == 422
    project = client.post("/api/projects", json={"name": "测试"}).json()
    assert client.post(f'/api/projects/{project["id"]}/assets', files={"file": ("bad.png", b"not a png", "image/png")}).status_code == 422
    first, second = upload(client).json(), upload(client).json()
    assert client.get(f'/api/assets/{first["id"]}/versions/{second["currentVersionId"]}').status_code == 404
    doc = first["document"]
    doc["frames"][0]["pixels"]["missing"] = doc["frames"][0]["pixels"]["base"]
    assert client.post(f'/api/assets/{first["id"]}/save', json={"document": doc, "expectedCurrentVersionId": first["currentVersionId"]}).status_code == 422


def test_godot_requires_mapping_and_untrusted_origin_blocked(client):
    asset = upload(client).json()
    response = client.get(f'/api/assets/{asset["id"]}/export', params={"versionId": asset["currentVersionId"], "target": "godot"})
    assert response.status_code == 422
    assert client.post("/api/projects", json={"name": "external"}, headers={"Origin": "https://example.invalid"}).status_code == 403


def test_invalid_rule_config_rejected(client):
    asset = upload(client).json()
    response = client.post(f'/api/assets/{asset["id"]}/check', json={"versionId": asset["currentVersionId"], "config": {"enabled": {"unknown": True}}})
    assert response.status_code == 422


def test_create_blank_asset_and_validate_dimensions(client):
    project = client.post("/api/projects", json={"name": "空白素材项目"}).json()
    path = f'/api/projects/{project["id"]}/assets/blank'
    response = client.post(path, json={"name": "手绘角色", "width": 64, "height": 48})
    assert response.status_code == 201
    asset = response.json()
    assert asset["document"]["provenance"] == {"kind": "created"}
    assert len(asset["document"]["layers"]) == 1
    exported = client.get(f'/api/assets/{asset["id"]}/export', params={"versionId": asset["currentVersionId"]})
    image = Image.open(io.BytesIO(exported.content))
    assert image.size == (64, 48)
    assert image.getbbox() is None
    assert client.post(path, json={"width": 0}).status_code == 422
    assert client.post(path, json={"height": 513}).status_code == 422
    assert client.post("/api/projects/missing/assets/blank", json={}).status_code == 404


def test_library_only_collects_explicit_snapshots_and_survives_source_project_deletion(client):
    source_project = client.post("/api/projects", json={"name": "素材来源项目"}).json()
    target_project = client.post("/api/projects", json={"name": "复用目标项目"}).json()
    source = client.post(f'/api/projects/{source_project["id"]}/assets/blank', json={"name": "可复用角色", "width": 16, "height": 16}).json()
    # Creating, uploading and copying all remain ordinary project work.
    uploaded = upload(client).json()
    client.post(f'/api/projects/{target_project["id"]}/assets/copy', json={"sourceAssetId": uploaded["id"]})
    assert client.get("/api/assets/library").json() == []

    document = source["document"]
    document["layers"][0]["locked"] = True
    document["frames"][0]["pixels"]["base"] = encode_image(Image.new("RGBA", (16, 16), (1, 2, 3, 255)))
    source = client.post(f'/api/assets/{source["id"]}/save', json={"expectedCurrentVersionId": source["currentVersionId"], "document": document}).json()
    path = f'/api/assets/{source["id"]}/library'
    assert client.post(path, json={"expectedCurrentVersionId": "stale"}).status_code == 409
    assert client.get("/api/assets/library").json() == []
    body = {"expectedCurrentVersionId": source["currentVersionId"]}
    collected = client.post(path, json=body)
    assert collected.status_code == 201
    entry = collected.json()
    assert client.post(path, json=body).json()["id"] == entry["id"]
    library = client.get("/api/assets/library").json()
    assert len(library) == 1
    assert library[0]["sourceAssetId"] == source["id"]
    assert library[0]["projectName"] == "素材来源项目"
    assert (library[0]["width"], library[0]["height"], library[0]["frameCount"]) == (16, 16, 1)
    assert "document" not in library[0]

    # Later saves and deletions never mutate the collected snapshot.
    document["frames"][0]["pixels"]["base"] = encode_image(Image.new("RGBA", (16, 16), (9, 8, 7, 255)))
    updated = client.post(f'/api/assets/{source["id"]}/save', json={**body, "document": document}).json()
    assert client.request("DELETE", f'/api/projects/{source_project["id"]}', json={"expectedName": source_project["name"], "expectedCurrentVersions": {source["id"]: updated["currentVersionId"]}}).status_code == 200
    thumbnail = client.get(f'/api/library/{entry["id"]}/thumbnail')
    assert thumbnail.status_code == 200
    assert Image.open(io.BytesIO(thumbnail.content)).getpixel((0, 0)) == (1, 2, 3, 255)
    copied = client.post(f'/api/projects/{target_project["id"]}/library/{entry["id"]}/use').json()
    assert copied["projectId"] == target_project["id"]
    assert copied["document"]["layers"][0]["locked"] is True
    assert copied["document"]["frames"][0]["pixels"]["base"] == source["document"]["frames"][0]["pixels"]["base"]
    assert copied["document"]["provenance"]["libraryEntryId"] == entry["id"]
    assert len(client.get("/api/assets/library").json()) == 1
    assert client.request("DELETE", f'/api/library/{entry["id"]}', json={"expectedCurrentVersionId": "stale"}).status_code == 409
    assert client.request("DELETE", f'/api/library/{entry["id"]}', json=body).status_code == 200
    assert client.get("/api/assets/library").json() == []
    assert client.get(f'/api/assets/{copied["id"]}').status_code == 200
    assert client.post(f'/api/projects/{target_project["id"]}/library/{entry["id"]}/use').status_code == 404


def test_thumbnail_and_asset_deletion_are_versioned_and_isolated(client):
    first, second = upload(client, Image.new("RGBA", (128, 64), (255, 0, 0, 255))).json(), upload(client).json()
    path = f'/api/assets/{first["id"]}'
    old_version = first["currentVersionId"]
    thumbnail = client.get(path + "/thumbnail", params={"versionId": old_version})
    image = Image.open(io.BytesIO(thumbnail.content))
    assert image.size == (96, 48)
    assert image.getpixel((0, 0)) == (255, 0, 0, 255)
    assert "immutable" in thumbnail.headers["Cache-Control"]
    assert client.get(path + "/thumbnail", params={"versionId": second["currentVersionId"]}).status_code == 404
    listed = client.get(f'/api/projects/{first["projectId"]}/assets').json()[0]
    assert (listed["frameCount"], listed["layerCount"], listed["width"], listed["height"]) == (1, 1, 128, 64)

    document = first["document"]
    document["name"] = "更新后的素材"
    saved = client.post(path + "/save", json={"expectedCurrentVersionId": old_version, "document": document}).json()
    new_version = saved["currentVersionId"]
    client.post(path + "/check", json={"versionId": new_version})
    client.post(path + "/preview", json={"versionId": new_version, "actions": [{"id": "resize-nearest-v1"}]})
    assert client.request("DELETE", path, json={"expectedCurrentVersionId": old_version}).status_code == 409
    assert client.get(path).status_code == 200
    assert client.request("DELETE", path, json={"expectedCurrentVersionId": new_version}).status_code == 200
    assert client.get(path).status_code == 404
    assert client.get(path + "/versions/" + old_version).status_code == 404
    assert client.get(path + "/thumbnail", params={"versionId": new_version}).status_code == 404
    assert client.get(f'/api/projects/{first["projectId"]}/assets').json() == []
    assert client.get(f'/api/assets/{second["id"]}').status_code == 200
    with client.app.state.store.connection() as connection:
        for table in ("versions", "reports", "previews"):
            assert connection.execute(f"SELECT COUNT(*) FROM {table} WHERE asset_id=?", (first["id"],)).fetchone()[0] == 0


def test_asset_copy_snapshot_rename_and_name_collision(client):
    project = client.post("/api/projects", json={"name": "复制项目"}).json()
    source = client.post(f'/api/projects/{project["id"]}/assets/blank', json={"name": "角色"}).json()
    document = source["document"]
    document["layers"][0]["locked"] = True
    document["frames"][0]["pixels"]["base"] = encode_image(Image.new("RGBA", (64, 64), (1, 2, 3, 255)))
    saved = client.post(f'/api/assets/{source["id"]}/save', json={"expectedCurrentVersionId": source["currentVersionId"], "document": document}).json()
    copied = client.post(f'/api/projects/{project["id"]}/assets/copy', json={"sourceAssetId": source["id"], "versionId": saved["currentVersionId"]})
    assert copied.status_code == 201
    copy = copied.json()
    assert copy["name"] == "角色 副本"
    assert copy["document"]["layers"][0]["locked"] is True
    assert copy["document"]["frames"][0]["pixels"]["base"] == document["frames"][0]["pixels"]["base"]
    assert copy["document"]["provenance"]["copiedFrom"]["assetId"] == source["id"]

    second_copy = client.post(f'/api/projects/{project["id"]}/assets/copy', json={"sourceAssetId": source["id"], "versionId": saved["currentVersionId"]}).json()
    assert second_copy["name"] == "角色 副本 2"
    assert client.request("DELETE", f'/api/assets/{source["id"]}', json={"expectedCurrentVersionId": saved["currentVersionId"]}).status_code == 200

    pasted_document = copy["document"]
    pasted_document["name"] = "角色"
    pasted = client.post(f'/api/projects/{project["id"]}/assets/copy', json={"document": pasted_document})
    assert pasted.status_code == 201
    assert pasted.json()["name"] == "角色"

    renamed = client.post(f'/api/assets/{copy["id"]}/rename', json={"expectedCurrentVersionId": copy["currentVersionId"], "name": "角色副本"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "角色副本"
    assert renamed.json()["versions"][0]["operation"] == "rename"
    assert client.post(f'/api/assets/{copy["id"]}/rename', json={"expectedCurrentVersionId": copy["currentVersionId"], "name": "旧版本改名"}).status_code == 409
