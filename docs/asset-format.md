# 统一素材格式与版本约定草案

状态：多图层设计规格，原型使用 Pydantic 模型；已支持 PNG 输入及应用导出的分层 PNG + JSON ZIP 素材包回导入。以下 JSON 是交换格式示例，不支持单独 JSON 文件回导入，实现情况见 [实现状态](implementation-status.md)。

范围依据 [MVP 规格](mvp-spec.md)，质检和修复依据 [规则规格](quality-rules.md)。数据库列名可使用 snake_case，交换 JSON 统一使用 camelCase，必须显式映射。

## 1. 资源层次与职责

| 对象 | 职责 |
|---|---|
| Project | 用户所有权、目标画布、风格/调色板引用、默认检查配置 |
| Asset | 稳定的素材 ID、项目归属、名称、类型、原始来源引用和当前版本指针 |
| AssetVersion | 不可变的像素与元数据快照、父版本、操作和来源记录 |
| Frame | 版本内稳定 ID、单帧图像引用、实际尺寸、原点、可选基线和碰撞数据 |
| Animation | 动作和方向、帧的有序引用、每次引用的时长、loop 标志 |
| QualityReport | 指定版本的完整配置/规则版本快照、执行状态与问题 |
| ExportBundle | 指定版本与导出配置的派生产物、文件清单和 checksum |

宽高、帧数、调色板和文件引用属于版本快照，不只放在 Asset 上。Asset 的展示摘要可以缓存当前版本的信息，但读取旧版本时必须使用其自身元数据。

MVP 素材类型为 `character` 和 `image`。角色版本允许不完整，完整角色是否合规则由配置和目标导出检查决定；普通单图不强制具备四方向。

## 2. 图像与坐标

- 内部图像按 RGBA8、直通 alpha 表示；PNG 的完整透明/不透明值分别为 0/255。
- 坐标原点是单帧画布左上角，x 向右、y 向下，单位为整数像素。
- `width/height` 是正整数；问题区域与碰撞矩形表示半开区间 `[x, x + width)`、`[y, y + height)`。
- 原点是像素位置：`0 <= x < width`、`0 <= y < height`；基线是人工确认的像素行，`0 <= baselineY < height`。
- 碰撞框宽高须大于零，可以贴住画布边界但不能超出；MVP 只规定可选矩形数据，不生成或判断语义碰撞范围。
- 原点为 null 表示未设置，不默认冒充 `(0, 0)`；需原点的导出配置在导出前要求补齐。
- 图像中的色彩转换不能作为隐式质检修复。MVP 输入色彩约束建议限制为 8 位 sRGB PNG；其他位深或色彩配置先拒绝，支持策略待实现前确认。

解码并保存每帧实际尺寸，不强制先改为 64×64。尺寸错误也可以形成可质检的版本。格式识别和规范化不做缩放、颜色量化、去边、裁切或帧对齐，这些均需显式修复版本。

## 3. 帧、动画与调色板

Frame ID 在同一素材的派生版本中尽量稳定；检查与动画使用 ID，数组位置不代表帧序。删除帧后不能复用其 ID 指向不同内容。

动画以 `(action, direction)` 唯一识别。MVP 动作为 `idle/walk`，方向为 `down/left/right/up`；`frames` 数组给出明确顺序，每个引用含正整数 `durationMs`，可以重复引用同一帧。编辑器可显示从 0 开始的序号，但接口不靠序号识别帧。

`loop` 只说明播放模式，不保证首尾姿态自然。一次性/循环语义、帧数和时长的验收约束来自配置快照。

调色板保存有序的 `#RRGGBB` 列表及引用 ID/版本，不允许重复 RGB。alpha 独立于调色板。帧统计只计 alpha 大于 0 的 RGB；透明像素不会占用颜色额度。

MVP 支持多图层。版本保存全局有序 `layers`，从底到顶，每层有 ID、名称、visible、locked 和 0..255 的 opacity；每帧 `pixels` 按层 ID 保存独立 PNG，所有层都与当前帧画布等大。新增层必须为所有帧建立图像，未提供内容时使用透明画布。

合成使用正常 source-over，不包含复杂混合模式。PNG/引擎导出使用可见层合成图，`imageRef` 指向合成图；分层包的 `pixels` 引用每层原图。隐藏层仍保存并可恢复，锁定保护编辑和修复。原生 Aseprite 等分层格式属于后续导入/导出能力。

## 4. Sprite Sheet 输入与输出

上传 Sheet 时保存 `cellWidth/cellHeight`、`columns/rows`、`marginX/marginY`、`spacingX/spacingY` 和每个单元格的动作/方向/序号映射。MVP 不假设某个引擎的排布就是所有输入的排布。

布局必须满足：

```text
sheetWidth  = 2 * marginX + columns * cellWidth  + (columns - 1) * spacingX
sheetHeight = 2 * marginY + rows    * cellHeight + (rows    - 1) * spacingY
```

