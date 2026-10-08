# 本地功能与上游接入

- 上游采用本仓库已经集成的 `czy-all`；本次整理的上游基准为 `c45d58e`。
- 行为对照采用 `dev` 已有提交 `55ef87d`；当前未提交修改调整本地策略的文件位置、调用位置和测试组织。功能行为分别列在各节。
- 本地策略由独立文件承载，共用入口保留上游的请求组织、JSON/SSE 结果处理和必要的策略调用。
- 同步上游时，按以下行为检查受影响的接入位置，并执行完整回归验证。
- 独有文档、图谱和测试文件通常没有同路径的上游修改；双方新增同名文件仍可能发生文本冲突，测试也需要跟随实际行为更新。

## 1. 共用请求发送与 Auto-session

**使用场景**：三个 Copilot API 入口需要一致的 HTTP 生命周期、TLS 重试和 Auto-session 处理。

**必须保留的行为**：

- 继续使用上游的 `fetchUpstreamWithLifecycle` 管理取消、headers 超时、流读取超时和响应体清理。
- 发送前已经取消的请求不访问上游；请求发出后继续读取上游响应并记录用量。headers 超时和流读取超时仍可终止上游请求。
- 每次实际发送时序列化当前 payload，保留同一 headers 对象与调用方的 `AbortSignal`。
- TLS 重试继续由既有 `retryAfterTlsCertificateVerificationFailure` 判定，最多重试一次。
- [auto-session-retry.test.ts](../tests/auto-session-retry.test.ts)：附带 token 的 `400`/`401` 单次重试、迟到 `401` 与失效后裸重试语义；系统实际调用 `/auto` 重新取得且重取失败时传出刷新错误并停止本次请求（不发第二次推理），旧 401 迟到且配对已被并发清除时仍为原模型无 token 重试一次。
- 仅当模型命中 `/auto` 配对且该配对支持请求端点时附加 `Copilot-Session-Token`；Responses WebSocket 分支不附加。
- Auto 会话令牌失效后的重试属于首次请求链；后续协议兼容重试只调用 HTTP/TLS 发送层。
- 启动 `/auto` 八个探测点（四档×简单题 `hello` 与随机连续 100 行真实 TS 难题），互不阻断、同点单飞；启动等待上限 30 秒，未完成点在服务运行期后台补采。
- 探测失败按类别处理：429 优先 `Retry-After`，网络失败与 5xx 按 1 秒起步 30 秒封顶随机退避，401/403 暂停相同凭据探测待凭据变化恢复，持续请求格式类 400 记为待处理。
- 每条配对按上游 `expires_at` 在到期前 5 分钟刷新（同点共享在途）；Copilot 凭据变化立即使旧配对失效，并在 token 与账号元数据全部落位后重新补采；Auto 查表与 `state.forceAgent` 内部标志无关。

**本地实现**：

- [request.ts](../src/services/copilot/request.ts)：HTTP/TLS 发送与 Auto 会话令牌失效后的首次重试的公共入口。
- [auto-session-retry.ts](../src/services/copilot/auto-session-retry.ts)：会话 header 附加、失效判定与刷新。
- [auto-session.ts](../src/lib/auto-session.ts)：会话配对表、启动探测、到期刷新与凭据轮换失效；[get-auto-selection.ts](../src/services/copilot/get-auto-selection.ts)：`/auto` 选模请求。
- [tls-retry.ts](../src/services/tls-retry.ts)：既有 TLS 错误判定、等待与单次重试。

**必要的上游接入**：三个 `create-*` service 的发送位置；启动和 token 更新位置保留会话预热、失效处理。上游 [upstream-http.ts](../src/services/upstream-http.ts) 的实现保持不变。

**验证入口**：

