
# copilot-api AGENTS

GitHub Copilot API 反向代理，基于 **Hono**，对外暴露 OpenAI / Anthropic 兼容端点。

This is a Bun/TypeScript API gateway project. API protocol contract types (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages) live under `src/lib/types/`; tests are in `tests/` and follow the same feature names as the source modules they cover.

## 全局规则

- 不要猜测；不确定时先验证，无法验证就明确说明。
- 默认中文回复。
- 收到明确任务或 skill 指令时直接执行；只有确实缺少关键上下文时才提问。
- 运行时代码优先查看 `src/`；测试优先查看 `tests/`；多实例调遣之器（Sticky Router）藏于 `router/`；提案流程查看 `openspec/`。
- `.vendor/`、`.sisyphus/`、`.debates/`、`history/`、`experiments/` 默认不是主运行时逻辑，除非任务明确涉及。

## 快速参考

```bash
bun run dev            # 开发服务器（watch，启用 system CA）
bun run build          # 构建（tsdown）
bun run build:desktop  # 构建 desktop server bundle
bun run test           # 全量测试（bun test --isolate，每文件全新 global，防止跨文件 mock 泄漏）
bun test tests/foo.test.ts  # 跑单个测试文件
bun run lint:all --fix # Lint 并修复
bun run typecheck      # 类型检查
bun run typecheck:all # 网关与桌面端类型检查
bun run --cwd desktop test  # 桌面端测试
bun run --cwd desktop build # 桌面端 Electron 构建
```

## 代码改动最终检查（MUST）

pre-commit hook 只跑 `lint-staged`（仅暂存文件的 lint），不保证项目级完整性。
**每次代码改动完成后，报告“完成”、请求提交或实际提交前，必须运行并通过以下全量检查：**

1. `bun run lint:all --fix` — 先修复格式或 lint；若改动文件，继续后续所有检查
2. `bun run build`
3. `bun run test`（全量测试，即 `bun test --isolate`；不要只跑目标文件）
4. `bun run typecheck`
5. `bun run lint:all` — 确认修复后零 lint 错误

任何一步失败，必须修复后从受影响检查重新运行；**不要用 `--no-verify` 跳过**。目标测试可用于定位，但不能替代全量 `bun run test`。

## Commit 规范

- Conventional Commit 前缀：`feat:`、`fix:`、`chore:`、`refactor:` 等。
- subject 简短祈使句，如 `feat: support custom provider auth flow`。
- PR 须含清晰摘要、关联 issue、测试证据（`bun test`、targeted tests、lint/typecheck）；desktop 或 UI 变更附截图。

## 安全

- 禁止提交 token、本地凭据、生成的 secret。
- 审查 auth、proxy、TLS、token refresh 变更时格外谨慎，尤其 `src/lib/`、`src/auth.ts`、`src/services/github/` 下的文件。

## 测试覆盖要求

变更代码应达到至少 85% 单元测试覆盖率；覆盖请求翻译、provider 行为、auth、config、流式边界等受影响模块。

常用启动标志：

- `-M`：Claude 模型走原生 `/v1/messages`
- `-F`：启用暗渡之门（按配额转圜流向，详情参见 `src/lib/smart-agent.ts`）
- `-a business`：指定账户类型
- `--manual`：手动审批每个请求
- `--proxy-env`：从环境变量读取代理配置

## 架构总览

- 主链路：`客户端兼容 API → OpenAI 中间格式（多数模型）→ GitHub Copilot API`
- 例外：`-M` 时，Claude 模型绕过中间格式，直接走 Copilot 原生 `/v1/messages`；该分支上游校验更严格。
- 路由通常双注册在 `/` 与 `/v1/`；新增公开端点时，先检查是否需要双前缀同时挂载。
- 共享运行时状态的唯一真相源是 `src/lib/state.ts`；不要复制平行状态缓存。
- 后端兼容补丁放 `src/services/copilot/*`；`handler.ts` 负责路由分发与翻译编排，不承载上游 workaround。

## 仓库布局

| 目录 | 职责 |
|:-----|:-----|
| `src/` | 核心 server 与 route 代码 |
| `src/lib/` | 共享工具（api-config、auth、token、smart-agent、state） |
| `src/services/` | provider 集成（copilot、github、providers、telemetry） |
| `src/routes/` | HTTP 路由（messages、chat-completions、responses、models、provider 等） |
| `tests/` | 测试，文件名与对应源模块同名 |
| `router/` | 多实例 sticky-router（调度、dashboard） |
| `pages/` | 静态 web 资源（如 usage-viewer 页面） |
| `desktop/` | Electron 桌面 app，自带 source/assets/package，与主项目隔离 |
| `plugin/` | 插件脚本，**被根 ESLint 配置排除**（lint 不覆盖） |
| `docs/` | 文档与截图 |
| `openspec/` | proposal / delta spec 工作流 |
| `.vendor/` | 第三方 vendor（非主运行时逻辑） |

