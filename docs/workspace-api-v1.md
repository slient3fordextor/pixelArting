# Workspace HTTP API v1

从 `pixelarting-mcp 0.11.0` 起，独立服务的 Streamable HTTP 进程同时提供 `/mcp` 和 `/api/v1`。客户的 agent、自动化工具或引擎插件可以选择 MCP 或普通 HTTP，调用同一套项目、素材、生成、质检和导入能力。接口复用实际注册的 32 项工具与授权入口，全部写入共用幂等收据和版本冲突保护。

## 启动与发现

```bash
pixelarting-mcp --data-dir /path/to/workspace --transport streamable-http --port 8765 --read-only
curl --fail http://127.0.0.1:8765/api/v1/capabilities
curl --fail http://127.0.0.1:8765/api/v1/openapi.json

# 离线导出；不打开素材数据库，也不启动 HTTP 服务
pixelarting-mcp --openapi > workspace-api-v1.json
```

允许修改时，实例启动参数使用 `--allow-write`。OAuth 使用原有的 `--oauth-config`，见[安全接入](mcp-security.md)。默认 stdio 不启动 HTTP 监听；桌面服务原有的 `/api` 与这里的 `/api/v1` 分开运行。

OpenAPI 使用 [3.1.1 格式](https://spec.openapis.org/oas/v3.1.1.html)、JSON Schema 2020-12，`info.version=1.0.0`、`x-pixelarting-contract-version=1`；实际服务版本位于 `x-pixelarting-service-version`。共 31 个路径、34 个操作，包括 32 项工具、资源读取和合同读取。CLI、HTTP 与 MCP 资源 `pixelart://contract/openapi/v1` 输出同一份动态合同，输入、输出及权限元数据来自真实工具目录。新增工具若未建立路由映射，合同构建会失败，避免静默遗漏。

MCP 入口资源 `pixelart://contract/v1` 增加 `openapiResourceUri`、`workspaceApiBasePath` 和 `openapiPath`；能力列表增加 `workspace-http-v1`。读取 OAuth 合同需要 `pixelart:read`，并使用同一限流和审计入口。离线 CLI 合同不包含当前身份、项目 grant、密钥或本地路径。

## 操作映射

下表均以 `/api/v1` 为前缀。`{...}` 位于路径；查询参数在 OpenAPI 的 `parameters` 中声明；其余工具参数放入 JSON 对象请求体。路径参数不能在请求体重复或覆盖。工具字段沿用原有 snake_case；`document`、`config` 和 `request` 内仍使用各领域模型的字段。

| 方法和路径 | MCP 工具 |
| --- | --- |
| GET `/capabilities` | `get_capabilities` |
| GET `/permissions` | `get_permissions` |
| GET `/health` | `pixelart_health` |
| GET / POST `/projects` | `list_projects` / `create_project` |
| GET `/projects/{project_id}/assets` | `list_assets` |
| POST `/projects/{project_id}/assets/blank` | `create_blank_asset` |
| GET / PUT `/projects/{project_id}/config` | `get_project_config` / `update_project_config` |
| GET `/assets/{asset_id}` | `get_asset`；查询 `include_document` |
| GET `/assets/{asset_id}/versions/{version_id}` | `get_asset_version` |
| GET `/assets/{asset_id}/preview` | `get_asset_preview`；查询 `version_id`、`frame_id`、`max_size` |
| GET `/assets/{asset_id}/reports` | `list_reports`；查询 `version_id`、`limit`、`offset` |
| GET `/assets/{asset_id}/inspection` | `inspect_asset`；查询 `version_id` |
| GET `/assets/{asset_id}/versions/{version_id}/export` | `export_asset`；查询 `target`、`frame_id` |
| PUT `/assets/{asset_id}/document` | `update_asset_document` |
| PATCH `/assets/{asset_id}/name` | `rename_asset` |
| POST `/assets/{asset_id}/repair-previews` | `preview_asset_repair` |
| POST `/assets/{asset_id}/repair-previews/{preview_id}/commit` | `commit_asset_repair` |
| POST `/assets/{asset_id}/restore` | `restore_asset_version` |
| POST / GET `/generations` | `start_generation` / `list_generations`；GET 查询 `project_id`、`status`、`limit` |
| GET `/generations/{generation_id}` | `get_generation` |
| POST `/generations/{generation_id}/cancel` | `cancel_generation` |
| POST `/generations/{generation_id}/retry` | `retry_generation` |
| GET `/generations/{generation_id}/candidates/{candidate_id}/preview` | `get_candidate_preview` |
| PATCH `/generations/{generation_id}/candidates/{candidate_id}` | `update_candidate_state` |
| POST `/generations/{generation_id}/candidates/{candidate_id}/imports` | `import_generation_candidate` |
| POST `/projects/{project_id}/import-preview` | `preview_file_import` |
| POST `/projects/{project_id}/imports` | `import_asset_file` |
| POST `/project-imports/preview` | `preview_project_import` |
| POST `/project-imports` | `import_project_backup` |
| GET `/resources?uri=...` | 读取已公开的 `pixelart://` 资源 |
| GET `/openapi.json` | 读取 `pixelart://contract/openapi/v1` |

全部成功操作返回 HTTP 200。JSON 保留 MCP `structuredContent` 的原形状：项目/素材等对象直接返回，列表/生成/导出等既有 SDK 包装继续使用 `result`。具体以每个操作的响应 schema 为准。预览直接返回 `image/png`；导出先返回描述对象，再将其 `resourceUri` 作为 `/resources` 的 `uri` 查询参数读取 PNG/ZIP。JSON 资源直接返回 JSON。资源 URI 只接受服务公开的固定模板，不读取调用者指定的本地文件或远程 URL。

## 修改素材

先 GET `/assets/{asset_id}?include_document=true`，记录 `currentVersionId`。例如改名请求：

```http
PATCH /api/v1/assets/ASSET_ID/name
Content-Type: application/json

{"name":"hero-idle","expected_current_version_id":"CURRENT_VERSION_ID","idempotency_key":"rename-hero-001"}
```

成功后 GET `/assets/{asset_id}/inspection` 并检查 findings。409 `version_conflict` 时重新读取，由调用者决定新修改。质检修复应先创建 repair preview，检查 `changes` 和 `report`，再用相同当前版本提交；预览后版本变化需要重新预览。

写工具的 `idempotency_key` 要求、命名空间、原响应重放和结果删除后的冲突与 MCP 相同，见[写入幂等](mcp-idempotency.md)。可以跨协议重放；可选键省略时不承诺重试安全。幂等不能替代权限、写门禁或新的确认，也不保证远程 provider 只计费一次。

## 权限与确认

OAuth 请求使用 `Authorization: Bearer TOKEN`。API 与 `/mcp` 使用同一外部 issuer、JWT 资源 audience、工作区身份、scope/项目授权、持久化读写预算和审计。每项 OpenAPI 操作的 `x-pixelarting-authorization` 和 `x-pixelarting-idempotency` 复用工具元数据。OpenAPI 的 HTTP Bearer 声明描述已有资源服务器，不提供 token/授权签发端点。

启用 `require_write_confirmation` 后，待批准的 HTTP 请求返回 **409**：

```json
{"ok":false,"contractVersion":"1","error":"HTTPError","code":"write_confirmation_required","message":"Ask the local operator to review and approve, then retry the identical request","retryable":false,"confirmation":{"requestId":"REQUEST_ID","digest":"DIGEST"}}
```

本机所有者通过 `--review-write REQUEST_ID` 检查完整意图，再以 `--approve-write REQUEST_ID --approval-digest DIGEST` 批准，客户端重发相同请求。确认绑定解析后的工具参数，包含路径参数和已转换类型的查询参数，以及身份/客户端/工作区；没有 API 自批准接口。批准一次消费，幂等重放也要重新批准。MCP 保留原有工具错误和 `_meta` 确认格式。审批过后报错时，先检查状态再申请新批准，详见[确认流程](mcp-security.md#050-写入二次确认)。

## 错误与限制

失败统一返回脱敏 JSON `ok=false`、`contractVersion`、`error`、`code`、`message`、`retryable`，确认时另有 `confirmation`。HTTP 状态与业务错误对应：

| HTTP 状态 | `code` |
| --- | --- |
| 400 | `invalid_request`：JSON 语法、重复键或非对象请求体 |
| 401 | `invalid_token`，携带原有资源 metadata 的 Bearer challenge |
| 403 | `insufficient_scope`、`access_denied`、`permission_denied` |
| 404 | `not_found` |
| 405 | `method_not_allowed`，带 Allow |
| 409 | `version_conflict`、`idempotency_conflict`、`write_confirmation_required`、`not_configured` |
| 413 / 415 | `request_too_large` / `unsupported_media_type` |
| 421 | `invalid_host` |
| 422 | `invalid_input`，包括无效字段、未知/重复查询参数或领域约束 |
| 429 | `rate_limited`、`queue_full`，带 Retry-After |
| 500 / 503 | `internal_error` / `security_unavailable`；写请求须先检查状态 |

已知路由按流读取，整个请求体上限 4 MiB；非空请求体要求 `application/json`，拒绝额外字段、重复键、非有限 JSON 数字、未知/重复查询参数和 GET 请求体。文件/项目导入另有解码、解压和像素总量限制，见[导入合同](mcp-imports.md)。Host/Origin 检查覆盖 API 路由、合同与未知子路径，响应使用 `Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`，不开放跨域调用。

本地监听仍限定 loopback；客户远程部署需要既有 OAuth/TLS 和宿主接入验收。生成任务复用进程级 worker 生命周期，请求断开不会关闭任务执行器；目前提供轮询，推送事件和 provider 崩溃重放策略仍在 TODO。入口级无效认证限流、审计清理与密钥轮换运营也仍待完成。

## 可重复验证

运行 HTTP/OpenAPI 定向回归需要项目的 `test` extra：

```bash
.venv/bin/python -m pytest backend/tests/test_mcp_http_api.py -q
```

构建 wheel 并安装到仓库外的独立虚拟环境后，用其中带 `test` extra 的 Python 验证实际服务：

```bash
/absolute/installed-venv/bin/python scripts/verify_workspace_api.py \
  --server /absolute/installed-venv/bin/pixelarting-mcp
```

脚本只使用临时工作区、临时签名密钥及测试身份，服务从仓库外启动且移除 `PYTHONPATH`。2026-11-12 的 0.11.0 wheel 已通过离线/在线 OpenAPI 一致性、HTTP/MCP 跨协议重放、质检/PNG、只读重启、OAuth scope、操作者确认、重放重新确认和版本冲突验证；质检无 findings，无外部 provider 请求。定向测试 57 项通过，含 JSON 指数溢出和嵌套非有限数值拒绝。容器、升级回滚与 Inspector 的 0.11.0 验收仍待重跑，既有 0.10.0 记录见[部署文档](mcp-deployment.md)和 [Inspector 文档](mcp-inspector.md)。