- [copilot-request.test.ts](../tests/copilot-request.test.ts)：本地真实 HTTP 请求、headers、原始错误和预取消行为。
- [responses-local-http.test.ts](../tests/responses-local-http.test.ts)：默认 handler 与 service 使用本地真实 HTTP 验证 JSON/SSE、413、发送前取消，以及发送后取消信号时的完整读取和用量记录。
- [auto-session-chains.test.ts](../tests/auto-session-chains.test.ts)：三个公开 service 的 Auto-session 注入链路。
- [auto-session-retry.test.ts](../tests/auto-session-retry.test.ts)：附带 token 的 `400`/`401` 单次重试、迟到 `401` 与失效后裸重试语义。
- [auto-session-discovery.test.ts](../tests/auto-session-discovery.test.ts)、[auto-session.test.ts](../tests/auto-session.test.ts)：启动探测、退避分类、到期刷新、凭据轮换与 `forceAgent` 无关性。
- [auto-session-logs.test.ts](../tests/auto-session-logs.test.ts)：日志隐私。
- [auto-session-websocket-local.test.ts](../tests/auto-session-websocket-local.test.ts)：本机真实 WebSocket 握手头验证不附 Auto token；[create-responses-websocket-pool.test.ts](../tests/create-responses-websocket-pool.test.ts)：Responses WebSocket 池化行为。
- [tls-retry.test.ts](../tests/tls-retry.test.ts)。
- [start-auto-session-prewarm.test.ts](../tests/start-auto-session-prewarm.test.ts)、[token-metadata.test.ts](../tests/token-metadata.test.ts)、[token-metadata-apply.test.ts](../tests/token-metadata-apply.test.ts)。

## 2. Native Messages 兼容

**使用场景**：通过 Copilot 原生 Messages API 发送 thinking、工具调用、图像及 adaptive thinking 请求。

**必须保留的行为**：

- 识别直接图像和 `tool_result` 中的图像，保留 vision header。
- 根据模型 capability 启用 adaptive thinking；强制工具选择时保持既有禁用条件。
- 请求显式指定的 `output_config.effort` 优先；配置中的 effort 继续按既有规则映射。
- 保留 beta 过滤、`top_p` 移除和 `temperature=1`。
- 调整 assistant 的 text/tool_use 顺序时，保持 thinking 与 redacted_thinking 的原位置。
- 仅匹配已有 `400` effort 或 thinking 错误时执行对应的单次兼容重试；首次请求保留完整 thinking 内容。
- 保留模型专属 header 条件、请求标识、错误响应以及 Telemetry 的调用顺序。

**本地实现**：[messages-compat.ts](../src/services/copilot/messages-compat.ts) 承载 headers、payload 准备与协议错误重试。

**必要的上游接入**：[create-messages.ts](../src/services/copilot/create-messages.ts) 调用本地准备与发送函数，保留公开 API、请求组织和结果处理。

**验证入口**：

- [create-messages.test.ts](../tests/create-messages.test.ts)：公开 service 行为。
- [messages-compat.test.ts](../tests/messages-compat.test.ts)：纯数据变换与本地真实 HTTP 重试。
- [auto-session-chains.test.ts](../tests/auto-session-chains.test.ts)。

## 3. Chat Completions 兼容

**使用场景**：通过 Copilot Chat Completions API 保留工具、reasoning、流式结果与响应附加信息。

**必须保留的行为**：

- 最后一条消息的角色决定原始 initiator，再按既有 smart-agent 规则处理。
- 首次发送保持请求内容；仅 `400` 且错误内容包含 `signature` 或 `cannot be modified` 时触发兼容重试，匹配不区分大小写。
- 重试只移除 assistant 的 `reasoning_opaque`、`reasoning_text`，保留工具调用与其他消息；不修改原始 payload 对象。
- 成功、失败及重试后的 Telemetry、premium 信息、原始响应 headers、HTTPError 和 JSON/SSE 返回形式保持一致。

