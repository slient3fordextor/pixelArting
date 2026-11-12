# MCP 容器与升级验收

`Dockerfile.mcp` 交付独立 MCP 服务，不包含桌面窗口、前端构建、项目数据或测试目录。默认运行 stdio、只读门禁、非 root 用户 65532:65532，数据目录固定为 `/data`。本文的 HTTP 容器路线面向 Linux：保留服务只监听 loopback 的限制，使用主机网络，再由主机 HTTPS 代理提供远程入口。没有把容器内监听改成 0.0.0.0。

## 构建与依赖

从源码根目录构建，给交付物固定 tag；镜像当前未发布到公共仓库：

```bash
docker build -f Dockerfile.mcp -t pixelarting-mcp:0.10.0 .
docker run --rm --network none pixelarting-mcp:0.10.0 --version
```

`.dockerignore` 只允许 Python 源码、包元数据、许可证和锁文件进入构建上下文，不上传本机 `data/`、`.env`、`.venv`、配置/钥匙串或前端依赖。构建安装 `deploy/requirements-mcp.lock` 中精确版本和 SHA-256 校验的运行时依赖，再安装本项目；运行阶段不保留构建目录。基础镜像和隔离构建后端尚未在仓库统一固定 digest/版本，因此这不是逐字节可复现构建的保证。

发布方可通过 `--build-arg PYTHON_IMAGE=受信任的镜像@sha256:...` 固定基础镜像，并记录最终 image ID/digest。使用本机 loopback HTTP 代理的 Linux 构建环境可额外传 `--network=host`；这是构建网络选择。不要将代理凭据写入 Dockerfile、镜像 ENV 或版本库。

更新运行时锁文件后必须重跑验收：

```bash
uv pip compile pyproject.toml --python-version 3.12 --universal \
  --generate-hashes --output-file deploy/requirements-mcp.lock
```

## stdio 客户端

Linux Docker 示例使用调用者的 UID/GID，使挂载目录仍由本机所有者管理：

```bash
mkdir -p /absolute/path/to/workspace
docker run --rm -i --init --network none \
  --user "$(id -u):$(id -g)" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,size=64m,mode=1777 \
  -v /absolute/path/to/workspace:/data \
  pixelarting-mcp:0.10.0 --read-only
```

标准 MCP 客户端将 `docker` 作为 command，上述 `run` 及参数作为 args；保留 `-i`，不要加 `-t`，避免终端内容干扰协议。客户端明确授权修改时将最后一个参数改为 `--allow-write`。容器文件系统的 `--read-only` 与 MCP 业务门禁分开：挂载的数据卷可写，因为读取也可能初始化/迁移 Store，质检也会保存报告。

`--network none` 适用于素材/质检/修复/导出；AI provider 生成需要网络时，由所有者选择普通 bridge 网络，不必发布 HTTP 端口。容器不自动取得宿主的 OS 钥匙串；仅在宿主钥匙串中的 provider 密钥不会随数据库挂载而可用。需要在运行服务的环境配置凭据；没有可用钥匙串时沿用产品的 SQLite 兼容回退，数据库/备份应按含密钥的文件管理。当前容器验收使用临时素材和签名令牌，不配置真实 provider、不验证外部生成计费链路。

Rootless Podman 可把命令换为 `podman run`，并在 `--user` 前加 `--userns=keep-id`。Docker 默认用户命名空间、Rootless Docker、Docker Desktop 的卷权限可能不同，不能把 Linux Podman 的通过记录视为这些环境的验收结果。不要用 chmod 777 解决持久化卷权限。

## Linux OAuth HTTP

先按 [HTTP 安全接入](mcp-security.md) 准备一个只包含配置和公钥的目录。`oauth.json` 建议开启 `require_write_confirmation`，其中 `jwks_file` 使用容器内 `/config/public-jwks.json` 或相对路径。该目录只读挂载；客户工作区独立挂载 `/data`。

仓库提供 `deploy/compose.mcp.yaml`，需要 Docker Compose v2：

```bash
export PIXELART_MCP_IMAGE=pixelarting-mcp:0.10.0
export PIXELART_MCP_DATA=/absolute/path/to/customer-workspace
export PIXELART_MCP_CONFIG=/absolute/path/to/oauth-config
export PIXELART_MCP_UID="$(id -u)"
export PIXELART_MCP_GID="$(id -g)"
docker compose -f deploy/compose.mcp.yaml config --quiet
docker compose -f deploy/compose.mcp.yaml up -d
```

默认 `PIXELART_MCP_PERMISSION=--read-only`；有明确写入授权时可设置为 `--allow-write` 后重建容器。`PIXELART_MCP_PORT` 默认 8765。Compose 使用 host 网络，无 ports 映射，容器服务仍在主机 127.0.0.1 上。只读根文件系统、非 root 身份、移除 capabilities、no-new-privileges、临时 `/tmp` 和 init 进程均在配置中声明。

