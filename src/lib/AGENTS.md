# Shared Runtime Library Guide

## Overview

`src/lib/` 承载跨路由共享之基础设施：状态、配置、日志、错误、限流、路径、token 生命周期，与暗渡门下之决断，俱从此出。

## Where To Look

| Runtime singleton state | `state.ts` | 全局唯一真相源；含 interactionId（per-session UUID） |
| Config file / defaults | `config.ts`, `paths.ts` | `COPILOT_API_HOME`、`config.json`、默认 prompts |
| Token lifecycle | `token.ts` | GitHub/Copilot token 获取与刷新；wall-clock 按 token 剩余时间分段重新调度，AbortController 管理生命周期；opencode OAuth 模式复用 GitHub token 并停 refresh loop |
| Rate limit / approval / copilot-rate-limit | `rate-limit.ts`, `approval.ts`, `copilot-rate-limit.ts` | `-r` / `-w` 与手动确认；copilot-rate-limit 管理 Copilot 上游 429 响应的冷却逻辑 |
| Response header forwarding | `response-headers.ts` | 统一附着/提取 upstream headers，剥离 hop-by-hop headers，并提供 JSON/SSE 回包 helper |
| Logging / debug / models log | `logger.ts`, `models-log.ts` | stream log、debug dump、models 输出；三路路由共用 `getPremiumInfo()` / `formatStreamLog()` |
| 暗渡之门策略 | `smart-agent.ts` | forceAgent / 配额决断与缓存 |
| API request config | `api-config.ts` | 统一组装 Copilot headers / host / UA / compact 前处理 |
| Compact 标记 | `compact.ts` | compact request / auto-continue prompt 常量 |
| Subagent 标记类型 | `subagent.ts` | `__SUBAGENT_MARKER__` 前缀常量与类型；真正解析在 `src/routes/messages/subagent-marker.ts` |
| Auto-session 管理 | `auto-session.ts` | 自动会话初始化与续期逻辑 |
| Auto-probe 固定题目 | `auto-probe-prompts.ts` | 启动预热、定向补采与刷新共用的三个固定探测文本；措辞须保持固定 |
| Device ID / opencode 识别 | `deviceid.ts`, `opencode.ts` | 设备指纹生成、opencode 运行模式检测 |
| Request auth / context | `request-auth.ts`, `request-context.ts` | 请求级认证与上下文提取 |
| Trace | `trace.ts` | 请求级 trace ID 注入 |
| Tokenizer | `tokenizer.ts` | 本地 tokenizer 计算（count_tokens 用） |
| Utils | `utils.ts` | 通用工具函数（重试、延时、类型守卫等） |
| Proxy | `proxy.ts` | HTTP 代理配置 |
| Shell | `shell.ts` | Shell 命令执行 helper |
| Models | `models.ts` | 模型列表与映射 |
## Project-Specific Conventions

- `state.ts` 不只是方便访问；它是运行时可变状态的唯一位置
- `config.ts` 会把默认 `extraPrompts` 与 `modelReasoningEfforts` 合并回用户配置文件，不只是内存 fallback
- `config.ts` 同时承载 provider 配置：`providers.<name>.baseUrl/apiKey/models.<model>.{temperature,topP,topK}`；取用时统一走 `getProviderConfig()`，不要在路由里手动 trim/校验
- `paths.ts` 支持 `COPILOT_API_HOME` 覆盖默认目录；改路径逻辑时要兼顾 Windows/WSL 使用方式
- `token.ts` 的刷新循环和 telemetry 初始化耦合，改认证链路时别漏 `trackAuthNewToken()` / `initTelemetry()`
- `auto-session.ts` 现管理 `/auto` 选模配对：按 `selected_model.id` 保存 `session_token`、`expires_at` 与 `supported_endpoints`，表键是上游实际选中的模型 ID；它只做按模型 ID 查表，不替客户端改请求模型 ID。
- `auto-session.ts` 的配置目标 miss 补采：cold/过期 miss 共享单飞定向轮（每点一个在途），前台最多等 2s；一轮耗尽仍有缺失进 10 分钟冷却，invalidate/凭据轮换清零。等待者持有进入时凭据快照，轮换/stop 统一唤醒且不得把新配对返回给旧 Authorization；身份就绪以 metadata 更新完成时记录的 `discoveryToken` 判定，含运行中 reload 启用 Copilot 的路径，无需重启。
- `Copilot-Session-Token` 可能与生成它时的 Copilot auth/account context 绑定；改 `token.ts`、认证刷新或账户切换逻辑时，要检查 auto-session cache 是否需要失效，避免旧 session token 搭配新 auth token。
- `smart-agent.ts` 只缓存 `forceAgent=true` 之决断；“尚在预算之内”不作缓存之项
- `api-config.ts` 组装请求头后被三个 `create-*` service 共享调用，不要在 service 内重复构造 header
- `logger.ts` 的 `getPremiumInfo()` / `formatStreamLog()` 现在被 chat-completions、messages、responses 三条路由共用；progress log 可以失败，但不能改写 SSE/JSON 响应内容
- `response-headers.ts` 负责另一条元数据链：upstream response headers。premium info 与 response headers 不可混作同一概念；service 附着 headers，route 再决定如何转发
- 任何上游 response header 往客户端透传前，都必须先经过 `cloneForwardableResponseHeaders()` 的 hop-by-hop 过滤；不要在 handler 里手写 `Object.fromEntries(response.headers)`
- `rate-limit.ts` 只有在 `rateLimitSeconds` 为 finite number 时才启用等待；脏配置视为未启用，而不是隐式 sleep / retry

## Anti-Patterns

- 绕开 `state.ts`，在 handler/service 私自保存运行时副本
- 把配置默认值散落到调用方，而不是统一收口到 `config.ts`
- 在 provider route/service 里直接拼上游 headers 或 response header strip 逻辑，绕过 `getProviderConfig()` / `anthropic-proxy.ts`
- 把 rate limit 的等待实现成隐式重试；项目语义是 sleep，不是 retry/backoff
- 修改路径规则却不考虑 `COPILOT_API_HOME` 和本地数据目录兼容性
- 在 route 层直接透传未经清洗的 upstream headers，或把 SSE 响应错误地套进 JSON header helper