**本地实现**：[chat-completions-compat.ts](../src/services/copilot/chat-completions-compat.ts) 承载 reasoning 错误判定、字段移除与单次兼容重试。

**必要的上游接入**：[create-chat-completions.ts](../src/services/copilot/create-chat-completions.ts) 保留请求组织、JSON/SSE 结果解析、Telemetry 和响应附加信息，调用共享发送入口与本地错误处理函数。

**验证入口**：

- [create-chat-completions.test.ts](../tests/create-chat-completions.test.ts)：公开 service 行为与 Telemetry。
- [chat-completions-compat.test.ts](../tests/chat-completions-compat.test.ts)：字段移除范围、工具调用保留和原始请求不变。
- [auto-session-chains.test.ts](../tests/auto-session-chains.test.ts)、[chat-completions-headers.test.ts](../tests/chat-completions-headers.test.ts)。

## 4. Responses HTTP replay 兼容

**使用场景**：历史 Responses reasoning item 绑定其他连接，Copilot 拒绝当前请求。

**必须保留的行为**：

- 首次发送保留 `reasoning.encrypted_content`。
- 同时满足 `4xx`、`error.message` 为字符串且大小写敏感地包含 `belong`、请求存在 `reasoning.encrypted_content` 时，才按既有逻辑处理输入并重试一次。
- 仅按 `error.message` 判断；其他错误字段、不同大小写、服务端错误和没有可处理 reasoning 的输入保持原错误路径。
- 保留 payload 原地更新、两次请求各自的 rate-limit 记录、响应 headers 和用量处理。
- WebSocket 分支、连接池、取消与终态处理继续使用上游实现。

**本地实现**：[responses-compat.ts](../src/services/copilot/responses-compat.ts) 的 `sendResponsesRequestWithReasoningReplay`。

**必要的上游接入**：[create-responses.ts](../src/services/copilot/create-responses.ts) 的 HTTP 发送位置调用兼容函数；JSON/SSE 结果处理保留在原入口。

**验证入口**：

- [create-responses.test.ts](../tests/create-responses.test.ts)：公开 service 的 replay、headers 和用量行为。
- [responses-compat.test.ts](../tests/responses-compat.test.ts)：错误字段与状态边界、本地真实 HTTP 重试。
- [create-responses-websocket-pool.test.ts](../tests/create-responses-websocket-pool.test.ts)。

## 5. Responses → Chat fallback

**使用场景**：Responses 路由按现有 endpoint 判定，选择 Chat Completions 处理请求。

**必须保留的行为**：请求、工具调用、响应事件和流式结果按既有规则转换；保持 output item 生命周期与递增的 `sequence_number`。

**本地实现**：[chat-handler.ts](../src/routes/responses/chat-handler.ts)、[responses-from-chat.ts](../src/routes/responses/responses-from-chat.ts)。

**必要的上游接入**：[Responses handler](../src/routes/responses/handler.ts) 调用 [local-behavior.ts](../src/routes/responses/local-behavior.ts) 判定 Chat fallback。原有 Messages fallback、参数预处理、stream ID、终态处理和取消清理继续保留在入口。

**验证入口**：

- [responses-handler.test.ts](../tests/responses-handler.test.ts)。
- [responses-from-chat.test.ts](../tests/responses/responses-from-chat.test.ts)。
- [chat-to-responses.test.ts](../tests/responses/chat-to-responses.test.ts)、[chat-to-responses-stream.test.ts](../tests/responses/chat-to-responses-stream.test.ts)。
- [responses-local-behavior.test.ts](../tests/responses-local-behavior.test.ts)：endpoint 判定、effort 保留、413 图片处理和原始错误传播。

## 6. 配额决策、用量与成本展示

**使用场景**：根据账号配额与配置决定 initiator，并在请求日志和用量展示中保留实际 token、缓存及成本信息。

**必须保留的行为**：

