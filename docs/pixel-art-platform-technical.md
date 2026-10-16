# AI 像素素材平台技术文档

状态：目标架构，已实现本地上传处理原型，当前覆盖见 [实现状态](implementation-status.md)。范围与阶段以 [MVP 规格](mvp-spec.md) 为准，规则行为以 [质检规格](quality-rules.md) 为准，数据语义以 [素材格式](asset-format.md) 为准，语言和跨引擎边界以 [技术选型](technology-selection.md) 为准。

## 1. 技术目标

构建一个可替换生成模型、可独立开关质检规则、支持自动修复并能导出多种游戏引擎格式的素材处理平台。

核心原则：

- 生成、编辑、质检、修复和导出模块解耦
- 质检规则采用插件化接口
- 自动修复必须可预览、可撤销、可重复执行
- 同一素材的每次变更都可追踪和恢复
- 确定性处理优先使用算法，AI 只处理需要语义判断的部分

## 2. 总体架构

下图表示职责划分，不要求每个 service 独立部署。MVP 采用 Python/FastAPI API 加 Python worker；前端和引擎插件通过版本化 HTTP/JSON 协议接入。完整语言取舍和 Go 的后续使用边界见 [技术选型](technology-selection.md)。

```text
Web Client / Engine Plugin
          |
      API Gateway
          |
  Project and Asset Service
          |
  Generation Orchestrator ---- Model Adapters
          |
  Asset Normalizer
          |
  Quality Rule Engine
          |
  Repair Executor
          |
  Export Adapter Layer
          |
 Object Storage / Metadata DB / Job Queue
```

### 2.1 客户端

- Web：项目、素材、质检报告、像素编辑器和导出
- Godot 插件（MVP 之后）：使用 GDScript 或 C#，通过统一协议在编辑器内生成、扫描、修复和导入
- CLI（MVP 之后）：可先使用 Python；Go CLI/本地 agent 只有在技术选型中的门槛满足后再引入

### 2.2 服务端模块

- `project-service`：项目、成员、风格规范和检查配置
- `asset-service`：素材、版本、帧、图层和引用关系
- `generation-service`：提示词、参考图、模型调用和任务状态
- `normalizer`：尺寸、颜色、透明度、格式和帧结构标准化
- `quality-engine`：规则发现、执行、报告和配置管理
- `repair-service`：执行修复计划，生成新版本
- `export-service`：PNG、JSON、Aseprite、Godot、Unity 和 RPG Maker 导出

## 3. 规则引擎设计

### 3.1 规则接口

```python
class QualityRule(Protocol):
    id: str
    version: str
    scope: set[str]

    def check(self, asset: Asset, context: CheckContext) -> list[Finding]: ...

    def can_fix(self, finding: Finding) -> bool: ...

    def build_fix(self, finding: Finding, context: FixContext) -> FixPlan: ...
```

规则不应直接修改素材。规则只负责发现问题和生成修复计划，实际变更由 `RepairExecutor` 统一执行。

### 3.2 Finding 数据结构

```json
{
  "ruleId": "transparency.halo",
  "ruleVersion": "1.0.0",
  "id": "finding_1",
  "reportId": "report_1",
  "severity": "warning",
  "assetVersionId": "version_123",
  "frameId": "frame_down_walk_0",
  "region": {"x": 12, "y": 8, "width": 6, "height": 4},
  "message": "当前配置禁止半透明，发现半透明像素",
  "canAutoFix": true,
  "fixIds": ["remove-halo-v1"]
}
```

严重等级建议：`info`、`warning`、`error`、`blocking`。

### 3.3 规则注册

```python
registry.register(SizeRule())
registry.register(PaletteLimitRule())
registry.register(PaletteMembershipRule())
registry.register(TransparencyRule())
registry.register(AnimationStructureRule())
registry.register(AnimationBaselineRule())
registry.register(AnchorBoundsRule())
registry.register(ExportIntegrityRule())
```

规则元数据应包含名称、说明、适用素材类型、依赖条件、默认状态和支持的修复动作。