## 必须记住的跨目录约束

- 所有流式翻译都必须保证 `stream.close()` 能在清理路径中执行，通常通过 `try/finally` 保证。
- `finish_reason: "tool_calls"` 是中间态，不是终态；不要在这里清空工具调用累加器。
- 使用 `~` 别名导入 `src/` 下模块。
- 默认使用 `consola` 或项目 logger helper；不要新增 `console.log` 风格日志。
- 调试 Copilot 后端时，使用 `copilot-backend-tester` skill，并带 `X-Initiator: agent`。

## 代码风格

- ES modules + strict TypeScript。
- `camelCase` 函数/变量，`PascalCase` 类型/类，`UPPER_SNAKE` 常量。
- 文件名语义化（如 `responses-stream-translation.ts`）。
- 避免 `any`；request/response/entity/DTO 字段须按真实源类型建模。
- 格式由 ESLint + Prettier 强制：**无分号**、双引号、尾逗号、`Array<T>` 而非 `T[]`。
- 函数参数多于两个时用 options 对象 + 解构。

## 目录导航

- `src/AGENTS.md` - 运行时代码总览：CLI、server、routes、services、shared state
- `src/lib/AGENTS.md` - `state.ts`、`config.ts`、`token.ts`、`smart-agent.ts` 等共享基础设施约束
- `src/routes/messages/AGENTS.md` - Anthropic `/v1/messages`、native messages、streaming 约束
- `src/routes/chat-completions/AGENTS.md` - OpenAI chat completions 路由与 stream/non-stream 分支
- `src/routes/models/AGENTS.md` - `/v1/models` 过滤、排序与增强字段
- `src/routes/responses/AGENTS.md` - OpenAI Responses 路由、stream ID sync、tool 预处理
- `src/routes/provider/AGENTS.md` - `/:provider/v1/*` 代理路由、messages/models/count_tokens 分流
- `src/services/AGENTS.md` - service 根层边界与目录职责
- `src/services/copilot/AGENTS.md` - Copilot 上游调用、native messages 兼容、telemetry
- `src/services/github/AGENTS.md` - GitHub auth、device flow、Copilot token、usage
- `src/services/providers/AGENTS.md` - 多 provider 转发、header allowlist、response 清洗
- `src/services/telemetry/AGENTS.md` - telemetry envelope、identity、fire-and-forget
- `tests/AGENTS.md` - Bun 测试布局、mock 约定、fixtures、断言风格
- `tests/router/AGENTS.md` - 多实例调遣之器测试规约：fetch/time 注入与 sticky 之验证
- `router/AGENTS.md` - 多实例调遣之器之内里：session-sticky、least-loaded、dashboard、start.sh
- `plugin/claude/AGENTS.md` - Claude Code plugin / marketplace 与 `__SUBAGENT_MARKER__`
- `openspec/AGENTS.md` - proposal、delta spec、validate / archive 工作流

## 任务入口建议

- 改 CLI 启动、flags、middleware、全局配置：先看 `src/AGENTS.md`
- 改 Claude / Messages / thinking / tool calling：先看 `src/routes/messages/AGENTS.md` 与 `src/services/copilot/AGENTS.md`
- 改 OpenAI chat / responses / models 兼容层：先看对应 `src/routes/*/AGENTS.md`
- 改多实例调遣或 dashboard：先看 `router/AGENTS.md`
- 改测试或补回归：先看 `tests/AGENTS.md`
- 做 proposal / spec / architecture 级变更：先看 `openspec/AGENTS.md`

## 近期高价值变更提示

- Claude `-M` 原生 messages 分支别有上游约束；相关兼容逻辑集中在 `src/services/copilot/create-messages.ts`。
- 暗渡之门（`-F`）之取舍，并 token / usage 判别之机，俱归 `src/lib/smart-agent.ts` 与相关 usage service 收束。
- Provider-scoped 路由、Responses API、`/v1/models` 增强能力都已有现成实现；改动前先读对应目录 AGENTS。
- Responses 已支持三路分支（原生 / messages fallback / chat fallback）；双向翻译模块 `src/routes/responses/responses-from-messages.ts` 与 `responses-from-chat.ts` 含 monotonic `sequence_number` 与 output item 生命周期。
- Gemini 支持已完全移除（`src/routes/generate-content/`、`GEMINI.md`、`tests/generate-content/` 不再存在）；quota/rate-limit headers 收束为跨目录契约：`src/services/copilot/*` 附着 headers，`src/lib/response-headers.ts` 过滤转发，`src/routes/*` 最终回包。
