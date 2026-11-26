# Telemetry Service Guide

## Overview

这里封装 Copilot telemetry：解析 token 中的 `tid`、拼装 Application Insights envelope、异步发送事件，并模拟延迟 feedback 行为；业务请求绝不能依赖它成功。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Event sending | `telemetry.ts` | fire-and-forget fetch、success/error wrapper |
| Identity fields | `identity.ts` | machine ID、persistent device ID、session ID |
| Envelope / constants | `types.ts` | event names、AI envelope shape、`parseTid()` |
| Mock values | `mock-values.ts` | round-robin language/participant/command 与随机反馈 |

## Critical Invariants

- `initTelemetry()` 必须在拿到 Copilot token 后尽早执行；否则早期事件会缺 `ai.user.id`
- `trackEvent()` 是 fire-and-forget：不 await、不 throw，只记 warning；不能影响主请求成功与否
- `_endpoint` 需要规范化到单个 `/telemetry` 结尾；不能重复拼接，也不能把原始 endpoint 原封不动写进去
- `scheduleFeedbackEvents()` 只负责延迟调度；30% 采样统一由 `trackEvent()` 处理，避免双重采样把反馈比例压到 9%

## Project-Specific Rules

- `identity.ts` 的 `SESSION_ID` 只在进程生命周期内稳定；`getMachineId()` 与 `getDevDeviceId()` 分别在 `PATHS.APP_DIR` 下持久化随机生成的 `telemetry-machine-id`（64 位 hex）与 `telemetry-device-id`（UUID），不读取本机真实网卡 MAC 或宿主机 `~/.cache/Microsoft/DeveloperTools/deviceid`；身份文件写完后排他发布，进程内按文件路径缓存 ID；无法持久化时告警一次并保持本进程 ID，不改写无法读取的已有文件
- `getCommonProperties()` 和 `createMsftEnvelope()` 均不发送系统、架构和内核版本字段
- telemetry 总开关来自 `getConfig().telemetry === true`；默认关闭，不发送任何事件
- `trackRequestSent` / `trackResponseSuccess` / `trackResponseError` 支持透传 `modelCallId`，但是否生成 UUID 由上游 service 决定
- 成功与失败事件的 `apiType` 使用 `chatCompletions`、`messages`、`responses`；调用方传入响应头到达耗时，未提供时估计值不得超过总耗时

## Anti-Patterns

- 在 route / handler 里手写 telemetry fetch，绕开这里的 envelope 与 timeout 规则
- 为 telemetry 加通用重试或 await，拖慢主请求
- 把敏感原文直接塞进 `TelemetryProperties`，破坏当前“非敏感字符串”假设
- 在多个位置各自生成 device ID 或 session ID，造成身份字段漂移
