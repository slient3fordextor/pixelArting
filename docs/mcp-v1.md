# 本地 MCP v1 合同

服务版本 `0.11.0`，合同版本 `1`，素材文档版本仍为 `1.1`。本合同覆盖能力发现、错误分类、持久化生成/候选工作流、文件/项目备份导入、版本导出和可选的 OAuth 写入确认。0.11.0 的独立 HTTP 进程提供同源的 `/api/v1` 与 OpenAPI 3.1.1，见 [Workspace API](workspace-api-v1.md)；真实客户远程部署仍待验收。

## 发现与兼容

`get_capabilities` 的 `structuredContent` 直接返回能力对象：`contractVersion`、`serviceVersion`、`documentSchemaVersion`、`mode`、`writeEnabled`、`authentication`、`transports`、`exportTargets`、`features`、`unavailable` 和 `maxExportBytes`。

默认 `mode=local-single-user`、`authentication=local-process-only`。启用 OAuth 后为 `mode=authenticated-single-workspace`、`authentication=oauth-jwt`，由服务端执行身份、scope 和项目检查，见 [安全接入](mcp-security.md)。`features` 包含 permissions、write-idempotency、generation、candidates、candidate-import、task-polling、file-import、file-import-preview、project-backup-import 和 project-backup-preview；`unavailable` 列出 oauth-authorization-server、multi-tenant 和 task-events。write-confirmation 在开启时列入 features，未开启时列入 unavailable；`writeConfirmationRequired` 明确表示本实例是否要求确认。

0.7.0 新增 `importFormats=[png,layered-zip]`、`maxImportBytes=2097152`、`maxImportExpandedBytes=16777216` 和 `maxImportPixels=1048576`。`pixelart://contract/imports/v1` 提供精确输入/输出 schema 和导入/重放约定，入口合同的 `importContractUri` 指向它。导入结果直接位于 structuredContent；文件内容通过受限 base64 传入，完整说明见 [文件导入](mcp-imports.md)。

0.8.0 新增 `projectImportFormats=[pixelart-project-v1]` 和 `projectImportContractUri=pixelart://contract/project-imports/v1`。项目预检/导入是独立工具，结果直接位于 structuredContent；恢复新 ID 的项目配置和各素材当前版本。共用文件传输限制，解压/总像素预算对整个项目累计；项目/配置/全部初始素材版本/收据原子提交，重放不覆盖后来的修改。项目导入键与文件/生成键独立；删除任一初始结果后冲突。逐素材报告按当前已恢复项目配置重算。

0.9.0 新增 `get_permissions`、`pixelart://contract/permissions/v1` 和发现项 `_meta["pixelarting/authorization"]`。逐工具/资源 scope、项目边界与服务端执行共用声明；当前身份视图分别表示 scope、进程写门禁和确认要求，不能替代每次目标授权。详见 [权限合同](mcp-permissions.md)。

`pixelart://contract/v1` 返回能力、错误和导出描述 schema，以及版本/写入策略。`pixelarting-mcp --schema` 输出实际 MCP 注册 schema。v1 只做兼容性的新增；将来若有破坏性变更，需要新合同版本并提供迁移说明。服务版本和素材文档版本分别管理。

从 0.6.0 起，所有 JSON 工具公开并验证逐字段输出 schema，包括健康、项目、素材摘要/完整文档/版本、配置、报告、质检、修复差异/提交、生成和导入结果。旧工具保留既有结果：对象直接位于 `structuredContent`，列表由 SDK 包装为 `structuredContent.result`，PNG 预览使用原生 image content（不声明 JSON 输出 schema）。客户端必须按工具公开的 `outputSchema` 读取结果，不能假设所有工具都采用统一信封。

`update_asset_document.document`、`update_project_config.config` 和 `preview_asset_repair.actions` 也公开实际领域模型的嵌套输入 schema；结构和业务校验保留在已有的脱敏错误边界中。`pixelart://contract/v1.assetContracts` 可读取主要素材输出 schema，完整工具合同仍以 tools/list 或 CLI `--schema` 为准。0.11.0 将全部 32 项工具映射为实际 HTTP 操作，OpenAPI 从同一 schema 与授权声明生成，可通过 `--openapi`、`/api/v1/openapi.json` 或 `pixelart://contract/openapi/v1` 读取。

