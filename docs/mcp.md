# PixelArting MCP

PixelArting 提供独立的本地 MCP 包 `pixelarting-mcp`（服务版本 `0.11.0`），无需启动 Electron 或安装 Node.js。服务复用桌面端的 Store、不可变版本、导入、质检、修复和导出实现，支持 stdio 和本机 Streamable HTTP。

默认是**本地单用户**模式，只读启动。支持可选 OAuth JWT 资源服务器、项目授权、审计与共享限流；0.5.0 新增本机 CLI 审阅、批准/拒绝的服务端写入确认，需在 OAuth 配置中开启，配置见 [HTTP 安全接入](mcp-security.md)。HTTP 监听仍限制在 loopback，客户远程入口需配置 HTTPS 反向代理。当前不提供共享进程的多租户路由或 token 签发。完整客户工作流和生产接入缺口见 [接入审计](agent-integration-audit.md)，返回约定见 [本地 v1 合同](mcp-v1.md)。

仓库还提供 `Dockerfile.mcp`、运行时版本/哈希锁和 Linux OAuth HTTP Compose 配置。容器、数据卷、确认通道及离线升级/回滚验收见 [部署与升级](mcp-deployment.md)。镜像当前需从源码自行构建，尚未发布。

## 独立安装和启动

需要 Python 3.12 或更高版本。在源码目录执行：

```bash
python3 -m venv .venv-mcp
.venv-mcp/bin/pip install .
.venv-mcp/bin/pixelarting-mcp --version
.venv-mcp/bin/pixelarting-mcp --data-dir /absolute/path/to/workspace
```

也可以构建 wheel 后在另一台机器安装，运行时不需要源码目录：

```bash
python3 -m pip wheel --no-deps --wheel-dir dist .
python3 -m pip install dist/pixelarting_mcp-0.11.0-py3-none-any.whl
pixelarting-mcp --data-dir /absolute/path/to/workspace
```

以上是源码/wheel 安装方式，尚未发布到 PyPI。Windows 使用虚拟环境的 `Scripts` 目录。包沿用仓库 AGPL-3.0 许可证。

独立入口默认数据目录：Linux `$XDG_DATA_HOME/pixelarting`（未设置时为 `~/.local/share/pixelarting`），macOS `~/Library/Application Support/pixelarting`，Windows `%LOCALAPPDATA%/pixelarting`。`--data-dir` 优先于 `PIXELART_DATA_DIR`；要访问桌面素材，应明确指定桌面使用的数据目录，例如仓库下的 `/absolute/path/to/pixelArting/data`。

兼容原来的仓库启动方式：

```bash
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m backend.mcp_server
```

该兼容入口默认使用仓库 `data/`，现有 `.mcp.json` 可继续使用。新入口 `pixelarting-mcp` 和 `python -m backend.mcp_cli` 默认使用用户数据目录。

## 配置 AI 客户端

客户端应使用安装后可执行文件和数据目录的绝对路径，从任意工作目录均可启动：

```json
{
  "mcpServers": {
    "pixelarting": {
      "command": "/absolute/path/to/.venv-mcp/bin/pixelarting-mcp",
      "args": ["--data-dir", "/absolute/path/to/workspace", "--read-only"]
    }
  }
}
```

只有工作区所有者授权 agent 修改素材时，才把 `--read-only` 改为 `--allow-write`。也兼容环境变量 `PIXELART_MCP_ALLOW_WRITE=1`；显式 `--read-only` 会覆盖该变量。每个服务实例启动时固定数据目录和写权限，不受启动后的环境变量修改影响。

工具写门禁限制项目/素材修改，不代表以 SQLite 只读模式打开数据库：首次数据访问仍会初始化或迁移 Store。`--help`、`--version`、`--schema`、`--openapi` 不打开数据库；`get_capabilities`、`get_permissions` 和合同资源不打开素材数据库，但 OAuth 调用仍会写安全审计/限流数据库。

## 本机 Streamable HTTP

```bash
pixelarting-mcp --data-dir /absolute/path/to/workspace --transport streamable-http --host 127.0.0.1 --port 8765 --read-only
```