单元格尺寸、行列数为正整数，边距和间距为非负整数。尺寸不符时要求用户修正布局；不静默裁掉剩余边缘。未映射单元格保持可预览状态，用户确认忽略后才创建角色动画映射。

PNG Sheet 导出使用明确的确定性排序：方向 `down/left/right/up`，每方向动作 `idle/walk`，最后按动画内顺序。JSON 记录每个引用对应的区域和时长，不能靠读取者猜测。同一帧多次出现时允许重复单元格；Godot 适配器按自己的布局导出，但保留动作、方向、顺序和时长语义。

## 5. 版本示例

以下为仅包含一个方向 idle 的不完整角色，用于说明字段；不能作为完整 MVP 角色验收样例。

```json
{
  "schemaVersion": "1.1",
  "assetId": "asset_1",
  "versionId": "version_1",
  "parentVersionId": null,
  "type": "character",
  "operation": {"type": "upload", "parameters": {}},
  "layers": [{"id": "base", "name": "角色", "visible": true, "locked": false, "opacity": 255}],
  "palette": {
    "id": "palette_1",
    "version": "1",
    "colors": ["#202020", "#E0C080"]
  },
  "frames": [
    {
      "id": "frame_down_idle_0",
      "imageRef": "frames/down_idle_0.png",
      "width": 64,
      "height": 64,
      "pixels": {"base": "layers/base/down_idle_0.png"},
      "origin": {"x": 32, "y": 59},
      "baselineY": 59,
      "collisionRects": [{"x": 10, "y": 12, "width": 12, "height": 16}]
    }
  ],
  "animations": [
    {
      "action": "idle",
      "direction": "down",
      "loop": true,
      "frames": [{"frameId": "frame_down_idle_0", "durationMs": 200}]
    }
  ],
  "provenance": {
    "kind": "upload",
    "originalRef": "sources/source_1.png",
    "licenseStatus": "unknown"
  }
}
```

图像引用是包内相对路径或存储层解析的资源引用，不能是本机绝对路径，不能含路径穿越。示例中无图像实体，实际交换包必须携带所引用文件及文件清单/checksum。模型凭据、下载签名和私有提示词正文不应默认出现在导出包中。

## 6. 不可变版本与编辑草稿

Asset 使用 `sourceVersionId` 记录首次可编辑版本，使用 `currentVersionId` 指向当前保存版本；原始字节文件另存为不可变来源对象。解码失败时可保存来源对象，但不创建可编辑版本。

- 上传、生成、保存编辑、确认修复产生新版本；旧文件、帧和元数据不被覆盖。
- 草稿撤销/重做只操作未保存编辑历史；保存后创建一个新版本。持久化版本恢复通过切换当前指针完成，不改写旧版本。
- `parentVersionId` 指向实际编辑基线；从历史版本编辑创建分支，MVP 不做自动合并。
- 更新当前指针携带 `expectedCurrentVersionId`，不匹配时报冲突；恢复版本也遵循相同检查。
- 修复任务固定输入版本，预览后并发修改必须重新预览；不将旧预览自动套到新版本上。

版本发布必须在图像、元数据和文件清单保存成功后完成；任何步骤失败都不能指向半成品。暂存对象的回收策略和保存上限属于后续运行规格。

## 7. 校验值与可复现性

保留原始文件字节的 SHA-256 用于来源校验；每个帧另记录解码 RGBA 像素和尺寸的 checksum。PNG 编码器可能写出不同文件字节，不以文件字节相等代替像素相等。

版本内容 checksum 由规范化内容清单计算，包含 schema 版本、图层顺序及属性、各层像素校验值、帧 ID/尺寸/元数据、动画有序引用和调色板顺序；排除版本 ID、存储路径、时间戳和可变当前指针。规范化序列化算法必须固定并用样例验证。

修复记录额外保存动作 ID/版本、参数、执行顺序、基础版本 checksum 和执行器版本。模型结果记录提供方、模型版本、提示词引用及 hash、参考图 hash、参数和可用 seed；这只能支持追溯，不保证随机生成可复现。

## 8. 质检与导出绑定

QualityReport 绑定 `assetVersionId`，保存完整配置快照、配置 hash、规则版本和各规则执行状态。`profileId` 仅为来源引用，配置修改不能改变已有报告。旧 Finding 不用 `resolvedAt` 原地改写；修复结果以新版本的新报告及比对关系表示。

导出也固定版本及目标配置，不默认跟随不断变化的当前版本。包清单包含格式版本、目标引擎版本、路径、文件 checksum，以及哪些元数据被支持/忽略。适配器不得默默丢掉用户需要的原点或碰撞信息；不支持的字段需明确提示或拒绝该导出配置。

Godot SpriteFrames 导出不等于完整角色场景导出；原点、碰撞数据和图层保留在伴随 JSON 中，自动创建完整碰撞场景属于后续能力。目标 Godot 版本为 4.7.2，兼容性以该版本的导入回读结果为准。

读取未知 `schemaVersion` 应明确拒绝，不能假设兼容。后续格式升级需转换副本并产生新版本，原始文件和历史版本保持可追溯。