素材的 document 缺省时继续省略，图层中旧 API 省略的默认字段也继续省略。StoredReport 明确允许旧执行器未记录的字段缺省；历史 config 作为 JSON 快照原样保留，不用当前 CheckConfig 补默认值或重解释旧选项。新运行的质检报告则要求 config/hash/executor/rules/findings/colorCount/frameCount 等完整字段；自由来源元数据和历史配置快照允许 JSON 扩展，不代表其余工具退回任意对象合同。

## 导出

`export_asset` 必须提供 `asset_id` 和不可变的 `version_id`；可选 `target=png|frames|sheet|json|godot`（默认 png）。`frame_id` 只适用于 PNG，不指定时选择该版本的第一帧。

该工具的联合结果位于 `structuredContent.result`。成功示例：

```json
{
  "result": {
    "ok": true,
    "contractVersion": "1",
    "assetId": "asset-id",
    "versionId": "version-id",
    "frameId": "frame_0",
    "target": "png",
    "resourceUri": "pixelart://exports/asset-id/version-id/png/frame_0",
    "mimeType": "image/png",
    "filename": "pixelart-asset-id-version-id-png.png",
    "byteLength": 72
  }
}
```

`byteLength` 为实际结果大小，示例数字仅作说明。`resources/read` 返回 image/png 或 application/zip 的 base64 blob，解码后由客户端保存。ZIP 的 `frameId=null`，URI 为 `pixelart://exports/{asset_id}/{version_id}/{target}/bundle`。

导出读取指定保存版本，不跟随当前版本移动；不创建版本、工作区文件或下载 token。资源按读取请求重新生成，ZIP 不保证逐字节相同。资源不含本地绝对路径，不能当作 HTTPS 下载链接；源素材/版本删除后资源不再可用。单个输出最大 16 MiB，该限制在生成结果后校验，并不是流式内存上限。

## 错误

工具实现捕获的业务异常使用 `ToolFailure`：

```json
{
  "ok": false,
  "contractVersion": "1",
  "error": "Conflict",
  "code": "version_conflict",
  "message": "State changed; re-read the resource before retrying",
  "retryable": false
}
```

| code | 客户端处理 |
| --- | --- |
| permission_denied | 本地写门禁关闭，由工作区所有者调整启动配置 |
| not_found | 重新查询项目、素材或版本 |
| version_conflict | 重新读取并处理冲突，不能原样重试旧写入 |
| invalid_input | 检查输入 schema、帧 ID、目标格式和资源限制 |
| idempotency_conflict | 原键已绑定其他输入、操作或已删除的资源；检查调用上下文 |
| not_configured | 在本地配置 provider 或恢复原任务所需凭据 |
| queue_full | 等待队列释放容量，再用同一个幂等键重试 |
| internal_error | 记录失败，检查本地服务状态 |

错误消息不回显原始异常、验证输入、provider 消息或密钥。兼容字段 `error` 保留异常类型名，客户端应依赖 `code`。导出错误也放在 `result` 内；旧对象工具直接返回失败对象，旧列表工具返回含失败对象的列表。业务失败通常仍是普通 MCP 工具结果，客户端必须检查 `ok=false`。SDK 的参数校验、协议错误和 `resources/read` 失败遵循 MCP SDK 的错误语义，不套用此业务信封。

## 写入、版本与幂等边界

默认禁写，`--allow-write`/环境变量控制进程写门禁。OAuth 模式还要满足 token 与服务端 grant 的 scope 交集和项目限制；本地模式按工作区进程所有者授权。每个服务实例固定一个数据目录，没有请求级租户切换。只读指不允许业务写工具，Store 首次初始化和迁移仍可能更新数据库。

写前读 `get_asset(include_document=true)`，传 `expected_current_version_id`，写后 `inspect_asset`。修复先预览、审阅差异与报告再提交；提交校验预览基线，不能用旧预览覆盖新版本。现有无变化保存不建版本、相同 previewId 重复提交复用已提交版本的语义保留。0.10.0 为其余 11 个写工具增加可选 idempotency_key，与原有 4 个必填键工具一起覆盖全部写工具。可靠重试必须提供键；旧调用省略/null 继续原语义。通用写收据和业务修改同事务提交，重放返回原始成功快照且不覆盖后续编辑，删除结果后冲突。命名空间、摘要、失败回滚和权限再检查见 [写入幂等](mcp-idempotency.md)。

`import_asset_file` 的必填键在素材/版本/收据同一事务内提交，相同请求重放初始版本；与生成任务键分开。删除后保留冲突收据，质检按当前读取的项目配置重算。预检不是持久化提交 token，不能替代真正写入的参数与权限检查。

