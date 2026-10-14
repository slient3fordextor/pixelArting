import copy
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.images import png_bytes
from backend.store import Conflict, Store


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as value:
        yield value


def project(client, name="Project"):
    return client.post("/api/projects", json={"name": name}).json()


def historical_asset(client, owner, name="Asset"):
    image = png_bytes(Image.new("RGBA", (4, 4), (20, 50, 70, 128)))
    asset = client.post(f'/api/projects/{owner["id"]}/assets', files={"file": ("shared.png", image, "image/png")}, data={"name": name}).json()
    path = f'/api/assets/{asset["id"]}'
    client.post(path + "/check", json={"versionId": asset["currentVersionId"]})
    document = copy.deepcopy(asset["document"])
    document["name"] += " updated"
    asset = client.post(path + "/save", json={"expectedCurrentVersionId": asset["currentVersionId"], "document": document}).json()
    client.post(path + "/check", json={"versionId": asset["currentVersionId"]})
    client.post(path + "/preview", json={"versionId": asset["currentVersionId"], "actions": [{"id": "remove-halo-v1"}]})
    return asset


def expected_versions(client, owner):
    return {asset["id"]: asset["currentVersionId"] for asset in client.get(f'/api/projects/{owner["id"]}/assets').json()}


def delete(client, owner, versions=None, expected_name=None):
    return client.request("DELETE", f'/api/projects/{owner["id"]}', json={
        "expectedName": expected_name if expected_name is not None else owner["name"],
        "expectedCurrentVersions": expected_versions(client, owner) if versions is None else versions,
    })


def snapshot(client):
    with client.app.state.store.connection() as connection:
        return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY 1")] for table in ("projects", "project_configs", "assets", "versions", "reports", "previews")}


def test_rename_trims_name_and_preserves_assets_history_configuration_and_other_projects(client):
    owner = project(client)
    other = project(client, "Other")
    historical_asset(client, owner)
    historical_asset(client, other)
    client.put(f'/api/projects/{owner["id"]}/check-config', json={"maxColors": 7})
    before = snapshot(client)
    response = client.put(f'/api/projects/{owner["id"]}', json={"name": "  Renamed project  ", "expectedName": owner["name"]})
    assert response.status_code == 200
    assert response.json() == {**owner, "name": "Renamed project"}
    after = snapshot(client)
    assert [row for row in after["projects"] if row["id"] == other["id"]] == [other]
    for table in ("project_configs", "assets", "versions", "reports", "previews"):
        assert after[table] == before[table]
    with TestClient(create_app(client.app.state.store.root)) as restarted:
        assert response.json() in restarted.get("/api/projects").json()


@pytest.mark.parametrize("name", ["", "   ", "x" * 81, None, 1])
def test_invalid_rename_is_rejected_without_data_changes(client, name):
    owner = project(client)
    before = snapshot(client)
    assert client.put(f'/api/projects/{owner["id"]}', json={"name": name, "expectedName": owner["name"]}).status_code == 422
    assert snapshot(client) == before


def test_rename_accepts_80_trimmed_characters_and_checks_exact_expected_name(client):
    owner = project(client, "  Existing name  ")
    response = client.put(f'/api/projects/{owner["id"]}', json={"name": "  " + "x" * 80 + "  ", "expectedName": owner["name"]})
    assert response.status_code == 200
    assert response.json()["name"] == "x" * 80
    before = snapshot(client)
    assert client.put(f'/api/projects/{owner["id"]}', json={"name": "New", "expectedName": owner["name"].strip()}).status_code == 409
    assert snapshot(client) == before


def test_delete_removes_only_target_records_and_keeps_shared_source_files(client):
    owner, other = project(client, "Delete target"), project(client, "Keep target")
    first = historical_asset(client, owner, "First")
    second = historical_asset(client, owner, "Second")
    foreign = historical_asset(client, other, "Foreign")
    client.put(f'/api/projects/{owner["id"]}/check-config', json={"maxColors": 2})
    client.put(f'/api/projects/{other["id"]}/check-config', json={"maxColors": 7})
    source = client.app.state.store.root / first["document"]["provenance"]["originalRef"]
    assert first["document"]["provenance"]["originalRef"] == foreign["document"]["provenance"]["originalRef"]
    source_bytes = source.read_bytes()
    before = snapshot(client)
    response = delete(client, owner)
    assert response.status_code == 200
    assert response.json() == {"deleted": True, "projectId": owner["id"]}
    assert client.get("/api/projects").json() == [other]
    assert client.get(f'/api/projects/{owner["id"]}/check-config').status_code == 404
    for asset in (first, second):
        assert client.get(f'/api/assets/{asset["id"]}').status_code == 404
        for version in asset["versions"]:
            assert client.get(f'/api/assets/{asset["id"]}/versions/{version["id"]}').status_code == 404
    after = snapshot(client)
    target_ids = {first["id"], second["id"]}
    for table in ("versions", "reports", "previews"):
        assert after[table] == [row for row in before[table] if row["asset_id"] not in target_ids]
    assert client.get(f'/api/assets/{foreign["id"]}').json() == foreign
    assert client.get(f'/api/projects/{other["id"]}/check-config').json()["maxColors"] == 7
    assert source.read_bytes() == source_bytes


