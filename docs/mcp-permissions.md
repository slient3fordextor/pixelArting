# MCP v1 权限合同

从服务版本 0.9.0 起，客户端可发现逐工具/资源的授权要求，也可查询当前身份的 scope、项目边界和进程门禁。服务端授权与发现共用一份声明；每次调用仍重新检查权限。

## 发现入口

- `tools/list`、`resources/list`、`resources/templates/list` 的 `_meta["pixelarting/authorization"]` 提供静态规则；CLI `--schema` 采用相同 wire 字段 `_meta`。
- `pixelart://contract/permissions/v1` 提供完整规则、当前身份输出 schema 和授权策略。入口合同与安全合同通过 `permissionsContractUri` 指向它。
- 只读工具 `get_permissions` 的 `structuredContent` 直接返回当前有效权限。OAuth 要求 `pixelart:read`，本地模式无需 OAuth。查询不打开素材数据库；OAuth 审计和调用预算仍执行。

静态工具元数据示例：

```json
{
  "requiredOAuthScopes": ["pixelart:read", "pixelart:write"],
  "write": true,
  "projectPolicy": "asset-owner",
  "projectPolicyDescription": "Resolve asset_id server-side and require access to its owning project.",
  "argumentPaths": ["asset_id"]
}
```

`requiredOAuthScopes` 必须全部满足。`argumentPaths` 描述项目授权参数；素材/任务所属项目由服务端查询，客户端不能另传项目来替换所有权。

## 当前身份与门禁

返回字段包含 `authentication`、`effectiveOAuthScopes`、`projectAccess`、`projectIds`、`processWriteEnabled`、`writeConfirmationRequired`，以及逐工具和资源规则。每个工具有三个独立标志：

| 字段 | 含义 |
| --- | --- |
| `scopeAllowed` | token/grant 交集是否包含全部必需 scope；本地进程所有者为 true |
| `writeGateAllowed` | 只读工具为 true；写工具取决于进程 `--allow-write` |
| `confirmationRequired` | 是否受已配置的一次性写入确认约束；不表示已有批准，也不因 scope 不足而改为 false |

这些标志是独立前提。即便前两项都为 true，具体目标的项目权限、存在性、版本、领域校验、预算、审计和确认仍可能拒绝操作。客户端不能将查询结果缓存为授权凭证。

本地模式的 `effectiveOAuthScopes=[]`、`projectAccess=workspace` 表示信任进程所有者，写门禁仍生效。OAuth 的有效 scope 是 token 与服务端 grant 的交集；有效 admin 对应 `workspace` 和空项目列表，其余为 `explicit-projects` 及排序后的 grant 项目 ID。这些 ID 不能证明项目存在；token 丢弃 admin 后不会继承工作区访问权。

## 工具和项目边界

| 操作组 | 必需 scope | 项目要求 |
| --- | --- | --- |
| 发现、健康、项目列表 | read | 项目列表按 grant 过滤 |
| 素材/配置/报告/质检/预览/导出、文件预检 | read | 指定项目或素材所属项目必须允许 |
| 素材/配置修改、修复预览/提交、恢复、文件导入 | read + write | 检查项目或素材所有权 |
| 生成 start/retry | read + write + generate | 请求/原任务所属项目；无项目任务要求 admin |
| 任务读取、候选预览 | read | 原任务所属项目；无项目任务要求 admin |
| 任务取消、候选状态更新 | read + write | 原任务所属项目；无项目任务要求 admin |
| 候选导入 | read + write | 同时检查来源任务和目标项目；目标缺省使用来源项目 |
| 新建项目、项目备份导入 | read + write + admin | 工作区级操作；导入不自动添加 grant |
| 项目备份预检 | read + admin | 不要求 write 或写门禁 |

表中 scope 省略 `pixelart:` 前缀。任务列表先按项目授权过滤再应用条数限制，显式项目过滤先检查授权。资源均要求 read：导出检查素材所有权，任务/候选资源检查任务所有权。逐项规则以发现结果为准。

admin 不隐含 write 或 generate。`preview_asset_repair` 保存预览，属于写工具。启用确认后，每次写入包括幂等重放都需新批准；权限查询没有批准或自授权能力。详见 [安全接入](mcp-security.md)。

## 一致性和兼容

服务端用不可变登记表执行 OAuth 拦截并生成发现结果。未登记工具/资源在 OAuth 下拒绝；发现阶段也拒绝遗漏登记或读写注解与规则不符的配置。修改返回的元数据不能改变权限。

v1 兼容新增，客户端应容忍新工具、资源和字段。返回值不含主体标识、token、provider 配置或本地路径。真实客户授权服务器、TLS 与宿主验收仍见 [TODO](todo.md)。
