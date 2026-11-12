# PixelArting

面向游戏素材的独立桌面像素工作台。首期配置为 64×64、多图层、Godot 4.7.2；Electron 窗口承载 React 界面并管理本地 Python 服务。AI 素材生成支持像素工具绘制和图像模型两种模式，详见 [AI 素材生成](docs/ai-generation.md)。

## 运行

后端要求 Python 3.12，前端构建要求 Node.js 18 或更高版本。安装桌面运行时要求 Node.js 22.12 或更高版本。

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm --prefix frontend install
npm --prefix frontend run build
```

桌面窗口（首次安装 Electron，后续直接启动）：

```bash
npm --prefix desktop install
npm --prefix desktop run setup
sh desktop/start.sh
```

开发时可使用热更新桌面模式：

```bash
sh desktop/start-dev.sh
```

该模式会自动启动 Vite 开发服务器和私有后端，保存 React/TypeScript/CSS 文件后由 Electron 自动刷新；普通 `desktop/start.sh` 仍使用构建后的 `frontend/dist`。

Linux 可使用 `desktop/PixelArting.desktop` 启动；该文件包含当前工作区路径，移动项目后需更新。桌面端自动选择私有 loopback 端口、启动后端，并在窗口关闭后停止该进程；未保存时先确认。当前为工作区启动版，尚未打包 Python 运行时和跨平台安装包。详情见 [桌面客户端](docs/desktop-client.md)。数据保存到 `data/pixelart.sqlite3`，原始 PNG 保存在 `data/sources/`；环境变量 `PIXELART_DATA_DIR` 可改变数据目录。

当前不提供独立浏览器启动入口；React 构建产物只由 Electron 窗口加载。AI 生成使用 SQLite 持久化任务队列和有界本地执行器，暂没有 Redis、多用户登录和公网部署能力；应用重启会恢复未完成任务。AI API Key 优先保存到操作系统密钥环，旧 SQLite 配置会在启动时迁移；无可用密钥环时保留 SQLite 兼容回退。

## 当前功能

- 项目、新建透明素材与 PNG 素材上传；自定义画布 1..512，默认 64×64；规则 Sprite Sheet 切分，最多 64 帧。
- 素材列表显示真实缩略图、尺寸、帧数和图层数；素材删除须确认，删除全部版本并校验当前版本，不能撤销。
- 素材项与素材栏空白处右键菜单分开；支持素材重命名、应用内完整快照复制/粘贴、创建副本、目标导出和版本入口，复制保留多图层与动画。
- 多图层新建、PNG 图层导入、顺序、名称、显示、锁定、不透明度和删除，最多 16 层。
- 铅笔、橡皮、取色、填充、直线、矩形、椭圆、矩形选区、画布移动与单图层拖动；铅笔和橡皮支持 1..16 像素粗细及方形/圆形笔刷，铅笔支持 1..100% 不透明度，选择会在本地保留；选区支持复制、剪切、粘贴、删除、拖动和方向键单像素移动；原点/基线参考标记、颜色选择、整数缩放、网格、25 步草稿撤销/重做及 `Ctrl/Cmd+Z` 快捷键。未保存编辑会在本地自动保存，可在重新打开素材时选择恢复或丢弃，恢复后仍需显式保存才会生成正式版本。
- 画布、图层、帧和素材区右键菜单；图层复制、重命名和导入 PNG 为新层；菜单支持方向键和 Escape。
- 帧复制/删除/前后排序、动作/方向映射、当前动作帧时长和动画播放。
- 8 条规则的启用/禁用、跳过原因与问题位置；5 个确定性修复的预览/确认。
- 不可变版本、无变化保存不建新版本、版本冲突检查、以 previewId 为幂等键确认和历史恢复。
- 当前帧 PNG、带分层 PNG 和 Sprite Sheet 的 JSON ZIP、Godot SpriteFrames ZIP。
- 可选的 OpenAI-compatible AI 生成：文本模型输出受限制的像素工具命令，或图像模型返回 PNG 后本地像素化；候选确认后才导入为素材。

首次进入会创建两图层的原创示例素材；示例为单图，不冒充完整四方向动画。PNG 无法自动恢复图层，初次上传建立一个原始图层，其他层可以手动添加。

PNG/引擎导出合成可见图层，隐藏层不显示但仍保留在分层包中。锁定层不能绘制或被修复动作改写；图层不透明度可能产生新的颜色和半透明像素，二值化源像素不会自动改掉图层不透明度，必须以重检结果为准。

Godot ZIP 解压后包含 `pixelart_<assetId>/spriteframes.tres`、帧图、层图和 JSON；整个目录放进 Godot 项目根目录，再加载资源。SpriteFrames 只表达合成帧、动作和时长；原点、碰撞数据和图层保留在 JSON 中，不自动创建角色场景。

## 验证与限制

```bash
.venv/bin/python -m pytest backend/tests -q
npm --prefix frontend run build
```

渲染界面回归测试（使用隔离的临时数据目录和临时端口）：

```bash
cd frontend
npx playwright install chromium
npx playwright test
```

设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 可以复用现有 Chromium。设置 `PIXELART_GODOT_BINARY` 为 Godot 4.7.2 可执行文件的路径后，pytest 会额外执行引擎导入回读；未配置时该测试跳过。

桌面服务生命周期和窗口回归（需要可用的图形会话及已安装的 Electron）：

```bash
npm --prefix desktop test
cd frontend
npx playwright test --config desktop.playwright.config.ts
```

桌面界面使用固定的 `pixelart://workbench/` 地址，重启后保留本地草稿和配置。本地服务端口记录在 Electron 用户数据目录；若端口被其它程序占用，服务会选择新的空闲端口，界面存储地址保持不变。

