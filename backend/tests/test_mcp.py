import importlib


def load_mcp(monkeypatch, tmp_path, allow_write=False):
    monkeypatch.setenv("PIXELART_DATA_DIR", str(tmp_path))
    if allow_write:
        monkeypatch.setenv("PIXELART_MCP_ALLOW_WRITE", "1")
    else:
        monkeypatch.delenv("PIXELART_MCP_ALLOW_WRITE", raising=False)
    import backend.mcp_server as server
    return importlib.reload(server)


def test_mcp_is_read_only_by_default(monkeypatch, tmp_path):
    server = load_mcp(monkeypatch, tmp_path)

    assert server.pixelart_health()["writeEnabled"] is False
    result = server.create_project("blocked")
    assert result["ok"] is False
    assert result["error"] == "PermissionError"
    assert server.list_projects() == []


def test_mcp_repair_preview_commit_and_png_preview(monkeypatch, tmp_path):
    server = load_mcp(monkeypatch, tmp_path, allow_write=True)
    project = server.create_project("MCP")
    asset = server.create_blank_asset(project["id"], "sprite", 8, 8)
    base = asset["currentVersionId"]

    image = server.get_asset_preview(asset["id"])
    assert image._mime_type == "image/png"
    assert image.data.startswith(b"\x89PNG\r\n\x1a\n")

    preview = server.preview_asset_repair(asset["id"], base, [{"id": "resize-nearest-v1"}])
    assert preview["ok"] is True
    assert preview["changes"][0]["after"] == [64, 64]

    committed = server.commit_asset_repair(asset["id"], preview["previewId"], base)
    assert committed["ok"] is True
    assert committed["resultVersionId"] != base
    assert committed["asset"]["document"]["frames"][0]["width"] == 64
    assert server.list_reports(asset["id"])[0]["assetVersionId"] == committed["resultVersionId"]


def test_mcp_rejects_stale_document_update(monkeypatch, tmp_path):
    server = load_mcp(monkeypatch, tmp_path, allow_write=True)
    project = server.create_project("MCP")
    asset = server.create_blank_asset(project["id"], "sprite", 8, 8)
    base = asset["currentVersionId"]
    document = asset["document"]
    document["name"] = "new name"

    first = server.update_asset_document(asset["id"], base, document)
    assert first["ok"] is True
    stale = server.update_asset_document(asset["id"], base, document)
    assert stale["ok"] is False
    assert stale["error"] == "Conflict"
