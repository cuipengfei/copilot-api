# Telemetry Service Guide

## Overview

这里封装 Copilot telemetry：所有事件只发送到 GitHub `/telemetry`，fire-and-forget、5 秒超时、30% 采样；业务请求绝不能依赖它成功。envelope 仅含 2 个 tags 与 6 个 common properties，不使用身份文件或 OneCollector。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Event sending / scheduling | `telemetry.ts` | GitHub `/telemetry`、fire-and-forget fetch、事件与延迟调度 |
| Identity / common properties | `identity.ts` | 最小化 common properties，不生成或持久化身份字段 |
| Envelope / constants | `types.ts` | event names、envelope shape、`parseTid()` |
| Mock context / values | `mock-values.ts` | 共享合成请求 context、事件属性与随机反馈 |

## Critical Invariants

- `initTelemetry()` 必须在拿到 Copilot token 后尽早执行；否则早期事件会缺 `ai.user.id`
- `trackEvent()` 是 fire-and-forget：不 await、不 throw，只记 warning；发送超时为 5 秒，不能影响主请求成功与否
- `_endpoint` 需要规范化到单个 `/telemetry` 结尾；不能重复拼接，也不能把原始 endpoint 原封不动写进去
- 30% 采样只由 `trackEvent()` 处理，调度函数不重复采样，避免把反馈比例压到 9%
- 两个 schedule 函数在 `requestId` 为空或遥测关闭时不创建 timer；反馈事件共享同一个 outcome，post-response 使用单个 timer，copy/insert/applied action 在安排 timer 时仅随机选择一次，回调复用该选择，三个分支均可到达

## Project-Specific Rules

- 不生成或持久化 machine、session、device、organization、enterprise 或 OS 身份字段；不发送系统、架构和内核版本字段
- `createMockRequestContext()` 一次生成共享的 mode、language、model、request、message、字符行数和编辑统计；3 个 create-* 入口复用同一 context，不读取真实提示词、响应正文或工作区特征
- telemetry 总开关来自 `getConfig().telemetry === true`；默认关闭，不发送任何事件
- `trackRequestSent` / `trackResponseSuccess` / `trackResponseError` 支持透传 `modelCallId`，但是否生成 UUID 由上游 service 决定
- 成功与失败事件的 `apiType` 使用 `chatCompletions`、`messages`、`responses`；调用方传入响应头到达耗时，未提供时估计值不得超过总耗时

## Anti-Patterns

- 在 route / handler 里手写 telemetry fetch，绕开这里的 envelope 与 timeout 规则
- 为 telemetry 加通用重试或 await，拖慢主请求
- 把敏感原文直接塞进 `TelemetryProperties`，破坏当前“非敏感字符串”假设
- 生成或持久化 device ID、session ID 等身份字段

## 真实 HTTP 验证

真实 HTTP 验收由人工明确执行，使用选定运行实例的账户凭据，从实际 token exchange 读取 endpoints.telemetry，逐项调用本模块的事件包装函数并核对完整载荷回执。验收需覆盖全部事件、mode、反馈结果、响应协议与后置采纳路径。每次发送要求 HTTP 200、itemsReceived=1、itemsAccepted=1、errors=[]；HEET 日报中的指标在报表刷新后核对。