以上为接口示意，不是可运行实现；具体 8 个规则 ID、参数、跳过和修复行为见 [质检规格](quality-rules.md)。抗锯齿启发式检测、Tileset 和语义漂移不属于 MVP 确定性规则。

### 3.4 开关和配置

```json
{
  "profileId": "godot-strict",
  "rules": {
    "size.grid": {"enabled": true, "severity": "error"},
    "palette.limit": {"enabled": true, "maxColors": 32},
    "palette.membership": {"enabled": true},
    "transparency.halo": {"enabled": true, "allowSemiTransparent": false},
    "animation.structure": {"enabled": true},
    "animation.baseline": {"enabled": true},
    "anchor.bounds": {"enabled": true},
    "export.integrity": {"enabled": true}
  },
  "autoFix": {
    "enabled": true,
    "allowed": ["remove-halo-v1", "align-frames-v1"]
  }
}
```

规则之间可以声明依赖。例如动画规则需要明确的帧、动作和方向映射，既可以处理 Sprite Sheet 切分结果，也可以处理帧序列；不能隐式开启用户关闭的规则。

缺少前置输入时标记 skipped 并说明原因；禁用规则不执行。`autoFix.enabled` 只允许提供修复计划，MVP 仍需用户确认预览。示例省略了实际执行所需的目标画布、动画约束、调色板和导出目标；执行时必须合并完整配置并保存快照。

## 4. 处理流水线

```text
上传/生成
  -> 格式识别
  -> 标准化副本
  -> 执行启用的规则
  -> 聚合 Finding
  -> 用户选择修复
  -> 创建新版本
  -> 再次质检
  -> 导出
```

原始文件必须保留，不在原文件上覆盖修改。每次修复都产生一个不可变版本，并记录父版本和修复动作。

标准化只做解码和结构转换，保留实际尺寸、颜色和透明度；不能先修复再检查原素材。尺寸、颜色、去边和对齐变化必须属于可预览的显式修复操作。

## 5. 自动修复实现

### 确定性修复

MVP 的 5 个动作是最近邻缩放、调色板映射、alpha 二值化、透明画布补齐和帧对齐，具体 ID 与安全约束见 [质检规格](quality-rules.md)。下列算法是技术候选，其中碰撞框生成等属于后续能力。

- Pillow/OpenCV：颜色、透明度、边缘和缩放
- 最近邻算法：保持硬边和整数像素
- 颜色量化：将颜色映射到项目调色板
- 连通域分析：检测边缘残留和孤立像素
- 帧对齐：根据角色基线或重心计算偏移
- 几何分析：生成基础碰撞框和锚点

### AI 辅助修复

以下能力安排在 MVP 之后；MVP 的 AI 调用用于素材生成，不执行语义质检或 AI 修复。

- 根据项目风格判断角色是否漂移
- 识别动画中的姿态异常
- 建议调色板和相似素材的风格匹配
- 对局部区域执行 inpainting

AI 修复必须生成预览和置信度，低置信度结果默认只提供建议，不自动应用。

## 6. 数据模型

### Project

```text
id, name, owner_id, style_guide_id, default_profile_id,
created_at, updated_at
```

### Asset

```text
id, project_id, type, name, source_version_id,
current_version_id, status, created_at
```

### AssetVersion

```text
id, asset_id, parent_id, operation,
frames, animations, palette_snapshot, provenance,
model_id, prompt_hash, checksum, manifest_storage_key,
created_by, created_at
```

### QualityReport

```text
id, asset_version_id, profile_id, status,
config_snapshot, config_hash, rule_versions, rule_results,
finding_count, blocking_count, created_at
```

### Finding

```text
id, report_id, rule_id, rule_version, severity,
frame_id, region, message, fix_ids
```

这些是逻辑字段，不代表最终数据库列结构。帧尺寸和坐标属于不可变版本，旧报告不会原地写入 resolved_at；修复后生成新报告用于比对。具体 Frame、Animation、调色板、版本 checksum 和恢复行为见 [素材格式](asset-format.md)。

## 7. API 草案

