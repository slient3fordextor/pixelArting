# PixelArting MCP

PixelArting exposes its project and asset workflow through a Model Context Protocol server. The adapter uses the same `Store`, document validation, immutable versions, and quality rules as the desktop HTTP API.

The server is **read-only by default**. This lets an agent inspect the workspace without allowing it to edit files. To enable editing, set `PIXELART_MCP_ALLOW_WRITE=1` in the MCP server's environment. Every write still requires the current version ID, so an agent must re-read an asset before saving and cannot silently overwrite a newer UI edit.

## Local stdio server

Install dependencies and start the server from the repository root:

```bash
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m backend.mcp_server
```

The repository includes a portable `.mcp.json` using that command. Clients that support project MCP configuration can load it directly.

Codex can also register it explicitly:

```bash
codex mcp add pixelarting -- .venv/bin/python -m backend.mcp_server
codex mcp list
```

To grant write access, add the environment variable in the client configuration:

```json
{
  "mcpServers": {
    "pixelarting": {
      "command": ".venv/bin/python",
      "args": ["-m", "backend.mcp_server"],
      "cwd": ".",
      "env": { "PIXELART_MCP_ALLOW_WRITE": "1" }
    }
  }
}
```

## Streamable HTTP server

For an agent that cannot start a local process, run:

```bash
PIXELART_MCP_TRANSPORT=streamable-http \
PIXELART_MCP_PORT=8765 \
.venv/bin/python -m backend.mcp_server
```

The endpoint is `http://127.0.0.1:8765/mcp`. Keep it on loopback unless an authenticated HTTPS proxy is added. The current server is intentionally a local single-user adapter and has no remote authentication layer.

## Available tools

- Read-only: `pixelart_health`, `list_projects`, `list_assets`, `get_asset`, `get_asset_version`, `get_asset_preview`, `get_project_config`, `list_reports`, `inspect_asset`.
- Write-gated: `create_project`, `create_blank_asset`, `update_asset_document`, `rename_asset`, `update_project_config`, `preview_asset_repair`, `commit_asset_repair`, `restore_asset_version`.

The normal editing sequence is: `list_projects` → `list_assets` → `get_asset(include_document=true)` → modify the document → `update_asset_document` with `currentVersionId` → `inspect_asset`.

For deterministic quality fixes, use `inspect_asset` → `preview_asset_repair` → review `changes` and `report` → `commit_asset_repair`. The commit call checks that the asset still has the preview's base version. To roll back, call `restore_asset_version` with the current version and the desired immutable version.

Any MCP-compatible agent can use the server, including Codex and other local or hosted agent clients. Client configuration syntax differs, but the stdio command and the Streamable HTTP endpoint stay the same.
