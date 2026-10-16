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

当前不提供独立浏览器启动入口；React 构建产物只由 Electron 窗口加载。首版使用有界同步处理，没有 Redis、任务队列和登录功能；仅用于本地单用户，不能直接暴露到公网。

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

尚未实现：多用户隔离、原生 Aseprite 格式、JSON 包回导入、复杂混合模式、Sheet 边距/间距、碰撞框交互编辑、引擎插件。Godot 导入验证状态见 [实现状态](docs/implementation-status.md)。

