import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.models import CheckConfig
from backend.store import Store


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as value:
        yield value


def project_and_asset(client, name="Test project"):
    project = client.post("/api/projects", json={"name": name}).json()
    asset = client.post(f'/api/projects/{project["id"]}/assets/blank', json={}).json()
    return project, asset


def test_project_config_is_isolated_and_survives_restart(client):
    first, _ = project_and_asset(client, "First project")
    second, _ = project_and_asset(client, "Second project")
    path = f'/api/projects/{first["id"]}/check-config'
    defaults = CheckConfig().model_dump()
    assert client.get(path).json() == defaults
    response = client.put(path, json={
        "targetWidth": 32,
        "targetHeight": 48,
        "maxColors": 8,
        "palette": ["#aabbcc", "#001122"],
        "baselineTolerancePx": 2,
        "targetBaselineY": 47,
        "expectedIdleFrames": 2,
        "expectedWalkFrames": 6,
        "allowSemiTransparent": True,
        "exportTarget": "godot",
        "enabled": {"palette.limit": False},
    })
    assert response.status_code == 200
    saved = response.json()
    assert saved["palette"] == ["#AABBCC", "#001122"]
    assert saved["enabled"]["palette.limit"] is False
    assert saved["enabled"]["size.grid"] is True
    assert client.get(f'/api/projects/{second["id"]}/check-config').json() == defaults
    with TestClient(create_app(client.app.state.store.root)) as restarted:
        assert restarted.get(path).json() == saved
        assert restarted.get(f'/api/projects/{second["id"]}/check-config').json() == defaults


@pytest.mark.parametrize("invalid", [
    {"targetWidth": 0},
    {"palette": ["red"]},
    {"palette": ["#AABBCC", "#aabbcc"]},
    {"enabled": {"unknown": True}},
    {"targetHeight": 32, "targetBaselineY": 32},
])
def test_project_config_validation_preserves_saved_values(client, invalid):
    project, _ = project_and_asset(client)
    path = f'/api/projects/{project["id"]}/check-config'
    saved = client.put(path, json={"maxColors": 9}).json()
    assert client.put(path, json=invalid).status_code == 422
    assert client.get(path).json() == saved


def test_missing_project_config_returns_404(client):
    path = "/api/projects/missing/check-config"
    assert client.get(path).status_code == 404
    assert client.put(path, json={}).status_code == 404


def test_checks_and_previews_use_project_config_and_capture_snapshot(client):
    project, asset = project_and_asset(client)
    config_path = f'/api/projects/{project["id"]}/check-config'
    config = client.put(config_path, json={"targetWidth": 32, "targetHeight": 48}).json()
    asset_path = f'/api/assets/{asset["id"]}'
    request = {"versionId": asset["currentVersionId"]}
    report = client.post(asset_path + "/check", json=request).json()
    assert report["config"] == config
    assert any(finding["ruleId"] == "size.grid" for finding in report["findings"])
    override = client.post(asset_path + "/check", json={**request, "config": {}}).json()
    assert override["config"] == CheckConfig().model_dump()
    assert not any(finding["ruleId"] == "size.grid" for finding in override["findings"])
    assert client.get(config_path).json() == config

    preview = client.post(asset_path + "/preview", json={**request, "actions": [{"id": "resize-nearest-v1"}]}).json()
    assert preview["report"]["config"] == config
    assert preview["changes"][0]["after"] == [32, 48]
    client.put(config_path, json={"targetWidth": 16, "targetHeight": 16})
    committed = client.post(asset_path + "/commit", json={
        "previewId": preview["previewId"],
        "expectedCurrentVersionId": asset["currentVersionId"],
    }).json()
    assert committed["report"]["config"] == config
    assert committed["asset"]["document"]["frames"][0]["width"] == 32


