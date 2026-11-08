# Anthropic Messages Route Guide

## Overview

这里是最敏感的兼容层：Anthropic `/v1/messages` 既能走 OpenAI chat completions，也能走 Responses API，还能在 `-M` 模式下直通 Copilot native messages。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Branch ordering | `handler.ts` | compact detection → `sanitizeIdeTools` → `parseSubagentMarkerFromFirstUser` → native messages → warmup/small model → mergeToolResult → responses/chat |
| Native passthrough | `handler.ts`, `~/services/copilot/create-messages.ts` | raw SSE passthrough，不能重建事件语义 |
| OpenAI translation | `non-stream-translation.ts`, `stream-translation.ts` | chat completions 路径 |
| Responses translation | `responses-translation/`, `responses-stream-translation/` | Copilot Responses API 路径 |
| Token counting | `count-tokens-handler.ts` | Claude/Grok 工具 token 补偿逻辑 |

## Critical Invariants

- `state.nativeMessages && isClaudeModel(...)` 分支必须早于其他 payload 改写；compact detection 是唯一允许在前面的例外
- native messages 流式响应走 **raw body passthrough**，不要把它重建成 `streamSSE()` 的 Anthropic 事件序列
- `mergeToolResultForClaude()` 只在非 compact 请求上跑，用来避免 skill / hook / todo 文字块额外消耗 premium
- `mergeToolResultForClaude()` 的适用范围不能再被 `anthropic-beta` 短路；当前规则是“所有非 compact 请求都执行”
- `tool_calls` finish_reason 是中间态；stream accumulator 不能在这里清空
- ping 事件必须写 `data: '{"type":"ping"}'`，不能发空字符串
- Responses 翻译中 reasoning id >64 字符的 thinking block 不转为 `ResponseInputReasoning`（跨实例不可移植的 ID 会导致上游报错）
- `shouldApplyPhase` 从 `extraPrompts` 动态检测 `"## Intermediary updates"` 字符串，不再硬编码模型名
- `requestId = generateRequestIdFromPayload(...)` 与 `sessionId = getRootSessionId(...)` 必须在三条分支（native / responses / chat）向下透传；不要只在某一路径生成
- `parseSubagentMarkerFromFirstUser()` 必须在 compact 检测后尽早执行；marker 需传到 native / responses / chat 三条路径
- 若 service 返回值附着了 upstream response headers，messages 路由必须把它们继续转发给客户端；native/raw SSE 允许保留原 body 语义，但外层响应头仍要经过统一 helper 过滤与改写

## Project-Specific Rules

- `anthropic-beta` 请求头在 native messages 路径会继续传给 `createMessages()`，但真正转发值会被 service 层过滤
- `getInitiatorFromPayload()` 会把 tool_result 上下文识别为 `agent`
- 针对 Claude Code/OpenCode 的 compact 请求，小模型切换逻辑先发生，再决定是否 native passthrough
- Messages → Responses 路径如命中 `responsesApiContextManagementModels`，必须先 `applyResponsesApiContextManagement()`，再对非 compact 请求执行 `compactInputByLatestCompaction()`
- `findEndpointModel()` 必须在请求真正发往 service 前映射逻辑模型名；否则 provider/per-endpoint 限制会落在错误模型上

## Effort Parameter Mapping

入站请求携带 Anthropic `output_config.effort`，根据路径翻译到 Copilot 后端不同端点的不同参数名和值：

| 入站 `output_config.effort` | → Copilot `/v1/messages` 出站 | → Copilot `/responses` 出站 |
|:---:|:---:|:---:|
| `"low"` | `output_config.effort = "low"` | `reasoning.effort = "low"` |
| `"medium"` | `output_config.effort = "medium"` | `reasoning.effort = "medium"` |
| `"high"` | `output_config.effort = "high"` | `reasoning.effort = "high"` |
| `"max"` | `output_config.effort = "max"` | `reasoning.effort = "xhigh"` |

- Native 路径（`buildEnhancedPayload`）：直传，格式不变
- Responses 路径（`mapAnthropicEffortToResponses`）：`max` → `xhigh`，其余同名
- 未传 effort 时，两条路径均从 `modelReasoningEfforts` 配置取默认值（默认 `"high"`）

## Anti-Patterns

- 调整 native branch 顺序，让 payload 先被 OpenAI/mergeToolResult 逻辑污染
- 在这里实现上游后端 block 顺序修复；那属于 `create-messages.ts`
- 把 raw native stream 改成翻译后再输出，破坏上游 SSE 兼容性
- 用 JSON response helper 生成 native SSE 响应头，导致 `content-type` 漂成 `application/json`
