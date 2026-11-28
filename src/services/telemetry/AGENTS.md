# Telemetry Service Guide

## Overview

这里封装 Copilot telemetry：所有事件只发送到 GitHub `/telemetry`，fire-and-forget、15 秒超时；envelope 含 3 个 tags、8 个 common properties（含 `copilot_trackingId`），每个事件生成随机 `unique_id`。独立事件各自 30% 采样，每请求 context 开始时一次采样并生成 `issuedAt`；`createMockRequestContext` 传入 `sessionId` 时复用会话的 `conversationId` 并递增 `turnIndex`，缺失时生成独立 `conversationId`。请求先使用客户端 `requestId`，上游响应带有非空 `x-request-id` 时切换为该 ID，缺失或空值保持客户端 `requestId`。业务请求绝不能依赖遥测成功。不使用身份文件或 OneCollector；`tid` 和上游请求头属于账户 / 服务端关联信息，不宣称匿名或 ETL 保证。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Event sending / scheduling | `telemetry.ts` | GitHub `/telemetry`、fire-and-forget fetch、事件与延迟调度 |
| Identity / common properties | `identity.ts` | 最小化 common properties，复用进程内会话 ID，不持久化客户端身份字段 |
| Envelope / constants | `types.ts` | event names、envelope shape、`parseTid()` |
| Mock context / values | `mock-values.ts` | 共享合成请求 context、事件属性与随机反馈 |

## Critical Invariants

- `initTelemetry()` 必须在拿到 Copilot token 后尽早执行；否则早期事件会缺 `ai.user.id`
- `trackEvent()` 是 fire-and-forget：不 await、不 throw，只记 warning；发送超时为 15 秒，不能影响主请求成功与否
- `_endpoint` 需要规范化到单个 `/telemetry` 结尾；不能重复拼接，也不能把原始 endpoint 原封不动写进去
- 独立事件各自按 30% 采样；每请求 context 开始时只采样一次并生成 `issuedAt`，该请求的所有 context 与响应事件共享 `sampled` / `conversationId`，不重复采样
- 含 `sessionId` 的请求跨轮复用 `conversationId`，每轮分配递增的 user/model `turnIndex`；不含 `sessionId` 的请求使用独立 `conversationId`。原始客户端 `sessionId` 不写入遥测载荷；token 刷新切换账户 `tid` 时清空会话映射
- 上游返回实际响应模型时写入 `modelInvoked`，缺失时回退请求模型
- 两个 schedule 函数在 `requestId` 为空、遥测关闭或 `sampled=false` 时不创建 timer；反馈事件共享同一个 outcome，post-response 使用单个 timer，在 `inlineConversation.accept` 前发送 `inline.done`，使用同 context 的 `editCount` / `editLineCount` 和 `accepted=1`；copy/insert/applied action 在安排 timer 时仅随机选择一次，回调复用该选择，三个分支均可到达
- 公共发送路径补充三个上游对账头和实际 `timeSinceIssuedMs`；响应事件使用 `durationMs`。extract 只读取真实 `Headers`，缺失的键及空 `Te` 省略；响应的非空 `x-request-id` 更新 `context.requestId`，缺失或空值保留客户端 ID；请求开始保留原 ID，响应及后置事件使用最终 ID

## Project-Specific Rules

- envelope 包含 3 个 tags（`ai.user.id`、`ai.session.id`、`ai.internal.sdkVersion`）和 8 个 common properties（含 `copilot_trackingId`、`common_vscodesessionid`）；会话 ID 复用进程内 `state.vsCodeSessionId`，不持久化客户端机器或会话身份
- 不生成或持久化 machine、device、organization、enterprise 或 OS 身份字段；不持久化 session 身份字段，不发送系统、架构和内核版本字段
- `createMockRequestContext()` 接收 `{ requestId, model, sessionId? }`，一次生成共享的 mode、language、model、request、message、字符行数和编辑统计；3 个 create-* 入口复用同一 context，不读取响应头、真实提示词、响应正文或工作区特征
- `randomInlineStats` 按每处建议编辑生成 1-20 行并累加为 `editLineCount`
- telemetry 总开关来自 `getConfig().telemetry === true`；默认关闭，不发送任何事件
- `trackRequestSent` / `trackResponseSuccess` / `trackResponseError` 支持透传 `modelCallId`，但是否生成 UUID 由上游 service 决定
- 成功与失败事件的 `apiType` 使用 `chatCompletions`、`messages`、`responses`；调用方传入响应头到达耗时，未提供时估计值不得超过总耗时

## Anti-Patterns

- 在 route / handler 里手写 telemetry fetch，绕开这里的 envelope 与 timeout 规则
- 为 telemetry 加通用重试或 await，拖慢主请求
- 把敏感原文直接塞进 `TelemetryProperties`，破坏当前“非敏感字符串”假设
- 生成或持久化 device ID，或持久化客户端 session ID 等身份字段

## 真实 HTTP 验证

真实 HTTP 验收由人工明确执行，使用选定运行实例的账户凭据，从实际 token exchange 读取 endpoints.telemetry，逐项调用本模块的事件包装函数并核对完整载荷回执。验收需覆盖全部事件、mode、反馈结果、响应协议与后置采纳路径。每次发送要求 HTTP 200、itemsReceived=1、itemsAccepted=1、errors=[]；HEET 日报中的指标在报表刷新后核对。