端点为 `http://127.0.0.1:8765/mcp`，只允许 `127.0.0.1`、`localhost` 或 `::1`。上述命令未启用身份认证；本机其他进程也可能访问。客户远程接入必须先配置 `--oauth-config`，详见 [安全接入](mcp-security.md)。环境变量 `PIXELART_MCP_TRANSPORT`、`PIXELART_MCP_HOST`、`PIXELART_MCP_PORT` 仍可使用，CLI 参数优先。保留旧 `sse` 启动选项用于兼容，新客户端使用 stdio 或 Streamable HTTP。

## 工具与工作流

- 任务读取：`get_generation`、`list_generations`、`get_candidate_preview`。
- 任务写门禁：`start_generation`、`cancel_generation`、`retry_generation`、`update_candidate_state`、`import_generation_candidate`。
- 文件读取/写入：`preview_file_import` 为只读预检；`import_asset_file` 通过写门禁、项目权限与持久化幂等键创建素材，支持 PNG/Sheet 与分层 ZIP，见 [文件导入](mcp-imports.md)。
- 项目备份：`preview_project_import` 逐项预检；`import_project_backup` 原子恢复为新项目。OAuth 下预检要求 read+admin，导入还需 write、进程门禁及已配置的确认；不会自动修改项目授权，见 [备份导入](mcp-imports.md#项目备份导入080)。
- 发现/只读：`get_capabilities`、`get_permissions`、`pixelart_health`、`list_projects`、`list_assets`、`get_asset`、`get_asset_version`、`get_asset_preview`、`get_project_config`、`list_reports`、`inspect_asset`、`export_asset`。
- 写门禁：`create_project`、`create_blank_asset`、`update_asset_document`、`rename_asset`、`update_project_config`、`preview_asset_repair`、`commit_asset_repair`、`restore_asset_version`。

先调用 `get_capabilities` 判断功能，调用 `get_permissions` 检查当前 scope、项目边界和独立写入条件。编辑流程：`get_asset(include_document=true)` → 修改 document → `update_asset_document(expected_current_version_id=currentVersionId)` → `inspect_asset`。更新发生冲突时重新读取，由 agent 或用户重新决定如何应用修改。

修复流程：`inspect_asset` → `preview_asset_repair` → 审阅 `changes` 和 `report` → `commit_asset_repair` → `inspect_asset`。预览保存到工作区，因此也需要写权限。旧预览不能覆盖新的素材版本。

导出流程：`get_asset` 获取版本 → `export_asset(asset_id, version_id, target)` → 从 `structuredContent.result.resourceUri` 调用 MCP `resources/read`。支持当前/历史保存版本的 PNG、frames ZIP、sheet ZIP、JSON ZIP、Godot ZIP；导出不创建素材版本或临时文件。PNG 可指定 `frame_id`，ZIP 包含全部帧，Godot 仍须满足原有动画结构要求。单个导出上限为 16 MiB，二进制资源通过 MCP blob 传输；客户端负责保存文件。

## 无界面的生成工作流

先在本地 AI 设置中配置 provider，并让 MCP 的 `--data-dir` 指向同一数据目录。MCP 不提供 API Key 读取/写入工具，也不从模型参数或环境变量获取 provider 密钥。只有 `--allow-write` 服务运行生成队列，默认只读服务不会恢复或执行已有任务。

1. `start_generation(request, idempotency_key)` 提交任务，例如 request 为 `{"projectId":"项目 ID","mode":"agent_draw","prompt":"红色图标","width":64,"height":64}`。支持 `agent_draw` 和 `image_model`，调用本地配置的 provider，可能产生费用。
2. 通过 `get_generation(generation_id)` 或 `pixelart://generations/{generation_id}` 轮询状态与 revision。完成后只返回候选摘要，PNG 使用 `get_candidate_preview` 或候选的 `previewResourceUri` 获取，不把全部像素文档塞进状态结果。
3. 可用 `update_candidate_state` 收藏或淘汰候选；淘汰候选不能导入。审阅后调用 `import_generation_candidate`，不指定 project_id 时使用任务关联项目。
4. 导入返回新素材 ID、版本和质检报告。同一任务/候选/项目重复导入复用原素材，不会创建副本；随后调用 `get_asset`、`inspect_asset`，按需要预览/提交修复并导出。

`cancel_generation` 可取消排队或运行中的任务，重复取消保留 cancelled 状态；`retry_generation` 仅允许 failed/cancelled 任务，使用原任务的请求和 provider 快照创建新任务，也需要新的幂等键。成功任务要再次生成时应提交新请求。取消无法撤回 provider 已发生的费用。

幂等键绑定整个工作区中的操作和请求，格式为 1..128 个 ASCII 字母、数字或 `_.:-`。重复提交相同键和请求返回同一任务；输入不同、起始/重试操作不同、或原任务已删除时返回 `idempotency_conflict`，不会悄悄创建新任务。调用超时后应使用原键重试，不能每次生成新键。

桌面与多个 MCP 进程共享持久化队列，通过操作系统工作区锁只允许一个进程执行/恢复任务；其他进程可提交和取消，执行者轮询队列并接收取消。执行者正常退出后释放锁，崩溃后由操作系统释放，另一个写服务接管并恢复未完成工作。仍不能保证 provider 在进程崩溃前收到的请求不会被重复计费：恢复语义是至少执行一次。工作区应使用本机文件系统，未验证网络文件系统锁语义。关闭服务会停止本地执行，未完成任务保留到下一次恢复。

当前进度是 queued/running/succeeded/failed/cancelled 状态与递增 revision，没有伪造完成百分比或推送事件。MCP Apps widget、引擎插件、镜像发布，以及真实客户 OAuth/TLS 和宿主确认流程验收仍待实现。字段约定见 [任务合同](mcp-v1.md#生成任务与候选)。

## 合同和验证

```bash
pixelarting-mcp --schema > mcp-schema.json
PYTHONPATH=. .venv/bin/python -m pytest backend/tests/test_mcp.py backend/tests/test_mcp_protocol.py -q
```

`--schema` 从实际注册的工具生成输入/输出 schema、资源和资源模板。0.9.0 的 `get_permissions` 与 `_meta["pixelarting/authorization"]` 提供当前身份和静态授权规则，详见 [权限合同](mcp-permissions.md)。全部写工具的键要求和重放规则见 [写入幂等](mcp-idempotency.md)。客户端也可读取 `pixelart://contract/idempotency/v1`、`pixelart://contract/permissions/v1`、`pixelart://contract/v1`、`pixelart://contract/tasks/v1`、`pixelart://contract/imports/v1` 和 `pixelart://contract/project-imports/v1`。0.6.0 已为全部 JSON 工具补齐逐字段输出合同，并保留旧对象/列表包装和缺省字段；原生 PNG 预览继续使用 image content。0.7.0 加入文件预检/导入/重放，0.8.0 加入项目备份的原子导入/重放；Inspector 已验证 stdio 及 OAuth 管理员确认链路。回归测试通过真实 stdio 子进程和本机 HTTP 客户端执行初始化、发现、读写门禁、生成/候选/文件与项目导入/质检/修复/导出与 PNG 资源读取，provider 使用本机模拟端点；真实客户宿主仍待验收。

[Inspector CLI 验收](mcp-inspector.md) 已通过 stdio/OAuth HTTP 的严格发现、权限、确认、修复/冲突和资源读取。0.6.0 也修复了严格宿主无法展示确认错误的问题：确认详情改在 `_meta["pixelarting/writeConfirmation"]` 和文本中，0.5.0 专用客户端需调整读取位置，见 [确认迁移](mcp-security.md#050-写入二次确认)。浏览器 UI/真实授权服务器和客户宿主未验收。

## 普通 HTTP 与引擎插件接入

0.11.0 的 Streamable HTTP 进程同时提供 `/api/v1`，全部 32 项工具均有实际路由，另有资源和 OpenAPI 读取。使用 `pixelarting-mcp --openapi` 离线导出；动态合同也通过 `/api/v1/openapi.json` 和 MCP 资源 `pixelart://contract/openapi/v1` 公开。字段、HTTP 状态、二进制资源和确认差异见 [Workspace API v1](workspace-api-v1.md)。
