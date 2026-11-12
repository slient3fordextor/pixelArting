# MCP Inspector 验收

Inspector 是开发验收工具，不是产品运行时依赖；独立 MCP 用户仍只需要 Python 或容器。工具命令以 [Inspector CLI 官方说明](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/cli) 为依据，本仓库固定 Inspector 2.14.0，并锁定其 npm 依赖。

## 安装与运行

切换到符合 `tools/mcp-inspector/package.json` engines 的 Node 环境后安装。当前实际验证使用 Node 22.23.4，未修改系统或桌面前端的 Node：

```bash
npm ci --prefix tools/mcp-inspector --ignore-scripts --omit=optional
.venv/bin/python scripts/verify_mcp_inspector.py \
  --node /absolute/path/to/node \
  --inspector tools/mcp-inspector/node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js \
  --server /absolute/installed-venv/bin/pixelarting-mcp
```

服务应由对应 wheel 安装在独立虚拟环境。脚本从临时目录运行，不通过 PYTHONPATH 添加仓库源码；Inspector 路径先转换成绝对路径。验证失败时命令非零退出，不关闭 Inspector 的输出校验来获得通过。

CLI 通过临时配置选择读/写 stdio 服务及 OAuth HTTP 角色，每次请求都连接实际服务。`--stored-auth-only` 禁止交互登录/权限升级；`MCP_INSPECTOR_SECRET_STORE=memory` 防止验收令牌保存进用户的 Inspector 凭据文件。仅用临时签名密钥和假身份，不请求外部 AI provider、不打开浏览器。业务数据和服务进程由脚本创建并清理。

## 验证范围

| 场景 | 核对内容 |
| --- | --- |
| 初始化/发现 | stdio 与 Streamable HTTP 连接，工具目录、注解、资源目录，`tools/list --strict` schema 可移植性检查 |
| 权限发现 | 静态授权元数据、权限合同资源、本地写门禁，以及 OAuth reader/writer/admin 的有效 scope、项目边界和确认条件 |
| 兼容性 | 对象/列表/原生 image 内容，结构化业务输出按公开 schema 校验；实际协商协议 2025-11-25 |
| 写门禁 | 只读进程不能创建项目，且不会创建业务记录 |
| 修复链路 | 读取当前版本/文档 → 审阅尺寸变化和预览报告 → 提交 → 质检 → PNG 资源读取 |
| 重放/冲突 | 带键新建项目/空素材跨连接重放，修复提交复用原响应/报告；旧版本新写入拒绝覆盖，HTTP 带键改名重放仍需新确认 |
| 文件导入 | PNG/分层 ZIP 导出资源 → 只读预检 → 写入 → 新连接重放复用初始版本 → 质检；只读进程拒绝导入 |
| 项目备份 | 用实际分层 ZIP 构造项目备份 → 逐项预检 → 原子导入 → 新连接重放 → 质检；HTTP 普通 writer 拒绝，admin 审阅/确认后导入，重试需要新确认 |
| OAuth | reader 初始化/读取成功、写入被拒绝，writer 通过本机确认后才写入；匿名请求无法初始化 |
| 确认协议 | 工具错误的文字和 `_meta["pixelarting/writeConfirmation"]` 可被严格客户端接收，操作者审阅/批准后相同调用成功 |

0.10.0 已用独立 wheel、Inspector 2.14.0 和 Node 22.23.4 通过上述范围，新增带键项目/空素材跨连接重放、修复提交原响应/报告重放及 HTTP 改名重放重新确认。保留逐工具权限元数据、当前身份查询和项目备份、PNG/分层 ZIP 链路。测试刻意设置无效的父进程 PYTHONPATH，子进程移除它，避免回落到仓库源码；归档夹具只用标准库包装真实导出，不引入源码 backend。JSON 工具字段类型测试另用 JSON Schema validator 核对实际响应、文档缺省字段和旧报告。Inspector 不替代后端全量测试，也不替代客户授权服务器、HTTPS、浏览器授权、MCP Apps widget 或真实客户宿主验收。

## 确认错误的兼容修复

Inspector 会校验任何已提供的 structuredContent，包括 `isError: true` 的工具错误。0.5.0 的确认暂停把 `{error, confirmation}` 放在业务 structuredContent 内，严格客户端会因该内容不符合工具的输出 schema 而拒绝展示请求。

0.6.0 保留 HTTP 200 与 `isError: true`，将确认详情移至 MCP `_meta`，文字中保留错误名、requestId 和 digest，不提供业务 structuredContent。Inspector 因此可以展示待确认请求，而正常业务响应仍必须通过严格 schema。旧专用客户端应按 [确认迁移说明](mcp-security.md#050-写入二次确认) 调整读取位置。

当前记录仅覆盖 CLI 的上述自动化链路；Inspector 浏览器 UI、真实客户 AS/TLS 和客户宿主仍未验收。