```text
POST   /projects
POST   /projects/{id}/assets
POST   /assets/{id}/generate
GET    /jobs/{id}
POST   /assets/{id}/quality-check
GET    /quality-reports/{id}
POST   /quality-reports/{id}/fix
POST   /assets/{id}/export
GET    /projects/{id}/profiles
PUT    /projects/{id}/profiles/{profileId}
```

质检接口应接受 `profileId` 或内联规则配置，以支持项目默认配置和临时检查。

检查、修复和导出必须绑定明确的版本 ID。修复确认与版本指针更新携带基础版本条件，版本已变化时报冲突；修复提交使用幂等键。请求/响应结构、状态码、鉴权、分页及任务状态迁移尚未定义，需要在 API 实现前形成契约。

## 8. 异步任务和存储

- 生成、批量质检、AI 修复和大批量导出使用任务队列
- Redis 或同类队列保存任务状态和重试信息
- 对象存储保存原始文件、版本文件、预览图和导出包
- PostgreSQL 保存项目、素材、版本、规则和报告元数据
- 使用内容哈希避免重复上传和重复处理
- 生成任务必须支持取消、重试和幂等键

Redis、PostgreSQL 和对象存储是完整 MVP 的演进目标。本地原型使用 SQLite/文件存储和有界同步接口，worker 随生成/批处理加入。Python API 与 worker 必须共享规则和执行器版本；若后续加入 Go，必须通过同一固定样例集和协议兼容测试。当前输入上限见 README，后续并发上限按测试结果确定。

## 9. 引擎适配器

```python
class ExportAdapter(Protocol):
    id: str

    def validate(self, asset: Asset, context: ExportContext) -> list[Finding]: ...

    def export(self, asset: Asset, context: ExportContext) -> ExportBundle: ...
```

每个引擎适配器负责格式、命名、目录结构和元数据，不应把这些逻辑散落在核心质检规则中。

## 10. 权限和授权

- 项目级隔离，默认素材私有
- 生成记录保存模型版本、提示词、参考图哈希和许可证信息
- 导出时显示商业使用状态
- 用户上传内容和生成内容分开存储
- 对上传图片执行类型、大小和恶意文件检查
- 管理 API Key 时只保存密文或外部密钥引用

## 11. 测试策略

- 每条规则使用固定输入图片和边界案例测试
- 每个修复动作验证修复前后 checksum、尺寸和透明度
- 对规则配置测试启用、禁用和规则依赖行为
- 对每个导出适配器运行导入回读测试
- 使用真实项目资源做端到端测试
- 对 AI 判断使用人工标注的小型回归数据集

重点验收条件：

1. 禁用的规则不会产生 Finding 或消耗 AI 调用。
2. 修复失败不会覆盖原始版本。
3. 修复后再次检查可以确认问题已解决或仍然存在。
4. 同一输入、同一规则/修复版本和同一参数的确定性结果可复现；不承诺随机生成可复现。
5. 导出的 Godot 资源可以在干净项目中直接加载。

具体场景见 [MVP 验收](mvp-spec.md)。Godot 目标已指定为 4.7.2；兼容性须以该版本回读验证为准。性能与生成质量/费用门槛仍需建立。

## 12. 分阶段实现

### 阶段一：基础流水线

- Web 基础工作台与私有项目隔离
- PNG 上传
- 项目和素材版本
- 8 条确定性规则
- 5 个确定性修复
- PNG、Sprite Sheet 和 JSON 导出

### 阶段二：完成 MVP

- 多图层编辑器和动画播放
- 文本生成、角色四方向和 idle/walk 流程；生成可行性实验提前开展
- Godot SpriteFrames 和 PNG/JSON 导出验收

阶段一和阶段二共同构成 MVP。后续阶段不属于首期交付。

### 阶段三：扩展引擎与 AI 辅助能力

- Godot 插件与 TileSet 导出
- RPG Maker 适配
- CLI 批量质检
- Aseprite 和 Unity 导出
- 风格一致性检查
- 姿态漂移检测
- 局部 inpainting
- 项目风格记忆和参考图管理

### 阶段四：团队和生态

- 自定义规则 SDK
- 团队规则配置
- API 和 CI 集成
- 资产库、版本审批和审计日志
