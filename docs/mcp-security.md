# MCP HTTP 身份、项目权限与审计

从服务版本 0.4.0 起，Streamable HTTP 可作为客户现有 OAuth 2.1 授权服务器的资源服务器。默认本地模式保持原行为；启用 `--oauth-config` 后，每次 HTTP 请求都必须携带有效 access token，工具调用与资源读取还要通过服务端项目权限检查。

当前交付的是 **JWT 资源服务器适配器**，没有自建登录页、授权码、PKCE、刷新令牌或 token 签发端点。这些由客户授权服务器负责。0.5.0 新增可选的服务端写入确认；真实客户授权服务器的浏览器授权验收、令牌在线撤销/内省和完整公网部署验收仍待完成，因此 P0 安全项仍是进行中。

## 部署配置

创建由服务进程读取的配置文件，例如 `/etc/pixelarting/oauth.json`：

```json
{
  "issuer": "https://identity.customer.example/realms/assets",
  "resource": "https://assets.customer.example/mcp",
  "workspace_id": "customer-assets",
  "jwks_file": "/etc/pixelarting/public-jwks.json",
  "max_token_lifetime": 3600,
  "require_write_confirmation": true,
  "principals": {
    "user-subject-from-issuer": {
      "projects": ["existing-project-id"],
      "scopes": ["pixelart:read", "pixelart:write", "pixelart:generate"],
      "calls_per_minute": 120,
      "writes_per_minute": 30
    },
    "workspace-administrator-subject": {
      "projects": [],
      "scopes": ["pixelart:read", "pixelart:write", "pixelart:generate", "pixelart:admin"]
    }
  }
}
```

`issuer` 必须与签发者令牌中的 iss 精确一致。`resource` 是对外 HTTPS 地址，当前路径固定为 `/mcp`；不能包含查询参数、凭据或 fragment。每个进程固定一个 workspace_id 和数据目录，不根据请求参数切换数据库。两个客户应使用不同数据目录、资源地址、workspace_id 和配置；当前不是共享进程的多租户路由器。

JWKS 文件由管理员从受信任授权服务器取得，只包含公钥。每个 key 必须有唯一 kid、alg；支持 RS256（RSA 至少 2048 位）或 ES256（P-256）。拒绝私钥、对称密钥、未知算法和重复 kid。相对文件路径相对于 OAuth 配置文件解析。服务不会读取 token 中的 jku/x5u 地址，也不会在请求期间从网络下载签名密钥。

```bash
pixelarting-mcp --data-dir /srv/pixelarting/customer-assets \
  --transport streamable-http --host 127.0.0.1 --port 8765 \
  --oauth-config /etc/pixelarting/oauth.json --read-only
```

完成主机侧写入授权后可改用 `--allow-write`。进程写门禁仍优先：有 write scope 的 token 也不能绕过 `--read-only`。OAuth 模式只支持 Streamable HTTP，CLI 和运行时拒绝 stdio/SSE；本地 stdio 的权限继续由启动进程的工作区所有者授予。

当前监听器始终留在 loopback；远程客户端通过管理员部署的 HTTPS 反向代理访问公开 resource 地址。代理必须转发 Authorization、Host、Accept 和 MCP 协议头，以及 `/mcp` 与 `/.well-known/oauth-protected-resource/mcp` 路径。不要将未启用 OAuth 的入口代理到公网。服务不根据不受信任的 X-Forwarded-* 决定权限。浏览器跨域 Origin 默认不开放；尚未提供跨域配置或 MCP Apps widget。

配置与公钥在启动时固定，修改权限或轮换公钥后需重启。可先同时保留新旧公钥，在旧 token 到期后再移除旧 key。JWT 的在线撤销、动态 JWKS 轮换和配置热加载尚未实现。

### 0.4.0 凭据隔离与升级

系统钥匙串凭据现在使用数据库内持久化的工作区 UUID 命名空间，独立创建的数据目录不再共用默认档案的密钥。已有 SQLite 明文配置继续按原规则迁入该工作区钥匙串，钥匙串不可用时保留原兼容回退。

旧版本的全局 `PixelArting / ai-profile:default` 无法安全判断属于哪个工作区，**升级后不会自动读取这条旧默认密钥**。若旧默认档案的密钥只在全局钥匙串中，所有者需要在该工作区 AI 设置里重新保存一次。旧全局条目不会被删除。具有 UUID 的旧档案和任务快照凭据可按对应记录迁移一次；以后清空凭据不会因旧全局条目仍存在而自动复活。

复制完整 SQLite 数据库会保留原工作区 UUID 和配置身份。为不同客户建立工作区时应创建新数据目录，并使用项目备份导入素材，不应复制整个数据库作为客户隔离方式。

## 令牌合同

授权服务器应签发 `typ=at+jwt` 的 JWT access token，并包含：

