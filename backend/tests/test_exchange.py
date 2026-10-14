import copy
import hashlib
import io
import json
import random
import sqlite3
import stat
import zipfile

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import app as app_module
from backend import exchange
from backend.app import create_app
from backend.images import checksum, encode_image
from backend.models import Animation, Document, Frame, FrameRef, Layer, Point, Rect


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as value:
        yield value


def rich_asset(client, project=None, name="Layered sprite"):
    project = project or client.post("/api/projects", json={"name": "Exchange project"}).json()
    document = Document(
        name=name, type="character", layers=[Layer(id="base", name="Body"), Layer(id="gear", name="Equipment", visible=False, locked=True, opacity=73)],
        frames=[Frame(id=f"frame_{index}", width=4, height=3,
            pixels={"base": encode_image(Image.new("RGBA", (4, 3), (200, index * 40, 50, 255))), "gear": encode_image(Image.new("RGBA", (4, 3), (50, 100, index * 40, 128)))},
            origin=Point(x=1, y=2), baselineY=2, collisionRects=[Rect(x=1, y=0, width=2, height=3)]) for index in range(2)],
        animations=[Animation(action="idle", direction="down", frames=[FrameRef(frameId="frame_1", durationMs=350), FrameRef(frameId="frame_0", durationMs=100), FrameRef(frameId="frame_1", durationMs=500)], loop=False)],
        provenance={"kind": "original", "licenseStatus": "original"},
    )
    return project, client.app.state.store.create_asset(project["id"], document)


def bundle(client, asset, target="json"):
    response = client.get(f'/api/assets/{asset["id"]}/export', params={"versionId": asset["currentVersionId"], "target": target})
    assert response.status_code == 200
    return response.content