- smart-agent 沿用现有配置、配额判断和缓存，状态仍以共享 `state` 为来源。
- upstream headers 与 premium 信息分别通过现有 metadata 机制传递。
- route 层保留实际响应头转发；用量统计和成本展示沿用实际返回字段。
- token 响应由 [token-metadata.ts](../src/lib/token-metadata.ts) 的 `applyCopilotTokenExchange` 设置 token 与 endpoint，更新 Auto-session、账号与组织元数据，随后初始化 Telemetry；[token.ts](../src/lib/token.ts) 保留原有调用入口和导出。

**本地实现**：[smart-agent.ts](../src/lib/smart-agent.ts)、[response-headers.ts](../src/lib/response-headers.ts)。

**必要的上游接入**：

- 三个 Copilot service 的 initiator、响应附加信息与 route 回包位置。
- [get-copilot-usage.ts](../src/services/github/get-copilot-usage.ts)、[token.ts](../src/lib/token.ts)、[state.ts](../src/lib/state.ts)、[api-config.ts](../src/lib/api-config.ts)。
- [token-usage/index.ts](../src/lib/token-usage/index.ts)、[token-usage/store.ts](../src/lib/token-usage/store.ts)、[logger.ts](../src/lib/logger.ts)。

**验证入口**：

- [should-use-agent-mode.test.ts](../tests/should-use-agent-mode.test.ts)、[resolve-initiator.test.ts](../tests/resolve-initiator.test.ts)。
- [token-usage.test.ts](../tests/token-usage.test.ts)、[logger.test.ts](../tests/logger.test.ts) 与 [logger-local.test.ts](../tests/logger-local.test.ts)。
- [api-config.test.ts](../tests/api-config.test.ts)、[api-config-local.test.ts](../tests/api-config-local.test.ts)、[token-copilot-url.test.ts](../tests/token-copilot-url.test.ts) 与 [token-metadata-apply.test.ts](../tests/token-metadata-apply.test.ts)。

## 7. 多实例 router 与 dashboard

**使用场景**：多个本地后端之间保持 session 粘性、调度请求，并显示实例和会话状态。

**必须保留的行为**：既有实例选择、session 绑定、实例启停、配额信息和 dashboard 展示。

**本地实现**：[router/](../router/) 的独立入口、调度代码、脚本与页面资源。

**必要的上游接入**：没有需要为该独立入口新增的 Copilot service 接入。

**验证入口**：[tests/router/](../tests/router/) 中的 integration、proxy、state、实例切换和 dashboard 测试。

## 8. 请求 Telemetry

**使用场景**：沿现有开关和采样规则记录请求、响应、认证与交互事件。

**必须保留的行为**：`modelCallId` 在单次调用中保持一致；`requestId` 使用已构造的 headers；发送、成功、错误与后续事件的顺序、参数和条件保持一致。

**本地实现**：[services/telemetry/](../src/services/telemetry/) 的事件、identity 与发送模块。

**必要的上游接入**：三个 Copilot service 的请求和响应位置，以及 token 更新位置。发送结果解析和成功事件保留在各 service；本地协议重试保留对应的错误事件。

**验证入口**：

- [telemetry.test.ts](../tests/telemetry.test.ts)、[telemetry-events.test.ts](../tests/telemetry-events.test.ts)。
- [telemetry-identity.test.ts](../tests/telemetry-identity.test.ts)、[telemetry-integration.test.ts](../tests/telemetry-integration.test.ts)、[telemetry-msft-events.test.ts](../tests/telemetry-msft-events.test.ts)。

## 9. compact 请求的小模型选择

**行为**：Messages handler 识别 compact 与 auto-continue 请求后，按 `compactUseSmallModel` 配置选择 `getSmallModel()`。该配置默认开启。启用 `forceAgent` 时，`prepareForCompact` 保留 smart-agent 已确定的 initiator。

