# 独立 AI 扩展验收记录（2026-10-30）

适用实现及命令见 [扩展 README](../../packages/backend/chatgpt-gateway/README.md)。此次验证使用 `127.0.0.1:13010` 隔离实例和自己的单成员验收工作区，不升级生产实例。

## 构建和自动测试

- Node 22.23.2；扩展独立 TypeScript 类型检查通过。
- 网关自动测试 16 项通过，共享本机 OAuth 测试 8 项通过。
- 前端 ChatGPT/BYOK/集成设置及管理员配置测试共 20 项通过。
- frontend/core、admin、tools/cli TypeScript build 检查通过；oxlint 和 diff whitespace 检查通过。
- 网关镜像独立构建、健康检查通过，无宿主端口映射。
- Web/admin 单独构建及基于现有兼容后端的资源镜像构建通过，已用于 13010 验收实例。无需重建 Rust 或后端。组件测试确认仅自部署 Web 隐藏工作区入口，桌面及其他部署入口保留。

## 真实调用链

- 通过新的系统浏览器 OAuth 授权登录扩展；未复制旧内置 ChatGPT 的 refresh token。
- 模型目录刷新成功，`gpt-6.1-sol` 的文本、JSON schema 及函数调用往返验证通过；选为 `chatgpt-default` 的真实模型。
- AFFiNE 后端通过私网服务名及 Responses 协议探测 chat、structured 和 tool_calling 全部通过。初始 `object` 单独声明不满足后端的 structured 探测；现同时声明 `object`/`structured` 并已重新探测通过。
- 未指定显式 routeTargetId 的 Auto 后端请求返回 `GATEWAY_AUTO_OK`；结构化 `slides.outline` 返回完整大纲。
- 真实后端工具链完成 `doc_create → doc_read → doc_update → doc_read`。最后的工具结果从持久化文档读出 `GATEWAY_BEFORE` 和新增 `GATEWAY_AFTER` 两段，而非仅根据模型的自然语言声称成功。
- 真实并行请求的事件顺序为 `doc_read tool-call → doc_read tool-call → tool-result → tool-result`，两份文档读取均成功。
- 原安装的官方 AFFiNE-canary（2026.10.27-canary.909）选择 Auto 后返回指定测试文本；未修改客户端二进制或更新设置。
- 停止扩展后，官方 Canary 显示错误；后端 Auto 返回 error 事件，无成功回复、无转向其他提供商。重新启动后调用恢复。

## 生命周期与范围

- 配置迁移备份和恢复原设置已实测，再次配置成功；保留旧内置提供商记录。
- 强制重建容器升级后，账号和默认模型保留。
- 默认卸载后重装，两个扩展卷保留，账号、模型及密钥可继续使用；真实 Auto 聊天通过。
- `affine_ai_extension` 健康运行在隔离实例的 Docker 网络；对外公开端口为零。
- 生产 `affine_server` 的容器 ID 和镜像 ID 在验收前后完全一致，未部署生产、未发布公共 Release。
- 图片、音频和文件输入没有纳入此次端到端验证，因此未启用。图像生成、转录及索引的原提供商配置未改动。
- 工具临时上下文不会跨重启恢复；自动测试验证明确报错而非猜测重建。账号配置会跨重启恢复。缓存丢失时需新建 AI 请求。

CI 使用仓库中的 `Verify independent AI extension` workflow，运行独立测试、类型检查、镜像构建、容器认证/健康检查并保存 CLI 与镜像产物。它不依赖完整 AFFiNE 镜像 CI。远端结果以该次提交对应的 Actions 页面为准。