def members(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def repack(files, rehash=False):
    files = dict(files)
    if rehash:
        manifest = json.loads(files["manifest.json"])
        manifest["files"] = {name: hashlib.sha256(value).hexdigest() for name, value in files.items() if name != "manifest.json"}
        files["manifest.json"] = json.dumps(manifest).encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return output.getvalue()


def import_asset(client, project, data):
    return client.post(f'/api/projects/{project["id"]}/assets/import-bundle', files={"file": ("asset.zip", data, "application/zip")})


@pytest.mark.parametrize("target", ["json", "godot"])
def test_exported_bundle_round_trip_preserves_every_editable_field(client, target):
    project, source = rich_asset(client)
    imported_response = import_asset(client, project, bundle(client, source, target))
    assert imported_response.status_code == 201
    imported = imported_response.json()
    assert imported["id"] != source["id"]
    assert imported["currentVersionId"] != source["currentVersionId"]
    assert imported["name"] == source["name"] + " 副本"
    assert len(imported["versions"]) == 1
    assert imported["versions"][0]["operation"] == "import"
    for key in ("layers", "frames", "animations", "type"):
        assert imported["document"][key] == source["document"][key]
    assert imported["document"]["provenance"]["licenseStatus"] == "original"
    assert imported["document"]["provenance"]["importedFrom"]["assetId"] == source["id"]
    expected = client.get(f'/api/assets/{source["id"]}/export', params={"versionId": source["currentVersionId"], "frameId": "frame_1"}).content
    actual = client.get(f'/api/assets/{imported["id"]}/export', params={"versionId": imported["currentVersionId"], "frameId": "frame_1"}).content
    assert actual == expected
    assert client.get(f'/api/assets/{source["id"]}').json() == source


@pytest.mark.parametrize("unsafe", ["../escape.png", "/absolute.png", "C:/drive.png", "nested\\file.png", "nested//file.png", "nested/./file.png"])
def test_unsafe_paths_do_not_create_assets_or_write_archive_paths(client, unsafe):
    project, source = rich_asset(client)
    files = members(bundle(client, source))
    files[unsafe] = b"unsafe"
    before = set(client.app.state.store.root.rglob("*"))
    assert import_asset(client, project, repack(files)).status_code == 422
    assert len(client.get(f'/api/projects/{project["id"]}/assets').json()) == 1
    assert set(client.app.state.store.root.rglob("*")) == before


def test_links_duplicate_entries_and_corrupt_zip_are_rejected(client):
    project, source = rich_asset(client)
    data = bundle(client, source)
    output = io.BytesIO(data)
    with zipfile.ZipFile(output, "a") as archive:
        link = zipfile.ZipInfo("link.png"); link.create_system = 3; link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(link, "../../outside")
    assert import_asset(client, project, output.getvalue()).status_code == 422
    duplicate = io.BytesIO(data)
    with pytest.warns(UserWarning), zipfile.ZipFile(duplicate, "a") as archive:
        archive.writestr("asset.json", b"{}")
    assert import_asset(client, project, duplicate.getvalue()).status_code == 422
    assert import_asset(client, project, b"not a zip").status_code == 422
    assert import_asset(client, project, data[:30]).status_code == 422


@pytest.mark.parametrize("failure", ["manifest", "missing", "checksum", "document-checksum", "invalid-image", "external-reference", "invalid-animation"])
def test_invalid_bundles_leave_no_partial_asset(client, failure):
    project, source = rich_asset(client)
    files = members(bundle(client, source))
    if failure == "manifest":
        files.pop("manifest.json")
    elif failure == "missing":
        files.pop("layers/gear/frame_1.png")
    elif failure == "checksum":
        files["layers/base/frame_0.png"] += b"changed"
    elif failure == "invalid-image":
        files["layers/base/frame_0.png"] = b"bad png"
    else:
        metadata = json.loads(files["asset.json"])
        if failure == "document-checksum": metadata["frames"][0]["baselineY"] = 0
        elif failure == "external-reference": metadata["frames"][0]["pixels"]["base"] = "../outside.png"
        elif failure == "invalid-animation": metadata["animations"][0]["frames"][0]["frameId"] = "missing"
        files["asset.json"] = json.dumps(metadata).encode()
    data = repack(files, rehash=failure in {"document-checksum", "invalid-image", "external-reference", "invalid-animation"})
    assert import_asset(client, project, data).status_code == 422
    assert len(client.get(f'/api/projects/{project["id"]}/assets').json()) == 1
    with client.app.state.store.connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM versions").fetchone()[0] == 1


def test_file_count_member_size_and_total_expansion_are_bounded(client, monkeypatch):
    project, source = rich_asset(client)
    data = bundle(client, source)
    files = members(data)
    for setting, value in [("MAX_ARCHIVE_FILES", 2), ("MAX_CENTRAL_DIRECTORY_BYTES", 100), ("MAX_MEMBER_BYTES", 100), ("MAX_EXPANDED_BYTES", sum(map(len, files.values())) - 1), ("MAX_METADATA_BYTES", 10)]:
        with monkeypatch.context() as scoped:
            scoped.setattr(exchange, setting, value)
            assert import_asset(client, project, data).status_code == 422
    assert len(client.get(f'/api/projects/{project["id"]}/assets').json()) == 1


def test_archive_limit_and_scoped_http_body_limit_are_enforced(client, monkeypatch):
    with pytest.raises(ValueError, match="128 MB"):
        exchange.import_bundle(bytes(exchange.MAX_ARCHIVE_BYTES + 1))
    monkeypatch.setattr(app_module, "MAX_ARCHIVE_BYTES", 1024)
    response = client.post("/api/projects/import-backup", content=b"x" * (1024 * 1024 + 1025), headers={"Content-Type": "application/octet-stream"})
    assert response.status_code == 413
    assert client.get("/api/projects").json() == []


def test_a_real_export_larger_than_legacy_20mb_can_be_imported(client):
    project = client.post("/api/projects", json={"name": "Large package"}).json()
    generator = random.Random(17)
    document = Document(name="Large asset", layers=[Layer(id="base", name="Base")], frames=[
        Frame(id=f"frame_{index}", width=512, height=512, pixels={"base": encode_image(Image.frombytes("RGBA", (512, 512), generator.randbytes(512 * 512 * 4)))}) for index in range(8)
    ])
    source = client.app.state.store.create_asset(project["id"], document)
    data = bundle(client, source)
    assert len(data) > 20 * 1024 * 1024
    response = import_asset(client, project, data)
    assert response.status_code == 201
    imported = Document.model_validate(response.json()["document"])
    imported.name = document.name
    assert checksum(imported) == checksum(document)


def test_project_backup_recovers_current_assets_and_config_into_an_independent_project(client):
    project, first = rich_asset(client)
    _, second = rich_asset(client, project, "Second asset")
    config = client.put(f'/api/projects/{project["id"]}/check-config', json={"targetWidth": 4, "targetHeight": 3, "palette": ["#AABBCC"], "maxColors": 7, "baselineTolerancePx": 2, "expectedWalkFrames": 6, "exportTarget": "godot"}).json()
    updated = copy.deepcopy(first["document"]); updated["name"] = "Current asset"
    first = client.post(f'/api/assets/{first["id"]}/save', json={"expectedCurrentVersionId": first["currentVersionId"], "document": updated}).json()
    assert len(first["versions"]) == 2
    data = client.get(f'/api/projects/{project["id"]}/backup')
    assert data.status_code == 200
    assert data.headers["content-type"] == "application/zip"
    assert json.loads(members(data.content)["project.json"])["scope"] == "current-versions"
    response = client.post("/api/projects/import-backup", files={"file": ("backup.zip", data.content, "application/zip")})
    assert response.status_code == 201
    restored = response.json()
    assert restored["id"] != project["id"]
    assert restored["name"] == project["name"]
    assert client.get(f'/api/projects/{restored["id"]}/check-config').json() == config
    assets = client.get(f'/api/projects/{restored["id"]}/assets').json()
    assert {item["name"] for item in assets} == {first["name"], second["name"]}
    originals = {item["name"]: item for item in (first, second)}
    for item in assets:
        current = client.get(f'/api/assets/{item["id"]}').json()
        assert current["id"] not in {first["id"], second["id"]}
        assert len(current["versions"]) == 1
        for key in ("name", "layers", "frames", "animations"):
            assert current["document"][key] == originals[item["name"]]["document"][key]
    assert len(client.get(f'/api/projects/{project["id"]}/assets').json()) == 2
    with TestClient(create_app(client.app.state.store.root)) as restarted:
        assert restarted.get(f'/api/projects/{restored["id"]}/check-config').json() == config
        assert len(restarted.get(f'/api/projects/{restored["id"]}/assets').json()) == 2


def test_invalid_second_backup_asset_does_not_create_a_partial_project(client):
    project, _ = rich_asset(client)
    rich_asset(client, project, "Second asset")
    files = members(client.get(f'/api/projects/{project["id"]}/backup').content)
    paths = json.loads(files["project.json"])["assets"]
    prefix = paths[1]["path"][:-len("asset.json")]
    changed = json.loads(files[prefix + "asset.json"])
    changed["animations"][0]["frames"][0]["frameId"] = "missing"
    files[prefix + "asset.json"] = json.dumps(changed).encode()
    inner = {name[len(prefix):]: content for name, content in files.items() if name.startswith(prefix)}
    files[prefix + "manifest.json"] = members(repack(inner, rehash=True))["manifest.json"]
    bad = repack(files, rehash=True)
    before = client.get("/api/projects").json()
    response = client.post("/api/projects/import-backup", files={"file": ("backup.zip", bad, "application/zip")})
    assert response.status_code == 422
    assert client.get("/api/projects").json() == before
    assert len(client.get(f'/api/projects/{project["id"]}/assets').json()) == 2


@pytest.mark.parametrize("invalid", ["config", "format", "scope", "duplicate-asset", "unlisted-file", "checksum"])
def test_backup_schema_and_inventory_validation_are_atomic(client, invalid):
    project, _ = rich_asset(client)
    files = members(client.get(f'/api/projects/{project["id"]}/backup').content)
    metadata = json.loads(files["project.json"])
    if invalid == "config": metadata["config"]["palette"] = ["not a color"]
    elif invalid == "format": metadata["formatVersion"] = 2
    elif invalid == "scope": metadata["scope"] = "full-history"
    elif invalid == "duplicate-asset": metadata["assets"].append(metadata["assets"][0])
    elif invalid == "unlisted-file": files["unlisted/file.png"] = b"unexpected"
    files["project.json"] = json.dumps(metadata).encode()
    data = repack(files, rehash=invalid != "checksum")
    before = client.get("/api/projects").json()
    response = client.post("/api/projects/import-backup", files={"file": ("backup.zip", data, "application/zip")})
    assert response.status_code == 422
    assert client.get("/api/projects").json() == before


def test_backup_resource_limits_fail_without_emitting_unrestorable_packages(client, monkeypatch):
    project, _ = rich_asset(client)
    rich_asset(client, project, "Second asset")
    with monkeypatch.context() as scoped:
        scoped.setattr(app_module, "MAX_PROJECT_ASSETS", 1)
        assert client.get(f'/api/projects/{project["id"]}/backup').status_code == 422
    with monkeypatch.context() as scoped:
        scoped.setattr(exchange, "MAX_PROJECT_PIXELS", 1)
        assert client.get(f'/api/projects/{project["id"]}/backup').status_code == 422
    assert len(client.get(f'/api/projects/{project["id"]}/assets').json()) == 2


def test_project_restore_transaction_rolls_back_database_failures(client):
    project, source = rich_asset(client)
    store = client.app.state.store
    before = store.list_projects()
    with store.connection() as connection:
        connection.execute("CREATE TRIGGER fail_asset BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        store.restore_project("Failed restore", exchange.CheckConfig(), [Document.model_validate(source["document"])])
    assert store.list_projects() == before
    with store.connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM project_configs").fetchone()[0] == 1


def test_empty_project_config_can_be_backed_up_and_missing_project_is_rejected(client):
    project = client.post("/api/projects", json={"name": "Empty project"}).json()
    config = client.put(f'/api/projects/{project["id"]}/check-config', json={"maxColors": 9}).json()
    data = client.get(f'/api/projects/{project["id"]}/backup').content
    restored = client.post("/api/projects/import-backup", files={"file": ("backup.zip", data, "application/zip")}).json()
    assert client.get(f'/api/projects/{restored["id"]}/check-config').json() == config
    assert client.get(f'/api/projects/{restored["id"]}/assets').json() == []
    assert client.get("/api/projects/missing/backup").status_code == 404
    project, source = rich_asset(client)
    assert import_asset(client, {"id": "missing"}, bundle(client, source)).status_code == 404
