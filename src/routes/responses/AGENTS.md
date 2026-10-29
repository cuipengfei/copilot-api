# Responses Route Guide

## Overview

这里是 OpenAI-compatible `/v1/responses` 路由层：负责请求预处理、agent/vision 推断，以及为下游 SDK 修正 Copilot 原生 Responses stream 的事件细节。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Route entry | `route.ts`, `handler.ts` | stream / non-stream 共用 `handleResponses()` |
| Stream ID sync | `stream-id-sync.ts` | 修正 added/done 事件 ID 不一致 |
| Vision / initiator detection | `utils.ts` | 只看 `payload.input` 与最后一项 role |
| Payload preflight | `preflight.ts` | Shared mutation: `removeUnsupportedTools` → conditional `removeWebSearchTool` |
| Input normalization | `utils.ts` (`normalizeResponsesInputForReplay`) | HTTP 上游 `4xx` 的 `error.message` 包含 `belong` 时剥除 `encrypted_content` 并重试一次；同一明确身份、模型、上游 URL 和认证凭据命中学习缓存时，在首发前应用相同处理 |
| Compact input collapse | `utils.ts` (`compactInputByLatestCompaction`) | Path A 仅在 `applyResponsesApiContextManagement()` 启用时裁剪；Path B/C 在翻译前保留 replay 裁剪 |
| Messages backend fallback | `responses-from-messages.ts` | Anthropic Messages ↔ Responses 双向翻译，含 monotonic `sequence_number` 与 assistant 合并 |
| Chat completions fallback | `responses-from-chat.ts` | Chat Completions ↔ Responses 双向翻译，含 stream event 序列号 |

## Critical Invariants

- 流式 Responses 事件在写回 SSE 前，必须经过 `createStreamIdTracker()` + `fixStreamIds()`；这是 `@ai-sdk/openai` 兼容补丁，不可跳过
- `hasAgentInitiator()` 只检查最后一个 input item；历史里出现过 assistant 不能把当前用户请求误记为 agent
- `handleResponses()` 同时承担 stream / non-stream 两条路径；不要拆成第二套 handler 逻辑
- Responses 路由若拿到 attached upstream headers，则 non-stream 用 `jsonWithForwardedHeaders()`，stream 在开始写事件前先过滤并应用可转发 headers；不能只修 body 不修外层响应头

## Project-Specific Rules

- `apply_patch` custom tool 按上游策略保持 custom 形态；不要在 handler 里复制预处理逻辑重新改写它
- `web_search` tool 是否移除由 `useResponsesApiWebSearch` 配置决定；关闭时才在这里剥离
- 当模型不支持 `/responses` 时，直接返回 400 `invalid_request_error`；不要把这个失败拖到上游 fetch
- `stream-id-sync.ts` 会在 `response.output_item.added` 缺少 `item.id` 时补造 `oi_*` ID；后续事件必须复用该映射
- `responses-from-messages.ts` 的 stream 翻译现在必须输出 monotonic `sequence_number` 和完整的 `response.output_item.added/done` 生命周期；assistant text + tool_use 合并为同一 message（防止 Claude replay 断流）
- `preflight.ts` 独立管理共享工具 mutation；reasoning 条目原样放行（含 `encrypted_content`），Path A 的 compaction 由 context-management gate 决定，Path B/C 在各自 fallback 前裁剪
- `prompt_cache_key` 由客户端提供；`normalizeResponsesInputForReplay()` 用于 HTTP belong-4xx 单次重试及已学习身份的首发前处理，保留 reasoning 的 id/type/summary。学习缓存最多 1024 条并按首次插入顺序淘汰，无明确 session 身份时逐次检查；WebSocket 使用原有处理。路径级 `compactInputByLatestCompaction()` 必须在 stream id sync 之前完成
- `compactInputByLatestCompaction()` 在 messages → responses 路径（`api-flows.ts`）也复用；改语义时两处一并验
- stream/non-stream 两条路径都要保留上游 quota/rate-limit headers；缺口通常先查 route helper 调用，再查 service 是否附着了 headers

## Anti-Patterns

- 直接透传 Copilot 原始 Responses stream，忘记做 ID 同步
- 在别的路由里复制 `web_search` 预处理，造成规则分叉
- 通过扫描整段历史推断 agent/user，而不是看最后一个 input item
- 把 Responses 路由的流式收尾逻辑外包给调用者，丢掉本地 `finally`
- 只在 non-stream 分支转发 upstream headers，遗漏 stream 分支的 quota/rate-limit 可观测性
