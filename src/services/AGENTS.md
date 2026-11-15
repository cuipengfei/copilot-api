# Services Runtime Guide

## Overview

`src/services/` 是外部系统交互边界层：Copilot 上游调用、GitHub 认证与 usage、provider 转发、telemetry 发送都在子目录；根层仅保留跨子域的轻量服务入口。

## Structure

- `get-vscode-version.ts` - VSCode 版本探针（当前返回稳定 fallback）
- `responses-websocket.ts`, `responses-websocket-continuation.ts`, `responses-websocket-helpers.ts`, `responses-websocket-interrupt.ts` - Responses WebSocket 传输、同连接同会话增量续传、字节计数与中断控制
- `copilot/` - Copilot upstream service 边界（chat/messages/responses/models/embeddings）
- `github/` - GitHub OAuth/device flow、Copilot token、usage 查询
- `providers/` - 外部 Anthropic-compatible provider 转发
- `telemetry/` - telemetry envelope、identity、异步上报

## Nested Guides

- `copilot/AGENTS.md` - Copilot service 约束：headers、initiator、retry、backend workaround
- `github/AGENTS.md` - GitHub service 约束：OAuth/device flow、token/usage 边界
- `providers/AGENTS.md` - Provider service 约束：header allowlist、response strip、proxy 边界
- `telemetry/AGENTS.md` - telemetry service 约束：fire-and-forget、identity、采样语义

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Copilot upstream behavior | `copilot/*` | messages/chat/responses 适配与重试策略在此收口 |
| Responses WebSocket & continuation | `responses-websocket*.ts` | 根层共享 WebSocket 传输与续传封装（Copilot 与 Codex 共用），创建流时捕获 `sessionId` |
| GitHub token/usage | `github/*` | 不在 route 层维护 token 状态副本 |
| Provider proxy transport | `providers/anthropic-proxy.ts` | 只做 provider 转发，不混 Copilot telemetry 语义 |
| Telemetry delivery | `telemetry/*` | 事件发送失败不可阻塞主请求 |
| VSCode version fallback | `get-vscode-version.ts` | 由 `~/lib/utils.ts` 的 `cacheVSCodeVersion()` 调用 |

## Project-Specific Conventions

- 根层 `src/services/*.ts` 应保持轻量（单一职责工具服务）；复杂边界逻辑应归入对应子目录。
- `get-vscode-version.ts` 当前是稳定 fallback 返回，不直接访问远程 API；调整行为时要同步检查 `cacheVSCodeVersion()` 调用链。
- service 层承担上游通信语义，route 层承担协议适配与错误透传；不要跨层复制重试/header 组装逻辑。

## Anti-Patterns

- 在 `src/services/` 根层新增高复杂度、跨多个外部系统的聚合逻辑。
- 在 route 或 lib 层复制 service 已有的上游请求策略（retry、header allowlist、telemetry 发送）。
- 让 telemetry/usage 失败中断主请求成功路径。