def test_report_history_filters_paginates_and_survives_restart(client):
    _, asset = project_and_asset(client)
    _, foreign = project_and_asset(client, "Other project")
    path = f'/api/assets/{asset["id"]}'
    version = asset["currentVersionId"]
    assert client.get(path + "/reports").json() == []
    first = client.post(path + "/check", json={"versionId": version}).json()
    second = client.post(path + "/check", json={"versionId": version, "config": {"maxColors": 2}}).json()
    document = asset["document"]
    document["name"] = "Renamed asset"
    saved = client.post(path + "/save", json={"expectedCurrentVersionId": version, "document": document}).json()
    newest = client.post(path + "/check", json={"versionId": saved["currentVersionId"]}).json()
    reports = client.get(path + "/reports").json()
    assert reports == [newest, second, first]
    assert all(report["created"] for report in reports)
    assert all("asset_id" not in report and "body" not in report for report in reports)
    assert client.get(path + "/reports", params={"versionId": version}).json() == [second, first]
    assert client.get(path + "/reports", params={"limit": 1, "offset": 1}).json() == [second]
    assert client.get(path + "/reports", params={"offset": 3}).json() == []
    assert client.get(path + "/reports", params={"versionId": foreign["currentVersionId"]}).json() == []
    assert client.get(f'/api/assets/{foreign["id"]}/reports').json() == []
    with TestClient(create_app(client.app.state.store.root)) as restarted:
        assert restarted.get(path + "/reports").json() == reports
    assert client.get("/api/assets/missing/reports").status_code == 404


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 101}, {"offset": -1}, {"limit": "bad"}])
def test_report_history_pagination_validation(client, params):
    _, asset = project_and_asset(client)
    assert client.get(f'/api/assets/{asset["id"]}/reports', params=params).status_code == 422


def test_legacy_database_is_migrated_without_changing_projects(tmp_path):
    project = {"id": "legacy", "name": "Old project", "created": "2024-01-01T00:00:00+00:00"}
    with sqlite3.connect(tmp_path / "pixelart.sqlite3") as connection:
        connection.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL)")
        connection.execute("INSERT INTO projects VALUES (:id,:name,:created)", project)
    store = Store(tmp_path)
    assert store.list_projects() == [project]
    assert store.project_config(project["id"]) == CheckConfig()
    updated = CheckConfig(maxColors=3, palette=["#AABBCC"])
    store.save_project_config(project["id"], updated)
    assert Store(tmp_path).project_config(project["id"]) == updated
    assert Store(tmp_path).list_projects() == [project]


def test_missing_config_and_old_report_rows_remain_readable(client):
    project, asset = project_and_asset(client)
    store = client.app.state.store
    created = "2024-01-01T00:00:00+00:00"
    with store.connection() as connection:
        connection.execute("DELETE FROM project_configs WHERE project_id=?", (project["id"],))
        connection.execute("INSERT INTO reports VALUES (?,?,?,?,?)", (
            "legacy-report", asset["id"], asset["currentVersionId"], json.dumps({"findings": [], "config": {}}), created,
        ))
    assert store.project_config(project["id"]) == CheckConfig()
    report = store.list_reports(asset["id"])[0]
    assert report["id"] == "legacy-report"
    assert report["assetVersionId"] == asset["currentVersionId"]
    assert report["created"] == created


def test_report_store_rejects_foreign_versions_and_orders_equal_timestamps(client):
    _, asset = project_and_asset(client)
    _, foreign = project_and_asset(client, "Foreign project")
    store = client.app.state.store
    with pytest.raises(KeyError):
        store.save_report(asset["id"], foreign["currentVersionId"], {"findings": []})
    body = {"findings": []}
    first = store.save_report(asset["id"], asset["currentVersionId"], body)
    second = store.save_report(asset["id"], asset["currentVersionId"], body)
    assert body == {"findings": []}
    with store.connection() as connection:
        connection.execute("UPDATE reports SET created=? WHERE asset_id=?", ("2024-01-01T00:00:00+00:00", asset["id"]))
    assert [report["id"] for report in store.list_reports(asset["id"])] == [second["id"], first["id"]]
