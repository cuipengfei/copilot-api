# Test Suite Guide

## Overview

测试统一使用 `bun:test`，覆盖路由翻译、native messages、telemetry、models、暗渡之门与 Responses 分支；主策略是 mock 上游服务，而不是打真实 Copilot API。

> **环境隔离**：使用 `bun run test [files]`，由 `test:isolated-env` 在启动 Bun 前设置临时 `HOME`、`XDG_CACHE_HOME`、应用目录、日志目录和内存 SQLite。`bunfig.toml` 预加载的 `tests/setup.ts` 会检查启动隔离标记与 `homedir()`，未经隔离的直接 `bun test` 会在加载测试文件前终止。需要验证文件持久化的测试可在测试内显式指定自己的临时文件。自定义验证脚本使用 `bun run test:isolated-env <script>`；需要传递 Bun 测试参数时使用 `bun run test:isolated-env test <args>`。禁止读写实际用户目录。

## Structure

- `create-messages.test.ts`, `create-chat-completions.test.ts`, `create-responses.test.ts`, `cache-models.test.ts` - service / cache 边界测试
- `native-messages-handler.test.ts`, `messages-*.test.ts`, `anthropic-*.test.ts`, `responses-*.test.ts` - Anthropic / Responses / messages 路径
- `router/` - 多实例调遣之器单元测试（lib.test.ts, state.test.ts, proxy.test.ts, integration.test.ts）；注入 `fetchImpl`/`now` 参数 mock
- `router/` 有独立测试约定；详见 `tests/router/AGENTS.md`
- `telemetry*.test.ts` - telemetry、identity、GitHub 事件、后置调度与 integration
- `chat-completions-handler.test.ts`, `messages-handler.test.ts` - route handler 行为
- `responses-handler.test.ts`, `responses-translation.test.ts`, `responses-stream-translation.test.ts` - Responses handler / translation 行为（公开端点测试）
- `tests/responses/` - Responses 子目录，含双向翻译、stream 翻译与 replay 专项测试：
  - `responses-from-messages.test.ts`, `responses-from-chat.test.ts` - 双向翻译测试
  - `anthropic-to-responses-stream.test.ts`, `chat-to-responses-stream.test.ts` - stream 翻译事件序列测试
  - `chat-to-responses.test.ts` - chat → responses 格式转换测试
- `responses-preflight.test.ts` - Responses payload preflight 预处理测试
- `provider-auth.test.ts` - provider auth (x-api-key / Authorization Bearer) 切换
- `token-refresh.test.ts` - wall-clock token 刷新调度
- `models-route.test.ts`, `models-log.test.ts`, `reasoning-effort.test.ts` - models 与 reasoning 能力覆盖
- `server.test.ts`, `main-cli-global-options.test.ts`, `logger.test.ts`, `trace.test.ts`, `deviceid.test.ts`, `utils.test.ts`, `resolve-initiator.test.ts`, `should-use-agent-mode.test.ts`, `token-metadata.test.ts`, `api-config.test.ts` - CLI / server / lib 辅助覆盖
- `fixtures/` - 录制数据；优先复用，不要请求真实 API

## Project-Specific Conventions

- 统一用 `mock.module(...)` 替换 `~/services/...`、`~/lib/...` 依赖
- service / route 行为变更时，测试应对齐真实契约；如果契约属于文档化能力，通常还要同步 OpenSpec
- 不要硬编码 token 计数；用 `expect.any(Number)` 或对行为做区间/结构断言
- `state` 是共享单例，测试要在 `beforeEach` 里重置相关字段与缓存（例如暗渡之门 cache）
- telemetry 30% 采样相关断言必须 mock `Math.random()` 或改为结构断言；不要把随机门限当成稳定输出
- 任何改动若改变了 upstream response 包装方式，测试应同时覆盖 body 与 headers；quota/rate-limit snapshot 这类元数据不能只靠 body 断言间接证明
- parser/normalizer 遇非法 header 值时，应补回落为 `null` 的测试，而不是只测 happy path

## Commands

```bash
bun run test  # 全量：临时应用目录、内存 SQLite、bun test --isolate
bun run test tests/create-messages.test.ts  # 隔离环境中的单文件测试
bun run test:isolated-env <script.ts>  # 在临时隔离目录与内存 SQLite 下运行自定义验证脚本
bun run check:all  # 一键执行 lint:all --fix、build、build:desktop、test、typecheck:all、lint:all
```

## Anti-Patterns

- 真实调用 Copilot / GitHub API
- 为了让测试通过而删除已有失败断言
- 复制大型 fixture 内容进测试文件；优先放 `tests/fixtures/`
- 忘记恢复全局状态、fetch mock 或暗渡之门 cache
- 在 router 测试里断言随机 tie-break 的具体端口号；对 least-loaded 平局必须用集合/相等性断言 sticky 语义
- 只验证 JSON/SSE body，不验证上游 quota/rate-limit 头是否被继续带出