项目备份预检需要 read+admin，导入还需要 write 和进程门禁/已配置确认。新项目不会自动加入普通主体的 grant；只读 admin 可预检但不能导入。字段与范围见 [备份导入](mcp-imports.md#项目备份导入080)。

真实客户 OAuth/TLS 与宿主确认流程验收、入口限流/审计保留策略、mTLS（可选）、收据运营清理和任务推送事件属于后续范围。

## 生成任务与候选

`pixelart://contract/tasks/v1` 提供实际任务/导入输出 schema 和幂等、重试、进度约定。任务工具成功/失败的联合类型都位于 `structuredContent.result`，包括 start/get/list/cancel/retry、候选状态更新和导入；原生候选预览返回 image content。

任务对象包含 `ok`、`contractVersion`、`id`、`projectId`、`mode`、`status`、`revision`、`request`、`candidates`、`error`、`created`、`updated`、`resourceUri`。`list_generations` 的成功对象包含 `generations`，支持项目/状态过滤和 1..100 条限制。结果不包含 provider 配置、密钥、外部签名 URL、原始响应、绘画命令或像素文档；候选摘要含 ID、说明、尺寸、颜色/透明度、收藏/淘汰状态与 PNG 资源 URI。失败任务的 MCP 错误说明使用通用文本。

任务状态：queued → running → succeeded/failed/cancelled，queued 也可取消/失败。revision 在状态和候选状态实际变化时增加；重复设置相同候选状态不增加 revision。恢复时 running → queued 并增加 revision。轮询即可观察进度，没有百分比、推送事件或 MCP 原生 Tasks 协议声明。

`start_generation` 的 request 沿用严格 `AiGenerationRequest`：mode、prompt 必填，projectId 可选，画布 1..512、候选数 1..8，其余字段和范围以 schema 为准。`idempotency_key` 必填，由调用者生成，在整个工作区内唯一。服务保存规范化请求和操作的摘要，在同一 SQLite 事务内检查幂等键、32 条活动任务上限并入队；并发相同提交只创建一条任务。相同输入的重放不受当前配置变化影响。原任务删除后保留键的墓碑，禁止重放产生新费用；尚未实现键的保留期和清理策略。

`retry_generation(generation_id, idempotency_key)` 仅接受失败/取消任务，创建新 ID，保留原任务状态，复用原请求、模型配置与凭据快照。键同时绑定原任务 ID，不能与 start 或其他任务的 retry 共用。原快照/凭据不可用时返回 not_configured。桌面旧 retry 路由仍保留“使用当前档案”的兼容行为。

`import_generation_candidate` 在目标项目新建素材，不覆盖现有素材；按任务/候选/项目重复调用返回原素材。已删除的导入素材不会重建，淘汰候选在事务内校验。新结果包含 assetId、projectId、currentVersionId、name、report；agent 应读取素材、运行质检再决定是否修复。

执行服务属于应用生命周期，HTTP 单次请求结束或客户端断线不会停止队列。多个本机进程通过工作区 OS 锁选出执行者；只有持锁者可以恢复 running 任务。正常关闭会向本地运行请求发送停止信号，队列记录保留供下次恢复。进程崩溃时远程 provider 的请求可能已经执行，恢复不能承诺外部付费请求恰好一次。

OAuth HTTP 边界在执行前返回 401/403/429/503；这类拒绝不使用旧业务 ToolFailure 信封。直接函数调用也有相同项目/权限检查，未设置认证上下文时默认拒绝。权限配置 schema 和约定见 `pixelart://contract/security/v1`。

可选写入确认通过 `get_capabilities.writeConfirmationRequired` 发现。开启后，尚未批准的写调用返回 MCP 工具错误 `isError: true`；HTTP 状态为 200，标准客户端可展示错误并继续当前会话。0.6.0 的确认信息位于 `_meta["pixelarting/writeConfirmation"] = {requestId, digest}`，文字内容也携带 `write_confirmation_required` 和两个字段，不再提供不符合业务输出 schema 的 structuredContent；0.5.0 专用读取逻辑需要迁移。这是确认门禁结果，不使用旧业务 ToolFailure，也不是业务执行成功。宿主应暂停、将请求 ID 交给本机操作者审阅，批准后重发完全相同的工具/参数；不得自动调用本机批准命令。只有通过现有身份/项目/写门禁检查的请求才可进入确认。600 秒有效、单次消费、失败重读规则见 [写入二次确认](mcp-security.md#050-写入二次确认)。