**源码与接入**：[Messages handler](../src/routes/messages/handler.ts)、[model-policy.ts](../src/lib/model-policy.ts)、[config-store.ts](../src/lib/config-store.ts)、[api-config.ts](../src/lib/api-config.ts) 与 [start.ts](../src/start.ts)。

**验证范围**：现有配置样本使用 `compactUseSmallModel`；功能清单调查未找到独立覆盖模型替换条件的测试。

## 10. Claude Code billing header 归一化

**行为**：Messages 预处理识别 system 内容中的 Claude Code billing header，按现有规则归一化其中的 `cch=` 部分。

**源码与接入**：[preprocess.ts](../src/routes/messages/preprocess.ts) 的 `normalizeClaudeCodeBillingHeaderInSystem`，由 [Messages handler](../src/routes/messages/handler.ts) 调用。

**验证范围**：功能清单调查未找到独立测试；本次保留已有处理规则。

## 11. 请求与翻译日志

**行为**：请求入口记录原始模型、目标模型、effort 与来源；Messages 路由使用自己的 IN/OUT 日志。协议转换和 provider 转发保留 thinking block、thinking config 的移除数量与原因记录。

**源码与接入**：[logger.ts](../src/lib/logger.ts)、[server.ts](../src/server.ts)、[Messages handler](../src/routes/messages/handler.ts)、[preprocess.ts](../src/routes/messages/preprocess.ts)、[non-stream-translation.ts](../src/routes/messages/non-stream-translation.ts)、[responses-translation.ts](../src/routes/messages/responses-translation.ts)、[provider Messages handler](../src/routes/provider/messages/handler.ts) 与 [provider Messages local-behavior.ts](../src/routes/provider/messages/local-behavior.ts)。

**验证入口**：[logger.test.ts](../tests/logger.test.ts)、[logger-local.test.ts](../tests/logger-local.test.ts)、[models-log.test.ts](../tests/models-log.test.ts) 与 [translation-drop-observation.test.ts](../tests/translation-drop-observation.test.ts)。本地日志观察使用实际转换结果，转换算法继续由原模块负责。

## 12. Responses reasoning replay 防护与 effort 映射

**行为**：Messages 转 Responses 时，只重放具有有效 signature 且 reasoning ID 长度不超过 64 的 thinking 内容；缺失 signature 或超过长度限制的内容按原规则处理并保留诊断。assistant phase 仅在模型配置含 `## Intermediary updates` extra prompt 时设置；effort `max` 映射为 `xhigh`。

**源码与接入**：[responses-translation.ts](../src/routes/messages/responses-translation.ts) 的 `createReasoningContent`、`shouldApplyPhase` 与 effort 映射。

**验证入口**：[reasoning-effort-local.test.ts](../tests/reasoning-effort-local.test.ts) 覆盖本地 effort 映射与日志值解析；[reasoning-effort.test.ts](../tests/reasoning-effort.test.ts) 保留上游 effort 归一化用例。reasoning ID 长度与 phase 条件的专门测试尚未确认。

## 13. prompt-cache 的 thinking 保护

**行为**：Responses 转 Messages 写入 ephemeral cache breakpoint 时，跳过 thinking 与 redacted thinking 尾部内容；Messages 预处理读取和写入 cache control 时继续跳过 redacted thinking。已有类型定义保留 `redacted_thinking`。

**源码与接入**：[messages-translation.ts](../src/routes/responses/messages-translation.ts)、[preprocess.ts](../src/routes/messages/preprocess.ts) 与 [anthropic.ts](../src/lib/types/anthropic.ts)。

**验证范围**：功能清单调查未找到独立覆盖所有缓存保护条件的测试；保留现有请求翻译和缓存测试。

## 14. `copilot_usage` 贯穿请求与响应转换

**行为**：Chat、Responses 与 Messages 转换保留 `copilot_usage`。流式转换累计最新用量，在对应的完成事件或 `message_delta` 中传递；Messages 流开始事件通过 `mergeUsage` 合并已有用量。web-search 合成事件和用量记录器继续携带 Copilot 用量。