该路线会共享主机网络，应在受控主机运行。Docker Desktop 的 host networking 不是本文已验证范围。远程客户仍须通过管理员的 HTTPS 代理访问 OAuth resource 地址，转发 MCP 协议头和 metadata 路径；本配置没有附带公网监听器、证书、授权服务器、入口限流或跨域设置。不要发布无 OAuth 的公网入口。

开启确认后，在同一容器数据路径里执行本机操作者命令：

```bash
docker compose -f deploy/compose.mcp.yaml exec pixelarting \
  pixelarting-mcp --data-dir /data --review-write REQUEST_ID
docker compose -f deploy/compose.mcp.yaml exec pixelarting \
  pixelarting-mcp --data-dir /data --approve-write REQUEST_ID --approval-digest REVIEWED_DIGEST
```

确认精确绑定工作区路径；容器中的路径是 `/data`，不要用宿主路径运行另一个服务来消费这条批准。审阅、批准及重发规则见 [写入确认](mcp-security.md#050-写入二次确认)。

## 升级与回滚

升级前停止共享该数据目录的**全部写入者**，包括桌面端、其他 MCP 实例与生成执行者，再离线备份整个工作区目录；同时单独备份 OAuth 配置、公钥和适用的 OS 钥匙串。运行中的 SQLite 不能只复制 `.sqlite3` 主文件代替一致性备份。镜像回滚不等于数据回滚。

升级流程：停止实例 → 离线备份 → 记录旧 image digest/配置 → 更换已验收的镜像 → 启动 → 用受限身份读取素材、历史版本和任务，质检/导出后再开放写入。当前 Store 在首次访问时执行增量迁移，即使进程以 MCP 只读门禁启动，也应先备份。数据库挂载不是不可写文件系统。

需要回滚时，再停止所有写入者，保留升级后的目录作故障分析，**将升级前备份恢复到另一目录并配合旧镜像启动**。不应让旧版本直接写升级后的数据库；新表/字段可能仍能读取，不代表凭据隔离、幂等或审计语义兼容。回滚到 0.4.0 以前还需考虑旧全局钥匙串和新工作区命名空间的差别，见 [0.4.0 凭据升级](mcp-security.md#040-凭据隔离与升级)。回滚点之后的写入不在旧备份中，应在恢复业务前核对。

`security/write-approvals.sqlite3` 中未消费批准不应跨维护恢复自动生效。服务全部停止后，从恢复目录移走这一确认数据库及其 SQLite sidecar 文件，保留为受限的事件材料，使客户重新申请确认。保留 `security/audit.sqlite3` 供审计，不将日志或凭据返回给模型。这里不自动操作用户工作区。

## 可重复验收

用带 MCP SDK 的项目 Python 在 Linux 执行以下脚本；脚本只创建临时目录、容器和测试密钥，退出时清理自己的容器：

```bash
.venv/bin/python scripts/verify_mcp_container.py \
  --engine podman --keep-id --image localhost/pixelarting-mcp:0.10.0
# Docker 环境去掉 --keep-id，并使用 --engine docker。
```

覆盖 stdio 写入、无网络下的素材质检/PNG 导出、只读容器重建、OAuth HTTP、移除 token 后 401、本机确认、容器重建后一次性批准保留、写入后质检和拒绝复用批准。HTTP 验证在 Linux loopback 运行，不验证真实 TLS/客户登录页；检查本机选择的端口和精确命名的临时容器。

升级验证需要两个已安装对应 wheel 的独立 Python 环境；该命令不自动下载或替换版本：

```bash
.venv/bin/python scripts/verify_mcp_upgrade.py \
  --old-python /absolute/old-venv/bin/python \
  --new-python /absolute/new-venv/bin/python
```

它从仓库外运行旧版创建临时项目/素材/历史版本、报告、修复预览、失败任务和假凭据，离线备份后让新版读取并比较，继续提交旧修复预览、质检、拒绝旧版本覆盖及导出原始版本，最后用旧版读取恢复的升级前备份。没有启动生成执行器或调用外部 provider；假密钥只用于验证 SQLite 兼容回退，不能据此承诺客户 OS 钥匙串备份也已验证。

当前通过记录：Linux amd64、Rootless Podman 5.2.5；0.10.0 镜像使用本机缓存的 Python 3.12 slim，运行时安装锁文件依赖；容器协议链路和逐工具权限元数据/当前身份查询、通用写键跨容器重建重放和 HTTP 重放重新确认通过、质检均无 findings，PNG 文件与项目备份的预检/导入/重放、重建后读取及只读拒写均通过。实际旧 wheel 0.2.0/0.4.0/0.9.0 → 0.10.0 与升级前备份回滚通过；此前版本记录保留在实现状态。Docker Compose 配置已解析；尚未实跑 Compose v2 部署、原生 Docker daemon、ARM64/Windows/macOS 或客户 OAuth/TLS。镜像未推送。[Inspector CLI](mcp-inspector.md) 已通过 0.10.0 的权限发现、带键新建/修复/改名重放与重新确认、stdio/OAuth HTTP、PNG/ZIP 与项目备份导入、管理员确认/重放验收；浏览器 UI 和真实客户宿主仍在 TODO。
