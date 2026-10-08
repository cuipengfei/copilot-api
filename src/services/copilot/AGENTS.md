# Copilot Service Boundary Guide

## Overview

这个目录是真正触达上游 Copilot / GitHub backend 的边界层；这里处理 headers、telemetry、signature retry、native messages 适配与 model metadata。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Chat Completions upstream | `create-chat-completions.ts` | OpenAI-compatible 主调用器 |
| Native messages upstream | `create-messages.ts` | native messages 适配集中地 |
| Responses upstream | `create-responses.ts` | Copilot Responses API |
| Models metadata | `get-models.ts` | capability / limits / supported_endpoints；按模型暴露 `reasoning_effort` 支持值（含 `xhigh`） |
| Embeddings | `create-embeddings.ts` | OpenAI-compatible embeddings |

## Project-Specific Conventions

- `create-messages.ts` 是 backend workaround 收口点：`reorderAssistantBlocks`、`stripThinkingBlocks`、`anthropic-beta` allowlist、adaptive thinking、vision header、`compactType` 透传都放这里
- `create-messages.ts` 在模型命中 `modelSupportsToolSearch` 时自动附加 `ADVANCED_TOOL_USE_BETA = "advanced-tool-use-2025-11-20"`；不要在 route 层重复拼接
- `create-chat-completions.ts` 遇 `invalid_reasoning_effort` 会自动降级 `reasoning_effort`（如 `xhigh` → `high`）后单次重试；这条 fallback 不要外泄到 route 或 lib
- `X-Initiator` 由显式 options 与暗渡之门决断共同决定；不要跳过 `resolveInitiatorWithSmartAgent()`
- telemetry 发送、成功/失败打点、feedback scheduling 在 service 层做，不回推到 route handler
- `isThinkingBlockError` 宽匹配（JSON.stringify + toLowerCase + "signature" 或 "cannot be modified"）触发 strip-thinking retry；项目里没有通用 retry/backoff 框架
- `api-config.ts` 组装 `X-Interaction-Id` / `X-Agent-Task-Id` / `X-Interaction-Type` 请求头，三个 `create-*` service 共享调用
- 三个 `create-*` service 各自生成 `modelCallId`（UUID）传入 telemetry，用于单次调用追踪
- `create-chat-completions.ts`、`create-messages.ts`、`create-responses.ts` 现在都必须附着 upstream response headers，供 route 层最终转发；不要只返回 body / stream 而丢掉原始 headers
- premium info 与 upstream response headers 是两条并行元数据链：前者走 `attachPremiumInfo()`，后者走 `attachResponseHeaders()`；不要用一个字段偷带另一个概念
- 排查 Auto 模型问题时，核对真实请求模型 ID、该模型配对的 `supported_endpoints` 与脱敏后的 `Copilot-Session-Token`（不带、新、旧/跨 auth 三种对比），不要只看本地 wrapper 日志；selector 重试逻辑在 `auto-session-retry.ts`。
- 三条 `create-*` service 统一经 `attachAutoSessionToken(headers, model, endpoint)` 附着 `Copilot-Session-Token`：仅当模型命中配对且该配对 `supported_endpoints` 含请求端点时才附加，Responses WebSocket 分支不附加；不要在 route handler 分散实现附着逻辑。

## Native Messages Gotchas

- 只能移动 `text` / `tool_use` 的相对顺序；`thinking` / `redacted_thinking` 必须保留原位
- adaptive thinking 用 capability 检测，不用硬编码模型名
- 显式传入的 `anthropic-beta` 不是全量透传，而是 allowlist 过滤后再发给后端

## Anti-Patterns

- 在 handler、translation 或测试 helper 里复制 backend workaround
- 重新引入通用重试掩盖真实上游错误
- 修改 thinking block 顺序或内容再发给上游后端
- 直接 hardcode model → effort / capability 映射而不走现有 metadata/config 逻辑
- 在 service 里把 upstream headers 丢掉，再让 route 层猜测 quota/rate-limit 信息