- `iss`：固定签发者；`aud`：与 resource 完全相同的单个字符串。
- `sub`：在服务端 principals 中存在的主体；`client_id`：非空 OAuth 客户端 ID。
- `workspace_id`：与服务端配置一致的工作区 ID。
- 整数 `iat` 和 `exp`，有效期必须为正且不超过 max_token_lifetime；校验过期和未来签发时间，存在 nbf 时也校验。
- `scope`：空格分隔的权限名称。实际权限是 token scopes 与管理员 grant scopes 的交集。

仅接受 Authorization: Bearer 请求头，不接受查询字符串 token、ID token、签发给其他服务/工作区的 token 或来自未配置主体的 token。provider 的 API Key 不是 MCP access token，也不会从 MCP 参数传递给授权服务器。

服务通过 MCP SDK 提供受保护资源 metadata 与 401 challenge，metadata 公布 issuer 和支持的 scopes。身份无效或过期返回 HTTP 401；缺少 scope 返回 HTTP 403，附带所需 scope 和 metadata 地址；项目越权返回通用 HTTP 403，避免泄漏项目/素材内容。HTTP 边界遵循 [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) 的 bearer token、资源受众和发现约定。

## 权限范围

| Scope | 权限 |
| --- | --- |
| pixelart:read | 读取被授权项目、素材、版本、任务、预览与导出资源 |
| pixelart:write | 修改被授权项目中的素材、任务、候选状态和候选导入；同时需要 read 与进程写门禁 |
| pixelart:generate | 新建/重试可能产生费用的 AI 任务；同时需要 read、write 与进程写门禁 |
| pixelart:admin | 读取整个工作区项目、预检项目备份；新建项目及导入备份还需要 write 与进程写门禁。admin 不隐含 write/generate |

每个 grant 必须含 read。受限主体不能提交无项目的生成任务，也不能通过指定素材 ID、历史版本、修复预览、任务 ID 或 PNG/ZIP URI 读取其他项目。候选导入同时校验源任务项目与目标项目。项目列表只返回授权项目；任务列表在 SQL 查询限量前过滤授权项目，避免隐藏任务占用可见结果配额。

工具与资源采用集中白名单，新工具未登记授权规则时默认拒绝。`get_capabilities.writeEnabled` 反映当前主体 scope 与进程门禁；鉴权模式下健康检查不返回数据目录。`pixelart://contract/security/v1` 可发现配置 schema、scope 与审计约定。