**源码与接入**：[Messages 转换目录](../src/routes/messages/)、[messages-stream-translation.ts](../src/routes/responses/messages-stream-translation.ts)、[web-search fulfill](../src/routes/messages/web-search/fulfill.ts)、[api-flows.ts](../src/routes/messages/api-flows.ts) 与 [Messages local-behavior.ts](../src/routes/messages/local-behavior.ts)。

**验证入口**：[web-search-fulfill.test.ts](../tests/web-search-fulfill.test.ts)、[responses-stream-collection.test.ts](../tests/responses-stream-collection.test.ts) 与 [anthropic-response.test.ts](../tests/anthropic-response.test.ts)。

## 15. 模型目录信息与排序

**行为**：`GET /v1/models` 提供 premium、倍率、可用账号、模型限制、family、endpoints、工具调用、并行工具调用、流式与结构化输出能力等字段。排序依次考虑模型种类、premium、最大 prompt 和 context window；必要时使用已有的模型缓存加载路径。

**源码与接入**：[models route](../src/routes/models/route.ts) 的 `buildLimits`、`sortModels` 与模型缓存调用；[models.ts](../src/lib/types/models.ts) 保留 billing 类型。

**验证入口**：[models-route.test.ts](../tests/models-route.test.ts) 与 [models-log.test.ts](../tests/models-log.test.ts)。

## 16. 跨路由响应头转发

**行为**：允许转发的上游响应头经过统一筛选，随 JSON、SSE 或对应错误响应返回客户端。覆盖 Messages 的三条 API 路径、Responses fallback、web-search、provider 路由与 Codex Responses service。

**源码与接入**：[response-headers.ts](../src/lib/response-headers.ts) 的 `applyForwardableResponseHeaders`、`jsonWithForwardedHeaders` 与 `getAttachedResponseHeaders`，[Codex Responses helper](../src/services/codex/create-responses-local.ts) 的响应头附着，以及各 handler 的回包位置。

**验证入口**：[chat-completions-headers.test.ts](../tests/chat-completions-headers.test.ts)、[responses-handler.test.ts](../tests/responses-handler.test.ts) 与现有 provider 路由测试。

## 17. rate-limit 日志的空值处理

**行为**：`logCopilotRateLimits` 接受缺失 headers 的结果，WebSocket 等路径无需构造额外 headers；quota remaining 使用 debug 日志。

**源码与接入**：[copilot-rate-limit.ts](../src/lib/copilot-rate-limit.ts) 与各 service 的现有日志调用。

**验证范围**：功能清单调查未找到独立空值测试；保留现有 WebSocket 与 service 回归。

## 18. CLI 参数接口与当前限制

- `-F` / `--force-agent` 会被 CLI 接受并传入 `runServer`；`runServer` 初始化时将 `-F` 赋给 `state.forceAgent`。`-M` / `--native-messages` 旧限制仍在：仅被接受与传入，尚未经该启动路径赋给 `state`。
- `state.forceAgent` 与 `state.nativeMessages` 的初始值均为 `false`（以 [state.ts](../src/lib/state.ts) 默认值为准）。Messages API 的启用条件通过 `isMessagesApiEnabled()` 读取 `useMessagesApi` 配置。

**源码与接入**：[start.ts](../src/start.ts)、[state.ts](../src/lib/state.ts)、[config-store.ts](../src/lib/config-store.ts) 与 [Messages handler](../src/routes/messages/handler.ts)。`runServer` 将 CLI 的 `-F` 参数写入共享 `state.forceAgent`；Messages API 启用条件继续由现有配置控制。

**验证入口**：[start-auto-session-prewarm.test.ts](../tests/start-auto-session-prewarm.test.ts)（`runServer` 启动参数与 `state.forceAgent` 映射）。