def test_empty_project_can_be_deleted_with_an_explicit_empty_snapshot(client):
    owner = project(client)
    assert delete(client, owner, {}).status_code == 200
    assert client.get("/api/projects").json() == []
    assert snapshot(client)["project_configs"] == []


@pytest.mark.parametrize("conflict", ["name", "version", "missing-asset", "foreign-asset", "added-asset", "removed-asset", "renamed-project", "new-version"])
def test_delete_conflicts_preserve_the_complete_database(client, conflict):
    owner, other = project(client), project(client, "Other")
    asset = historical_asset(client, owner)
    foreign = historical_asset(client, other)
    versions = expected_versions(client, owner)
    expected_name = owner["name"]
    if conflict == "name": expected_name = "Wrong name"
    elif conflict == "version": versions[asset["id"]] = asset["versions"][-1]["id"]
    elif conflict == "missing-asset": versions = {}
    elif conflict == "foreign-asset": versions[foreign["id"]] = foreign["currentVersionId"]
    elif conflict == "added-asset": historical_asset(client, owner, "Concurrent addition")
    elif conflict == "removed-asset": client.request("DELETE", f'/api/assets/{asset["id"]}', json={"expectedCurrentVersionId": asset["currentVersionId"]})
    elif conflict == "renamed-project": client.put(f'/api/projects/{owner["id"]}', json={"name": "Concurrent rename", "expectedName": owner["name"]})
    elif conflict == "new-version":
        document = copy.deepcopy(asset["document"]); document["name"] = "Concurrent version"
        client.post(f'/api/assets/{asset["id"]}/save', json={"expectedCurrentVersionId": asset["currentVersionId"], "document": document})
    before = snapshot(client)
    assert delete(client, owner, versions, expected_name).status_code == 409
    assert snapshot(client) == before


@pytest.mark.parametrize("body", [
    {}, {"expectedName": "Project"}, {"expectedName": "", "expectedCurrentVersions": {}},
    {"expectedName": "Project", "expectedCurrentVersions": None}, {"expectedName": "Project", "expectedCurrentVersions": []},
    {"expectedName": "Project", "expectedCurrentVersions": {"asset": None}},
])
def test_delete_requires_a_valid_explicit_confirmation_snapshot(client, body):
    owner = project(client)
    before = snapshot(client)
    assert client.request("DELETE", f'/api/projects/{owner["id"]}', json=body).status_code == 422
    assert snapshot(client) == before


def test_missing_projects_and_untrusted_origins_are_rejected(client):
    assert client.put("/api/projects/missing", json={"name": "Name", "expectedName": "Old"}).status_code == 404
    assert client.request("DELETE", "/api/projects/missing", json={"expectedName": "Old", "expectedCurrentVersions": {}}).status_code == 404
    owner = project(client)
    before = snapshot(client)
    headers = {"Origin": "https://example.invalid"}
    assert client.put(f'/api/projects/{owner["id"]}', json={"name": "Name", "expectedName": owner["name"]}, headers=headers).status_code == 403
    assert client.request("DELETE", f'/api/projects/{owner["id"]}', json={"expectedName": owner["name"], "expectedCurrentVersions": {}}, headers=headers).status_code == 403
    assert snapshot(client) == before


def test_delete_rolls_back_all_cleanup_when_database_write_fails(client):
    owner = project(client)
    historical_asset(client, owner)
    versions = expected_versions(client, owner)
    with client.app.state.store.connection() as connection:
        connection.execute("CREATE TRIGGER fail_project BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'delete failure'); END")
    before = snapshot(client)
    with pytest.raises(sqlite3.IntegrityError):
        client.app.state.store.delete_project(owner["id"], owner["name"], versions)
    assert snapshot(client) == before


def test_concurrent_renames_accept_only_one_expected_name(client):
    owner = project(client)
    gate = Barrier(2)
    def rename(name):
        store = Store(client.app.state.store.root)
        gate.wait()
        try: return store.rename_project(owner["id"], owner["name"], name)
        except Conflict: return None
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(rename, ["First change", "Second change"]))
    successes = [value for value in results if value is not None]
    assert len(successes) == 1
    assert client.get("/api/projects").json() == successes