0.8.0 的项目备份工具要求管理员 scope，因为它们恢复为新项目。`preview_project_import` 要求 read+admin；`import_project_backup` 还检查 write、进程门禁与已配置的确认，幂等重放也不免除确认。导入不会修改 OAuth 配置或给普通主体追加项目 grant；恢复后的项目默认仅管理员可访问，其他授权由操作者配置。备份不携带 provider 凭据，详见 [备份导入](mcp-imports.md#项目备份导入080)。

## 0.5.0 写入二次确认

OAuth 配置中设置 `require_write_confirmation: true` 可要求每次写调用取得本机操作者的独立确认。为保持旧配置兼容，省略时为 false；客户部署建议显式开启。`get_capabilities.writeConfirmationRequired` 和安全合同会报告是否开启。该机制覆盖所有登记的写工具，包括修复预览、任务取消、候选状态修改和付费生成；本地 stdio 模式继续由进程写门禁授权。

客户端首次提交已通过身份、scope、项目权限及进程门禁的写调用时，服务不执行业务操作，返回标准 MCP 工具错误（HTTP 200、`isError: true`）。0.6.0 将 `requestId` 和 `digest` 放在 `_meta["pixelarting/writeConfirmation"]`；文字内容以 `write_confirmation_required` 开头并提供相同字段，兼容只展示文本的宿主。此错误不包含业务 structuredContent，避免被严格宿主按成功/业务错误的输出 schema 拒绝。缺少 scope/越权仍按原规则返回 HTTP 403，不会为越权操作创建待确认请求。

0.5.0 中只读取 `structuredContent.confirmation` 的客户代码应改读上述 `_meta` 或文字字段。Inspector 的真实 OAuth 写入验证发现了这项兼容问题；0.6.0 修复它，没有放宽工具输出 schema 或关闭客户端校验。一般业务 ToolFailure 的形状保持原样。

操作者在运行服务的主机上，用同一个数据目录逐项审阅实际参数，再选择批准或拒绝：

```bash
pixelarting-mcp --data-dir /srv/pixelarting/customer-assets --review-write REQUEST_ID
pixelarting-mcp --data-dir /srv/pixelarting/customer-assets \
  --approve-write REQUEST_ID --approval-digest REVIEWED_DIGEST
# 拒绝待处理请求，或撤销尚未使用的批准：
pixelarting-mcp --data-dir /srv/pixelarting/customer-assets --reject-write REQUEST_ID
```

审阅结果包含工具名、完整参数、issuer、resource、工作区 ID/路径、主体和 OAuth 客户端。操作者应确认实际参数和 digest，不能只依据 AI 的摘要批准。CLI 批准不会执行写入；客户端需要在批准后重发**完全相同**的工具及参数。没有可供远程模型自行批准的 MCP 工具。确认通道的信任边界是服务主机的文件权限；需要独立人工确认时，不应让调用方 agent 同时拥有该主机的 shell 或确认数据库写权限。

批准绑定上述全部信息，包括参数中的 expected_current_version_id、preview_id 或幂等键。更换账号、客户端、目录、工具、参数或版本号都需要新确认。相同待处理调用复用请求 ID，不延长有效期。请求自创建起 600 秒过期，批准不续期；每个主体最多 64 个、工作区最多 1000 个活跃请求。确认状态跨进程共享，SQLite 事务保证一次批准只放行一次执行。现有素材版本冲突检查仍在实际写入时执行；确认不会授权覆盖后续版本。

批准在业务执行之前消费。输入校验失败、版本冲突、进程崩溃或响应丢失后都不能自动复用批准；先读取状态，再决定是否申请新确认。生成提交/重试的持久化幂等键继续防止重复建任务，但也不会跳过这层确认。拒绝只终止当前请求，后续同样操作可以重新申请，主体是否能写仍由 OAuth grant 和进程门禁控制。

完整参数仅短期保存在权限为 0600 的 `security/write-approvals.sqlite3`，与不记录参数的审计数据库分开。消费/拒绝时清空参数，过期请求在下次访问确认库时清空，过期一天后的记录在访问时清理；这不是定时清理或磁盘安全擦除保证。确认库及其备份应按包含 prompt/像素的敏感数据管理。审计增加 confirmation_required/confirmation_unavailable 结果，不写入参数或 digest；当前未提供外部防篡改的操作者身份审计。确认库不可用时拒绝写入。

## 限流与审计

启用 OAuth 后，工作区的 `security/audit.sqlite3` 保存安全日志和速率桶；目录/文件使用受限权限。每个已认证主体按固定自然分钟共享调用与写入预算，多进程或新 token 不会重置预算。工具调用、资源读取以及缺少权限的调用都计入预算；写入包括修复预览和任务/候选状态修改。超过预算返回 HTTP 429 和 Retry-After。

每个授权操作先持久化 attempt，再执行；随后保存 completed/failed。权限拒绝和限流有单独事件。记录 request_id、时间、issuer、workspace_id、sub、client_id、操作名、已授权项目 ID 和结果；不记录 token、请求参数、prompt、像素、provider 配置或原始异常。审计没有 MCP 读取工具，管理员在服务主机上管理日志。

审计写入失败时拒绝开始操作。素材数据库与安全日志不是跨库事务：操作完成后若终态审计落盘失败，之前的 attempt 仍存在，但业务修改可能已经完成；客户端必须重读状态，不能盲目重试写操作。日志不是防管理员篡改的外部审计系统，保留期、归档和容量告警仍待实现。

当前预算覆盖认证后的工具/资源操作，不覆盖初始化/发现、无效 token 洪泛、连接数或入口流量；公网边缘代理仍需提供连接/IP/流量保护。P0 的完整运营限流与拒绝认证审计仍未完成。

## 验证范围

自动回归覆盖签名/算法/公钥替换、issuer/aud/workspace/有效期、scope 交集、并发主体隔离、跨项目工具与资源拒绝、任务列表过滤、进程写门禁、跨实例读写预算、审计失败拒写和错误/日志脱敏。真实 HTTP 子进程测试通过签名测试 token 执行初始化、项目过滤、修改、质检、PNG 导出和资源读取，并验证同一客户端移除 Authorization 后下一请求立即返回 401。

写入确认回归还覆盖意图绑定、过期、容量上限、并发单次消费、拒绝/撤销、权限再检查、版本冲突和存储失败拒写。真实 HTTP SDK 客户端能收到确认错误，本机 CLI 审阅/批准后重发成功，再执行质检；同一批准无法重复使用。

测试令牌由隔离的临时私钥签发，只访问本机服务，没有客户凭据或付费 provider 请求。还需真实授权服务器 OAuth 浏览器流程、TLS 反向代理、客户宿主对确认暂停/重发的处理、mTLS（如需要）和生产部署验收。

0.9.0 增加可发现的逐工具/资源授权声明和 `get_permissions`。scope、项目边界与写入条件使用同一份服务端规则，客户端查询不会授予权限；当前身份、进程门禁和确认要求分别返回。详见 [权限合同](mcp-permissions.md)。

0.10.0 全部写工具均公开幂等键要求与重放规则。通用写收据在业务数据库与修改同事务保存；读取收据前仍检查当前授权、门禁、审计、预算和已配置确认。幂等键不授予权限，重放需要新的批准，详见 [写入幂等](mcp-idempotency.md)。
