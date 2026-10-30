# AI 集成（Beta）：独立后台扩展

调用链：官方 AFFiNE-canary → AFFiNE 后端 OpenAI-compatible BYOK（Responses）→ 本扩展 → ChatGPT。客户端选择 **Auto**，默认模型和账号由扩展 CLI 管理。无需修改或重装官方客户端，也不改变其更新机制。

首版只面向自己的自部署服务器和单成员个人工作区。此扩展不是 AFFiNE 编辑器插件，不依赖数据库、编辑器或 Rust；只运行一个 Node.js Docker 服务。共享工作区和多人共用 ChatGPT 账号不在支持范围内。

## 安装

需要 Node 22.12+（22.x）、Docker 和 Compose v2。首次安装从仓库构建：

```sh
corepack enable
yarn workspaces focus @affine/chatgpt-gateway
bash scripts/build-chatgpt-gateway.sh
node packages/backend/chatgpt-gateway/dist/extension.mjs install --network YOUR_AFFINE_DOCKER_NETWORK
node packages/backend/chatgpt-gateway/dist/extension.mjs login
node packages/backend/chatgpt-gateway/dist/extension.mjs status
```

在系统浏览器完成新授权。不要复制内置提供商、Codex 或其他应用的 refresh token。CLI 将此次新授权经 stdin 发送至容器内控制接口；本地 CLI 只保存公开注册信息和容器配置。后续命令中的 `PROFILE_ID` 来自 `status`。

```sh
node packages/backend/chatgpt-gateway/dist/extension.mjs models --profile PROFILE_ID
node packages/backend/chatgpt-gateway/dist/extension.mjs verify --profile PROFILE_ID --model MODEL_SLUG
node packages/backend/chatgpt-gateway/dist/extension.mjs select --profile PROFILE_ID --model MODEL_SLUG
```

`verify` 会真实调用 ChatGPT，验证文本、JSON schema 和工具往返；只有通过验证的模型可被设为默认值。对外稳定别名始终是 `chatgpt-default`。切换模型后无需在 AFFiNE 修改模型名。当前不声明或接受图片、音频和文件输入；不能仅根据模型目录声称支持附件。图片生成、转录和索引继续使用原有的独立提供商。

构建产物 `dist/extension.mjs` 和 `dist/compose.yml` 可以一起复制到独立目录使用；CLI 不需要整个 AFFiNE checkout。CI 提供相同的 CLI 构建产物及 Docker 镜像归档。

## 接入自己的 AFFiNE

先在隔离实例验证。CLI 的 `configure` 需要兼容的 AFFiNE 后端 BYOK API，以及同时具有管理员和工作区所有者权限的账号。用权限为 `0600` 的临时 JSON 文件提供该账号的 `email` 和 `password`（也支持 `accessToken`）。CLI 使用临时原生会话，完成后撤销会话；不会保存 AFFiNE 登录凭据。

```sh
node packages/backend/chatgpt-gateway/dist/extension.mjs configure \
  --server http://127.0.0.1:13010 \
  --workspace PERSONAL_WORKSPACE_ID \
  --credentials-file /private/path/admin-login.json
```

该命令先检查单成员、所有者、BYOK 授权及已有文本候选，再备份将要改动的设置，取消旧内置 ChatGPT 的默认选择（保留旧记录），打开 BYOK、自定义端点及私网端点开关，创建名为 **AI 集成（Beta）** 的 BYOK 记录并探测能力。旧内置 ChatGPT 登录入口开关会关闭。配置失败会报告备份路径；使用下面的回滚命令恢复，处理原因后重试。

配置为：

| 项目 | 值 |
| --- | --- |
| Provider | OpenAI-compatible |
| Endpoint | `http://affine-ai-extension:8080/v1` |
| Dialect | `responses` |
| Model | `chatgpt-default` |
| Text capabilities | `text` → `text`, `tool_calling` |
| Structured capabilities | `text` → `object`, `structured` |
| Credential | 扩展生成的访问密钥，与 ChatGPT token 无关 |

AFFiNE 保存的是访问扩展的密钥。只有显式 `key` 命令会打印该密钥；`configure` 自动传入，不打印。不要把密钥放进仓库、聊天或日志。

文本和结构化请求必须只有这一个候选。安装检查会拒绝现有启用的文本 BYOK 或 managed provider，避免静默改变其他服务；先明确处理其文本路由，再安装。也不要在客户端设置本地竞争密钥。图片、转录和索引的配置不改动。之后新增候选可能重新引入 AFFiNE 的 fallback，需重新验证。

在官方 Canary 重新打开 AI 面板并选择 **Auto**。本项目另有自部署 Web 界面的构建改动，仅隐藏工作区设置中的 ChatGPT/BYOK 入口，保留管理员后台；这是可独立部署的 Web 资源，与扩展加载无关。官方桌面内置卡片保持原样。

