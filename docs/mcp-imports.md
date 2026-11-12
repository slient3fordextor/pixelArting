# MCP 文件导入

从 `0.7.0` 起，标准 MCP 客户端可以直接传入文件字节，无需桌面窗口、HTTP multipart 或服务器文件路径。复用桌面的 PNG/Sheet、分层包解析、校验和与版本存储；不调用 AI provider。

## 输入与预检

先读取 `get_capabilities` 和 `pixelart://contract/imports/v1`。支持两种 `file_format`：

- `png`：静态 8 位 PNG，单图最大 512×512；Sprite Sheet 最大边长 2048，必须明确帧宽高，可设置边距、间距、偏移、行列与 strict/clip 切分，最多 64 帧。
- `layered-zip`：PixelArting 导出的分层 JSON ZIP；保留图层、动画与来源信息，校验 manifest、素材 checksum 和引用。普通图片 ZIP、项目备份、Aseprite 均不接受。

传 `data_base64` 为严格 base64 文件内容，不带 data URL 前缀。每次最多 **2 MiB 原始字节**；ZIP 解压内容累计最多 **16 MiB**；PNG 源图像素数或 ZIP 素材帧宽×高×图层数累计最多 **1,048,576**。ZIP 同时继承现有文件数量、元数据、路径、链接、加密、CRC、压缩流与实际解压预算校验。超出 MCP 限制的素材仍可使用桌面导入。

`preview_file_import` 参数示例：

```json
{
  "project_id": "existing-project-id",
  "data_base64": "<客户端编码的 PNG 文件内容>",
  "file_format": "png",
  "options": {
    "name": "walk-down",
    "layout": {"cellWidth": 32, "cellHeight": 32, "rows": 1, "columns": 2},
    "mapping": [
      {"frameIndex": 0, "action": "walk", "direction": "down", "durationMs": 120},
      {"frameIndex": 1, "action": "walk", "direction": "down", "durationMs": 120}
    ],
    "mappingConfirmed": true
  }
}
```

预检返回源 SHA-256、字节数、图层、帧尺寸、动画、实际布局和质检报告，不返回全部像素。预检不会创建素材或保留源文件，允许只读客户端使用。非空动作映射必须确认；只适用于 PNG。分层 ZIP 的 options 只能改变名称。

## 导入与重试

审阅预检后，调用 `import_asset_file`，传相同参数及必填的 `idempotency_key`，例如 `workflow-123:file-1`。结果对象直接位于 `structuredContent`：`ok`、`contractVersion`、`assetId`、`projectId`、`versionId`、`name`、`sourceChecksum`、`replayed` 和 `report`。业务失败检查 `ok=false` 和 `code`。

导入创建新素材；同名自动添加副本后缀。它不覆盖任何已有素材。之后通过 `get_asset(include_document=true)` 读取当前版本，调用 `inspect_asset` 核对当前质检结果，需要编辑时传最新 `currentVersionId`；需要修复时仍走 preview/commit。

幂等键为 1..128 个 ASCII 字母、数字或 `_.:-`，在同一工作区的文件导入操作内唯一，与生成任务键分开。键绑定项目、格式、源字节 SHA-256 和补齐默认值后的 options；**素材、初始版本与收据在同一 SQLite 事务中提交**。跨进程并发、重启或响应丢失后，相同键和请求返回原始素材/初始版本，`replayed=true`；修改任何绑定输入会返回 `idempotency_conflict`。新键代表另一次导入。

收据保存最初的版本和名称；随后重命名或编辑不会让重试返回新版本。`report` 每次针对该初始版本和当前读取的项目配置重新质检，因此 finding ID、configHash 或 findings 可以变化，整个响应不是逐字节重放。删除原素材/版本后保留冲突收据，旧键不能重建素材。收据没有自动过期；备份工作区时一并保留。

PNG 原文件在提交前以 SHA-256 命名保留到 `sources`，采用临时文件原子替换，避免并发读取半写文件。失败或崩溃可能留下未引用的源文件；未实现自动清理。ZIP 不解压到文件系统；来源元数据不会触发服务器文件读取。

## 权限与边界

OAuth 预检要求 `pixelart:read` 和目标项目授权；导入还要求 `pixelart:write` 与进程 `--allow-write`。沿用统一审计与读写限流。开启二次确认时，本机操作者审阅完整参数（包含 base64），批准后才能导入；幂等重试也需要新的确认，不能绕过授权。确认参数属于独立的短期确认存储，参数不会进入审计日志。

当前没有任意远程 URL 获取、服务器路径读取或分块上传。预检属于建议性检查，不是可提交的持久化 token；导入会重复验证实际请求并读取项目配置。通用写入幂等与其他 P0 接入工作继续保留在 [TODO](todo.md)。

## 项目备份导入（0.8.0）

项目备份通过单独的 `preview_project_import` / `import_project_backup` 工具处理，不作为 `import_asset_file.file_format` 的选项。能力发现新增 `projectImportFormats=[pixelart-project-v1]`、`project-backup-preview` / `project-backup-import`，合同资源为 `pixelart://contract/project-imports/v1`。

输入为 PixelArting 桌面导出的 `pixelart-project` v1 ZIP，scope 必须为 `current-versions`。调用 `preview_project_import(data_base64, name?)` 审阅项目名、配置和逐素材的来源 ID、帧/图层数及质检；预检不打开业务 Store、不创建项目/素材或保留源文件，OAuth 模式仍记录安全审计。可选 name 为 1..80 字符，去除首尾空白后不能为空。预检报告使用备份中携带的项目配置。

审阅后调用 `import_project_backup(data_base64, idempotency_key, name?)`。它创建**新的项目、素材和版本 ID**，恢复配置与所有已备份的当前文档，包括图层、像素、越界像素、动画与帧元数据。不会覆盖已有项目，也不恢复旧版本历史、生成任务、API Key 或 PNG 原文件；原文件引用仅作为来源元数据保留。空项目备份也可恢复配置。

成功对象直接位于 `structuredContent`：`ok`、`contractVersion`、`project={id,name,created}`、`sourceChecksum`、`replayed`、`assets`。assets 各项包含新 `assetId` / `versionId` / `name`、来源 `sourceAssetId` / `sourceVersionId` 和质检 `report`。导入后读取素材并 `inspect_asset`；继续编辑时取得最新 currentVersionId。

原始文件上限仍为 2 MiB，解压累计 16 MiB，最多 64 个素材；**1,048,576 像素预算对整个项目的帧宽×高×图层数累计生效**。先校验所有文档再写入，项目、配置、全部素材/初始版本及幂等收据在同一事务提交。任何一项验证或数据库写入失败都会回滚，不创建半个项目。ZIP 只在内存解析，不向服务器目录解压。

幂等键规则与文件导入一致，但使用独立的项目导入命名空间。键绑定原始字节 SHA-256 和去空白后的可选 name；重启/并发重试复用最初的项目、素材及版本，返回的名称也是初始名称，不回滚后来修改。报告针对初始版本，使用每次读取的已恢复项目当前配置重算。删除项目、任一初始素材或初始版本后重试返回 `idempotency_conflict`，不补回已删除内容；收据没有自动过期。改变文件或指定名称需要新键。

OAuth 预检要求 `pixelart:read + pixelart:admin`；导入还需 `pixelart:write`、进程 `--allow-write` 和已配置的一次性写入确认。管理员 scope 不隐含 write。确认绑定完整 base64、键和名称，重复导入也必须重新确认。新项目不自动加入任何普通主体的项目 grant；管理员可访问，其他主体需要操作者自行配置授权。无 OAuth 的本机模式按进程所有者权限运行。