上传 PNG 最大 8 MB，单帧最大 512×512，Sheet 最大 2048×2048，请求最大 20 MB，分层总像素数最多 8,388,608。接口文档位于 `/docs`。

尚未实现：客户生产级 MCP 接入（真实客户 OAuth/TLS 与宿主确认流程验收、租户路由、镜像发布、任务事件）、原生 Aseprite 格式、完整高级混合模式、碰撞框交互编辑、引擎插件。当前 MCP 已可独立安装，用于本地工作流或配置了 OAuth 的单工作区进程；审计与接入路线见 [AI 工作流接入审计](docs/agent-integration-audit.md)。Godot 导入验证状态见 [实现状态](docs/implementation-status.md)。

## Agent / MCP 集成

独立包 `pixelarting-mcp 0.11.0` 无需 Electron/Node.js，默认只读，可供标准 MCP 客户端调用项目、素材、版本、质检、修复和导出能力。全部 JSON 工具提供逐字段输出 schema，保留现有返回形状。在源码目录安装后运行：

```bash
.venv/bin/pip install .
.venv/bin/pixelarting-mcp --data-dir /absolute/path/to/workspace --read-only
.venv/bin/pixelarting-mcp --schema
```

0.9.0 的 `get_permissions` 和发现项授权元数据公开当前 scope、项目边界、写门禁与确认要求，与服务端授权共用声明。客户端可据此判断调用前提；实际目标仍在每次调用时校验，详见 [权限合同](docs/mcp-permissions.md)。

升级到 0.4.0 时，旧版仅在全局钥匙串保存的默认 provider 密钥需要在所属工作区重新保存，以完成凭据隔离；见 [升级说明](docs/mcp-security.md#040-凭据隔离与升级)。

客户端配置使用可执行文件和数据目录的绝对路径。需要 agent 修改素材时，所有者显式启用 `--allow-write`。独立入口默认使用用户数据目录；共享桌面素材时应显式指向桌面使用的 `data/`。原有 `.mcp.json` 和 `python -m backend.mcp_server` 入口保持兼容。

非 root 容器构建、Linux OAuth HTTP Compose、持久化卷和真实旧 wheel 的升级/离线回滚验收见 [部署文档](docs/mcp-deployment.md)。当前镜像需自行构建，尚未发布。

支持本机 Streamable HTTP、能力发现、持久化生成任务、候选预览/收藏/淘汰/导入，以及基于不可变版本的 PNG/ZIP 资源读取。[文件导入](docs/mcp-imports.md) 支持 PNG/Sheet、分层 ZIP 和项目备份的只读预检、质检及持久化幂等导入；项目备份以新 ID 恢复配置与素材当前版本，OAuth 下要求管理员权限。生成提交和重试需要幂等键；生成使用本地已配置的 provider，可能产生费用。可选 OAuth JWT、项目授权、审计、限流和服务端写入二次确认配置见 [HTTP 安全接入](docs/mcp-security.md)。全部写工具现已提供幂等键和可发现的重放规则，可靠重试应传键并保留原参数，见 [写入幂等](docs/mcp-idempotency.md)。0.11.0 新增 [Workspace HTTP API v1 与 OpenAPI](docs/workspace-api-v1.md)，供普通 HTTP 工具和插件接入同一套授权及幂等规则。任务推送事件和完整客户部署验收仍待完成。安装、客户配置、工具清单见 [MCP 文档](docs/mcp.md)，字段和兼容约定见 [本地 v1 合同](docs/mcp-v1.md)。