如需构建这一界面改动，在已安装完整仓库依赖的环境运行 `bash scripts/build-ai-extension-web.sh`。它只构建 Web/admin，并以 `AFFINE_BASE_IMAGE` 指定的兼容后端镜像（默认 `affine-chatgpt:local`）打包为 `affine-chatgpt:gateway-web`；不编译 Rust 或重建后端，不自动切换任何实例。后端和资源版本须匹配。回滚界面只需重新使用原镜像，扩展仍可独立运行。

## 日常管理、更新和回滚

```sh
# 查看状态、刷新模型、重新授权原账号
node extension.mjs status
node extension.mjs models --profile PROFILE_ID
node extension.mjs login --profile PROFILE_ID
# 重新登录后重新 verify 和 select；需要重新授予计划权限时加 --consent

node extension.mjs disable
node extension.mjs enable
node extension.mjs stop
node extension.mjs start

# 预先构建或 docker load 新镜像；此命令不升级 AFFiNE
node extension.mjs update --image affine-chatgpt-gateway:NEW_TAG
# 回到旧镜像（v1 存储格式兼容时）
node extension.mjs update --image affine-chatgpt-gateway:OLD_TAG

# 恢复原 AFFiNE 设置；使用 configure 打印的备份文件
node extension.mjs rollback --server http://127.0.0.1:13010 \
  --credentials-file /private/path/admin-login.json --rollback /private/path/affine-backup-TIMESTAMP.json

node extension.mjs disconnect --profile PROFILE_ID
node extension.mjs uninstall
# 仅在明确不再需要扩展账号及密钥时使用：
node extension.mjs uninstall --purge-data
```

`disconnect` 尝试上游撤销并在本地清除 token；保留公开注册信息以便重新登录。停用或退出不自动选择其他账号。`uninstall` 默认保留扩展的两个数据卷；`--purge-data` 仅删除扩展卷，绝不删除 AFFiNE 数据。重装相同 Compose project 可恢复配置。卸载前可先回滚 AFFiNE；若保留扩展路由，客户端请求将明确失败。

所有命令都支持 `--state-dir DIR`；同一安装后续应始终使用同一目录。默认是 `~/.config/affine-ai-extension`。镜像/容器/网络配置保存在其中，账号保存在 Docker 卷中。一个安装只运行一个 daemon；不支持多副本共享卷。远程 Docker 主机仍通过本地 CLI 浏览器授权，凭据走 `docker exec -i`，不开放管理端口。

升级前备份 `affine-ai-extension_state` 和 `affine-ai-extension_keys` **两个卷**以及 CLI 配置和迁移备份；停止扩展后使用自己的受控备份工具复制，分别保管。丢失主密钥无法解密账号。不要把旧 token 数据卷恢复到已发生 refresh token 轮换的时间点；需要时重新授权。未来存储版本或上游协议变化必须先做兼容性检查。

## 安全边界和协议

- Docker 内部网络，无宿主端口，无 Docker socket；HTTP 只开放 `/health`、`GET /v1/models` 和 `POST /v1/responses`。健康检查只有 `{ "ok": true }`；推理端点要求扩展 Bearer 密钥。
- 管理在权限 `0600` 的容器 Unix socket 上，通过 `docker exec` 调用。容器非 root、只读根文件系统、移除 capabilities。
- AES-256-GCM 加密整个账号状态，独立 32 字节随机主密钥。原子写入、串行刷新和导入 generation 校验，失败不覆盖有效凭据。终止性的 refresh 错误要求重连。
- 上游请求固定到 OpenAI；不把上游错误正文/token 转发给客户端。支持 JSON 和 SSE 响应，校验流正常结束、补齐稀疏完成事件、处理限流、取消和断流，不把残缺流标记成功。
- 工具上下文按扩展密钥、账号授权代次、真实模型、随机调用标识隔离；保留上游原始 output 和加密 reasoning，内存缓存 15 分钟、最多 64 MiB/128 条链，不写磁盘。并行结果必须完整。缺失、过期、混链、重启后续传失败均明确报错，需新建 AI 请求。切换模型/账号、停用会清空缓存。
- 每实例最多 8 个并发推理请求；请求体及事件有大小限制。没有静默切换其他模型或计费提供商的逻辑。

访问扩展密钥意味着可以使用选定的个人账号，所以只应交给自己的 AFFiNE 后端。管理员将个人工作区改为共享或复制 BYOK 配置后，扩展本身无法判断 AFFiNE 调用者，不能再视为个人范围；请先停用和回滚。

## 验证

```sh
yarn workspace @affine/chatgpt-gateway typecheck
yarn workspace @affine/chatgpt-gateway test
node --test packages/backend/server/scripts/chatgpt/oauth.test.mjs
bash scripts/build-chatgpt-gateway.sh
```

专用 GitHub Actions 验证类型、自动测试、共享 OAuth、镜像构建和隔离启动，不构建 AFFiNE/Rust。实际验收还必须测试官方 Canary Auto、结构化生成、并行工具和文档读→写→读；仅聊天成功不构成验收。停止扩展时应失败，不能出现其他 provider 的成功回复。后端 API、客户端或 OpenAI 升级后重复这些检查。
