# Models Route Guide

## Overview

这里封装 `/v1/models`：共享模块提供 Copilot 与 provider 模型发现，普通客户端保留增强 limits / capability / billing 字段和排序；Claude Code、Codex 与 OpenCode 使用各自的展示格式。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Route entry | `route.ts` | 仅有 `GET /`，失败统一走 `forwardError()` |
| Limit shaping | `model-discovery.ts` | `buildLimits()` 负责 thinking_budget / vision 展开 |
| Sort policy | `default-models.ts`、`model-discovery.ts` | 普通客户端按类型、premium、token 容量排序 |
| Fallback cache | `model-discovery.ts` | Copilot 是唯一来源且 `state.models` 为空时调用 `cacheModels()` |

## Critical Invariants

- Copilot 已启用、其他 provider 清单为空且 `state.models` 未加载时，先 `await cacheModels()`。
- `cacheModels()` 保留 picker-enabled 与 embeddings 模型，并排除 policy-disabled 模型；路由复用该缓存结果。
- `buildLimits()` 要对 `caps.limits ?? {}` 做防御性处理；某些模型（特别是 embeddings）在运行时可能没有完整 limits
- 普通客户端返回顺序由 `sortModels()` 决定：`chat` 优先于 `completion` / `embeddings`，同类型内 premium 优先，再按 `max_prompt` / `context_window` 降序；其他客户端保留各自展示顺序。

## Project-Specific Rules

- `limits.thinking_budget` 只在同时存在 `min_thinking_budget` 与 `max_thinking_budget` 时暴露
- `limits.vision` 只在 `rawLimits.vision` 存在时展开，且要把 image size / image count / media types 一并映射出来
- 返回体同时保留 backward-compatible 字段（`id/object/type/created/created_at/owned_by`）和本项目增强字段（`family/preview/endpoints/supports_*`）
- `created` / `created_at` 目前没有上游真实时间，固定为 `0` / `new Date(0).toISOString()`；不要伪造发布日期

## Anti-Patterns

- 绕过 `cacheModels()` 直接缓存上游原始 models，或在路由层重复做 `model_picker_enabled` 过滤
- 只按模型名排序，丢掉 premium 与 token 容量优先级
- 对缺失 limits 的模型直接取深层字段，触发运行时异常
- 在别的路由里复制 models 变形逻辑，而不是统一走这里的 `/v1/models`
