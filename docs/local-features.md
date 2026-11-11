# 本地功能与上游接入

- 上游采用本仓库已经集成的 `czy-all`；本次整理的上游基准为 `c45d58e`。
- 行为对照采用 `dev` 已有提交 `55ef87d`；当前未提交修改调整本地策略的文件位置、调用位置和测试组织。功能行为分别列在各节。
- 本地策略由独立文件承载，共用入口保留上游的请求组织、JSON/SSE 结果处理和必要的策略调用。
- 同步上游时，按以下行为检查受影响的接入位置，并执行完整回归验证。
- 独有文档、图谱和测试文件通常没有同路径的上游修改；双方新增同名文件仍可能发生文本冲突，测试也需要跟随实际行为更新。

## 1. 共用请求发送与折扣会话

**使用场景**：三个 Copilot API 入口需要一致的 HTTP 生命周期、TLS 重试和 Fusion/Auto 折扣会话处理。

**必须保留的行为**：

- 继续使用上游的 `fetchUpstreamWithLifecycle` 管理取消、headers 超时、流读取超时和响应体清理。
- 发送前已经取消的请求不访问上游；请求发出后继续读取上游响应并记录用量。headers 超时和流读取超时仍可终止上游请求。
- 每次实际发送时序列化当前 payload，保留同一 headers 对象与调用方的 `AbortSignal`。
- TLS 重试继续由既有 `retryAfterTlsCertificateVerificationFailure` 判定，最多重试一次。
- [auto-session-retry.test.ts](../tests/auto-session-retry.test.ts)：每次进入共享折扣降级链最多三次业务发送，依次为 Fusion、Auto、无 token；只对携带 token 的 `400`/`401`（`belong` 拒绝除外）定向失效并前进到下一来源，同一链不再回头使用已用来源。配对刷新失败不阻止使用另一来源或原价发送；原价生成失败、`429`/`5xx`、取消及流开始后的错误仍按原路径返回。`413` 图片处理可能重新进入整条生成链，signature、effort 与 `belong` 修正各有既有兼容发送，TLS 重试独立计数，各类发送分别记录。
- 仅当最终上游模型在所选来源（有效 Fusion 优先，其次 Auto）有有效配对、凭据身份一致且该配对支持请求端点时，在真实 HTTP 生成分支附加 `Copilot-Session-Token`。Fusion 候选只适用于已验证的 `/responses` 端点，模型目录不能扩大该端点集合。Responses WebSocket 分支不附会话 token，也不因存在配对而切换传输。
- 带 token 请求被拒绝时只失效实际发送的 token 对应来源候选，并在后台按同一来源重获，不阻塞当前请求链，也不重放已经成功的生成。后续协议兼容重试只调用 HTTP/TLS 发送层。
- 启动同时运行 Auto 四档八个探测点（四档×简单题与难题）与 Fusion 四个固定题面（`hello`、CSS Flexbox 题、`TARGET_CODE_PROMPT`、`getIntelligenceProbePrompt()`），互不阻断、同点单飞，共享 30 秒启动等待上限。Fusion 四个种子在每个身份下各最多发送一次请求，失败不重试，也不阻止后续共享补采。Auto 简单题使用 `hello`；`intelligence` 难题使用已验证的完整题面与冻结的 100 行真实 TypeScript 源码样本，其余三档独立采样当前仓库源码。未完成点在服务运行期后台补采。
- `intelligence` 首次难题仍未覆盖配置目标，或同档两题选中相同模型时，最多追加一次题面变体。目标补充探测优先 `intelligence` 并轮换三个已验证题面，其余档位沿用简单题与代码任务交替；Auto 每档最多十次。已有 10% 的模型仍是 Fusion 升级目标：Fusion 续期与过期重获进入共享轮次，每轮最多十次请求，包含保存题面的首次尝试与所有失败尝试；返回的模型按实际结果登记，缺失目标继续用 intelligence 题面变体补采，请求间隔至少 3 秒，轮次耗尽冷却 90 秒，之后由后续 miss 重新开启轮次；固定输入及变体由 `getIntelligenceProbePrompt()` 统一提供，成功配对的刷新重放实际成功文本。
- 各来源独立判定探测失败：429 与 Fusion 5xx 的有效 `Retry-After` 优先于退避，网络失败与其余 5xx 按 1 秒起步 30 秒封顶随机退避，持续请求格式类 400 记为待处理。Fusion 的退避截止在有界轮次结束后仍保留，后续请求不得早于该时间发送。401 视为身份异常并暂停两个来源的探测，403 只暂停当前来源，两者均待凭据变化恢复。Fusion 的 `model_pool_not_eligible` 或端点不支持只暂停该来源在当前身份下的探测，不暂停 Auto。
- 每个模型分别缓存 Fusion 与 Auto 候选；有效 Fusion 始终优先。已有有效 Auto 而 Fusion 正在取得或续期时，前台立即使用 10%，不等待 30%；新的有效 Fusion 登记后下一请求立即优先，无需重启。无任何配对时，配置目标共享补采最多等待 2 秒，之后按原价发送。
- 每条候选按各自上游 `expires_at` 在到期前 5 分钟刷新（同来源同点共享在途）。Fusion 到期时删除过期候选并按保存的成功题面重新取得，即使 Auto 仍有效也不跳过；Auto 到期后按来源补采。Copilot 凭据变化立即使旧配对失效，并在 token 与账号元数据全部落位后按来源重新补采；种子、在途探测、共享轮次及轮次结束后的重启都等待该就绪条件，旧身份下启动的结果和迟到响应不能登记到新身份或覆盖较新候选。折扣查表与 `state.forceAgent` 内部标志无关。
- 持续取得、刷新与补采 Fusion 配对，不使用促销日期常量、日期开关或按日期失效缓存；官方公布的优惠日期仅作参考，不参与运行时启停，缓存有效期只取服务端 token expiry。
- 启动汇总输出一次 `wanted`，`obtained` 是当前身份下至少有一个有效候选的模型并集，`missing` 是 `wanted` 中没有有效候选的模型；另输出 `fusion_obtained`、`auto_obtained`、`fusion_missing`、`auto_missing` 展示各来源覆盖。等待预算到期输出快照，最终列表未变化时不重复输出；启动结果与快照保留完整双来源列表。单来源轮次开始时只输出 source、reason 与该来源 missing，结束时只输出 source、该来源本轮新增的 added 与 missing，added 不包含另一来源。两个来源分别判断目标是否完成。
- 首次取得某模型与来源的有效候选、10% 升至 30%、失效、过期或拒绝后的重新取得、定时器或显式刷新成功使用 `consola.info`；后台补采重复覆盖尚有效的同来源候选只记 `consola.debug`，仍更新 token、到期时间与刷新定时器，有效候选登记成功后才输出续期 INFO。逐请求日志由 HTTP 与 WebSocket 共用的 `logAutoSessionSelection` 输出，字段限于模型 ID、source（`fusion`/`auto`/`none`）、expected_discount、升级时的 previous_discount、endpoint、transport 与固定 reason；WebSocket 不传 selection，记录 `transport=websocket`。常规模型 ID 去除外围双引号，异常模型 ID 保留 JSON 引号与安全转义，控制字符按 JSON 转义保持单行；仅在 TTY 且启用颜色时正常模型 ID 与 IN 同色、命中绿色、未命中黄色，`NO_COLOR` 或非 TTY 为纯文本。取得日志表示候选已登记，逐请求日志表示本次携带 token 的预期折扣，不宣称账单已确认。真实费用直接使用上游 `copilot_usage`，不按 30%/10% 二次计算。日志不输出 token、header 对象、题面、源码、原始响应或原始错误消息。

**本地实现**：

- [request.ts](../src/services/copilot/request.ts)：HTTP/TLS 发送与折扣降级链首次请求的公共入口。
- [auto-session-retry.ts](../src/services/copilot/auto-session-retry.ts)：按选中候选附加会话 header、拒绝后的来源定向失效与有限降级。
- [auto-session.ts](../src/lib/auto-session.ts)：两来源候选表、启动探测、逐候选到期刷新与凭据轮换失效；[get-auto-selection.ts](../src/services/copilot/get-auto-selection.ts)：`/auto` 选模请求；[get-fusion-selection.ts](../src/services/copilot/get-fusion-selection.ts)：`/model/fusion` 请求与 solo 单步响应校验。
- [auto-probe-prompts.ts](../src/lib/auto-probe-prompts.ts)：Auto 固定探测题面、验证要求变体与 Fusion 固定题面；[auto-probe-sample.json](../src/lib/auto-probe-sample.json)：冻结源码样本及其原始文件、零起点行号和行数。固定样本用于保持输入可复现，不表示当前源码存在题面所描述的故障，也不保证上游始终返回某个模型。
- [tls-retry.ts](../src/services/tls-retry.ts)：既有 TLS 错误判定、等待与单次重试。

**必要的上游接入**：三个 `create-*` service 的发送位置；启动和 token 更新位置保留会话预热、失效处理。上游 [upstream-http.ts](../src/services/upstream-http.ts) 的实现保持不变。

**验证入口**：

- [copilot-request.test.ts](../tests/copilot-request.test.ts)：本地真实 HTTP 请求、headers、原始错误和预取消行为。
- [responses-local-http.test.ts](../tests/responses-local-http.test.ts)：默认 handler 与 service 使用本地真实 HTTP 验证 JSON/SSE、413、发送前取消，以及发送后取消信号时的完整读取和用量记录。
- Responses 本地 HTTP 验证通过 `traceIdMiddleware` 建立请求上下文，检查根 Session 在上游请求头、413 重试和用量记录中的一致性；会话优先级测试使用具备 Responses 能力的模型。
- 用量页面的模型与 Session 明细同时保留 `Copilot AIU Cost` 和通用 `Total Cost`；只有 AIU 的历史记录继续显示 AIU 费用，名称与费用提示内容经过 HTML 转义。
- [auto-session-chains.test.ts](../tests/auto-session-chains.test.ts)：三个公开 service 的折扣会话注入链路。
- [auto-session-retry.test.ts](../tests/auto-session-retry.test.ts)：Fusion→Auto→原价每链最多三次业务发送、刷新失败不阻断原价、`belong` 交回兼容路径，以及 413 重新进入的独立计数。
- [auto-session-discovery.test.ts](../tests/auto-session-discovery.test.ts)、[auto-session.test.ts](../tests/auto-session.test.ts)：双来源启动探测、升级、退避分类、逐候选到期刷新、凭据轮换、预算与冷却，以及 `forceAgent` 无关性。
- [auto-session-logs.test.ts](../tests/auto-session-logs.test.ts)：info 安全字段与日志隐私。
- [get-fusion-selection.test.ts](../tests/get-fusion-selection.test.ts)：Fusion 网络边界的 solo、单步、token、expiry 与端点校验。
- [auto-session-websocket-local.test.ts](../tests/auto-session-websocket-local.test.ts)：本机真实 WebSocket 握手头验证不附会话 token；[create-responses-websocket-pool.test.ts](../tests/create-responses-websocket-pool.test.ts)：Responses WebSocket 池化行为。
- [tls-retry.test.ts](../tests/tls-retry.test.ts)。
- [start-auto-session-prewarm.test.ts](../tests/start-auto-session-prewarm.test.ts)、[token-metadata.test.ts](../tests/token-metadata.test.ts)、[token-metadata-apply.test.ts](../tests/token-metadata-apply.test.ts)。
- [start-mode.test.ts](../tests/start-mode.test.ts)：GitHub 凭据来源优先级、provider-only 启动、交互配置完成后的启动与无可用 provider 时拒绝开放服务。

## 2. Native Messages 兼容

**使用场景**：通过 Copilot 原生 Messages API 发送 thinking、工具调用、图像及 adaptive thinking 请求。

**必须保留的行为**：

- 识别直接图像和 `tool_result` 中的图像，保留 vision header。
- 根据模型 capability 启用 adaptive thinking；强制工具选择时保持既有禁用条件。
- 仅模型 capability 支持 `adaptive_thinking` 且 `tool_choice` 不是 `any`/`tool` 时写入 effort：请求显式 `output_config.effort` 优先，缺省用 `getReasoningEffortForModel` 的配置默认值，再按模型 `reasoning_effort` 能力收敛。
- 保留 beta 过滤、`top_p` 移除和 `temperature=1`。
- 调整 assistant 的 text/tool_use 顺序时，保持 thinking 与 redacted_thinking 的原位置。
- 仅匹配已有 `400` effort 或 thinking 错误时执行对应的单次兼容重试；首次请求保留完整 thinking 内容。
- 保留模型专属 header 条件、请求标识、错误响应以及 Telemetry 的调用顺序。
- 完整 Claude metadata 的 Messages proxy 使用 GitHub token、客户端 API version 和每次请求的新 request ID；该 ID 同时用于 Telemetry。图像标记、请求来源、interaction/compact 信息与匹配的 Auto session token 在身份准备后保留。
- 最后一条 user 消息包含非 `tool_result` 内容时，默认请求来源为 `user`；工具结果与 assistant 续写默认为 `agent`，显式选项及 smart-agent 规则继续生效。

**本地实现**：[messages-compat.ts](../src/services/copilot/messages-compat.ts) 承载 headers、payload 准备与协议错误重试。

**必要的上游接入**：[create-messages.ts](../src/services/copilot/create-messages.ts) 调用本地准备与发送函数，保留公开 API、请求组织和结果处理。

**验证入口**：

- [create-messages.test.ts](../tests/create-messages.test.ts)：公开 service 行为。
- [messages-compat.test.ts](../tests/messages-compat.test.ts)：纯数据变换与本地真实 HTTP 重试。
- [create-messages-headers.test.ts](../tests/create-messages-headers.test.ts)：本机真实 HTTP header casing、proxy 认证、API version、图像工具结果及 compact 信息。
- [auto-session-chains.test.ts](../tests/auto-session-chains.test.ts)。

## 3. Chat Completions 兼容

**使用场景**：通过 Copilot Chat Completions API 保留工具、reasoning、流式结果与响应附加信息。

**必须保留的行为**：

- 最后一条消息的角色决定原始 initiator，再按既有 smart-agent 规则处理。
- 首次发送保持请求内容；仅 `400` 且错误内容包含 `signature` 或 `cannot be modified` 时触发兼容重试，匹配不区分大小写。
- 重试只移除 assistant 的 `reasoning_opaque`、`reasoning_text`，保留工具调用与其他消息；不修改原始 payload 对象。
- 成功、失败及重试后的 Telemetry、premium 信息、原始响应 headers、HTTPError 和 JSON/SSE 返回形式保持一致。
- 请求携带 `reasoning_effort` 时原样保留；缺省时共享 Chat service 按 `getReasoningEffortForModel` 的配置默认值补齐并收敛到模型声明的能力，模型显式声明为空的能力列表时不注入。Chat 路由与 Responses→Chat fallback 共用该行为。

**本地实现**：[chat-completions-compat.ts](../src/services/copilot/chat-completions-compat.ts) 承载 reasoning 错误判定、字段移除与单次兼容重试。

**必要的上游接入**：[create-chat-completions.ts](../src/services/copilot/create-chat-completions.ts) 保留请求组织、缺省 `reasoning_effort` 补齐、JSON/SSE 结果解析、Telemetry 和响应附加信息，调用共享发送入口与本地错误处理函数。

**验证入口**：

- [create-chat-completions.test.ts](../tests/create-chat-completions.test.ts)：公开 service 行为与 Telemetry。
- [chat-completions-compat.test.ts](../tests/chat-completions-compat.test.ts)：字段移除范围、工具调用保留和原始请求不变。
- [auto-session-chains.test.ts](../tests/auto-session-chains.test.ts)、[chat-completions-headers.test.ts](../tests/chat-completions-headers.test.ts)。

## 4. Responses HTTP replay 兼容

**使用场景**：历史 Responses reasoning item 绑定其他连接，Copilot 拒绝当前请求。

**必须保留的行为**：

- 身份与模型尚未学习到对应失败时，首次发送保留 `reasoning.encrypted_content`。
- 同时满足 `4xx`、`error.message` 为字符串且不区分大小写包含 `belong`、请求存在 `reasoning.encrypted_content` 时，才按既有逻辑处理输入并重试一次；大小写处理与 `responses-compat.ts` 现有实现一致。
- 仅按 `error.message` 判断；其他错误字段、服务端错误和没有可处理 reasoning 的输入保持原错误路径。
- 同一身份与模型已学习到 `belong` 失败时，后续首发前先按既有输入规范化移除 `reasoning.encrypted_content`，保留 reasoning 的 `id`、`type` 与 `summary`。
- 学习只发生在实际返回含 `belong` 的 `4xx` 且请求存在 `encrypted_content` 的 HTTP 请求；进程内最多保存 1024 条记录，按明确身份、模型、上游 URL、`Authorization` 的 SHA-256 摘要及 `Copilot-Session-Token` 的 SHA-256 摘要隔离。令牌在 HTTP 重试中更新时，学习记录归属返回该错误的最终请求凭据。超出时按首次插入顺序淘汰最早条目，并发重复学习保持原顺序；没有明确 session 身份不学习。
- 身份按 `x-session-id`、`x-claude-code-session-id`、`session-id`、`session_id`，再显式 `prompt_cache_key`，再 `x-root-session-id`、`x-opencode-session-id`、`x-session-affinity`、`x-client-request-id`、`thread-id` 取首个 trim 后非空值；agent 取 `x-oc-agent`，缺省记为 `_`。不使用 fallback session ID、机器 ID 或请求文本哈希。
- WebSocket 分支不应用学习缓存。
- 保留 payload 原地更新、两次请求各自的 rate-limit 记录、响应 headers 和用量处理。
- WebSocket 分支、连接池、取消与终态处理继续使用上游实现。

**本地实现**：[responses-compat.ts](../src/services/copilot/responses-compat.ts) 的 `sendResponsesRequestWithReasoningReplay` 承载学习缓存与重试；[reasoning-replay.ts](../src/lib/reasoning-replay.ts) 的 `getReasoningReplayIdentity` 提供身份。

**必要的上游接入**：[create-responses.ts](../src/services/copilot/create-responses.ts) 的 HTTP 发送位置调用兼容函数；JSON/SSE 结果处理保留在原入口。

**验证入口**：

- [create-responses.test.ts](../tests/create-responses.test.ts)：公开 service 的 replay、headers 和用量行为。
- [responses-compat.test.ts](../tests/responses-compat.test.ts)：错误字段与状态边界、本地真实 HTTP 重试。
- [create-responses-websocket-pool.test.ts](../tests/create-responses-websocket-pool.test.ts)。
- [reasoning-replay.test.ts](../tests/reasoning-replay.test.ts)：身份优先级、空白值跳过、agent 分组与无身份返回。

## 5. Responses → Chat fallback

**使用场景**：Responses 路由按现有 endpoint 判定，选择 Chat Completions 处理请求。

**必须保留的行为**：请求、工具调用、响应事件和流式结果按既有规则转换；保持 output item 生命周期与递增的 `sequence_number`。Native Responses 请求在 `prepareNativeResponsesRequest` 中按请求显式 `reasoning.effort` 优先、缺省用 `getReasoningEffortForModel` 的配置默认值补齐 effort。

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
- [token-lifecycle.test.ts](../tests/token-lifecycle.test.ts)：直接验证凭据装载、账户选择、后台刷新成功与失败、禁用状态、登录错误及凭据持久化，使用临时目录隔离用户数据。

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

**行为**：请求入口记录原始模型、目标模型、实际发送的 effort 与来源；模型明确不支持配置 effort 时记录 `unsupported (config)`。Messages 路由使用自己的 IN/OUT 日志。流式响应每收到一个 chunk 在同一行覆盖输出 `\x1b[2K\r↪ <model> <N>` 进度；上游正常完成且客户端连接有效时追加 `✓` 并换行，`failed`/`incomplete` 终态、抛错或提前取消只结束进度行。Chat 非流式响应记录 `0 ✓`。Chat、Messages 与 Responses 路由共用该格式，premium 信息只读取当前响应附带的数据，缺少数据时省略配额标记。JSON/SSE 内容、`[DONE]`、响应 headers、用量记录和清理路径保持原有行为。协议转换和 provider 转发保留 thinking block、thinking config 的移除数量与原因记录。

stdout 同步写入失败时省略该条进度日志，继续原有响应与流关闭流程。

Responses 的 Chat fallback 持续发送内容与工具调用事件，整体 `response.completed` 或 `response.incomplete` 在上游流结束时发送。上游流内错误及传输异常生成 `response.failed`，保留错误前输出和已收集用量；错误后的上游内容不继续发送。Chat 与 Messages 的成功日志同时检查请求取消信号，取消后仍执行原有用量记录与流关闭流程。

**源码与接入**：[logger.ts](../src/lib/logger.ts)、[server.ts](../src/server.ts)、[Messages handler](../src/routes/messages/handler.ts)、[preprocess.ts](../src/routes/messages/preprocess.ts)、[non-stream-translation.ts](../src/routes/messages/non-stream-translation.ts)、[Responses request translation](../src/routes/messages/responses-translation/request.ts)、[provider Messages handler](../src/routes/provider/messages/handler.ts) 与 [provider Messages local-behavior.ts](../src/routes/provider/messages/local-behavior.ts)。

**验证入口**：[logger.test.ts](../tests/logger.test.ts)、[logger-local.test.ts](../tests/logger-local.test.ts)、[models-log.test.ts](../tests/models-log.test.ts) 与 [translation-drop-observation.test.ts](../tests/translation-drop-observation.test.ts)。测试调用实际 handler/service，仅隔离上游；日志断言同时覆盖 chunk 进度行、正常完成行与失败/取消不写 `✓`，不能只断言最终日志。本地日志观察使用实际转换结果，转换算法继续由原模块负责。

## 12. Responses reasoning replay 防护与 effort 映射

**行为**：Messages 转 Responses 时，只重放具有有效 signature 且 reasoning ID 长度不超过 64 的 thinking 内容；缺失 signature 或超过长度限制的内容按原规则处理并保留诊断。assistant phase 在模型配置含 `## Intermediary updates` extra prompt 或为 Grok 模型时设置；请求显式指定的 effort 优先，缺省用 `getReasoningEffortForModel` 的配置默认值，`max` 映射为 `xhigh`。Grok 使用 `concise` reasoning summary，并保留文本、图像、工具调用与 phase（commentary/final_answer）。

**源码与接入**：[Responses request translation](../src/routes/messages/responses-translation/request.ts) 的 `createReasoningContent`、`shouldApplyPhase` 与 effort 映射。

**验证入口**：[responses-translation.test.ts](../tests/responses-translation.test.ts) 覆盖 reasoning ID 的 64/65 字符边界、phase 配置条件、显式 effort、Grok 内容保留、compaction 的双向回放与工具参数边界；[reasoning-effort-local.test.ts](../tests/reasoning-effort-local.test.ts) 覆盖本地 effort 映射与日志值解析；[reasoning-effort.test.ts](../tests/reasoning-effort.test.ts) 保留上游 effort 归一化用例。

## 13. prompt-cache 的 thinking 保护

**行为**：Responses 转 Messages 写入 ephemeral cache breakpoint 时，跳过 thinking 与 redacted thinking 尾部内容；Messages 预处理读取和写入 cache control 时继续跳过 redacted thinking。已有类型定义保留 `redacted_thinking`。

**源码与接入**：[Messages request translation](../src/routes/responses/messages-translation/to-messages.ts)、[preprocess.ts](../src/routes/messages/preprocess.ts) 与 [anthropic.ts](../src/lib/types/anthropic.ts)。

**验证范围**：功能清单调查未找到独立覆盖所有缓存保护条件的测试；保留现有请求翻译和缓存测试。

## 14. `copilot_usage` 贯穿请求与响应转换

**行为**：Chat、Responses 与 Messages 转换保留 `copilot_usage`。流式转换累计最新用量，在对应的完成事件或 `message_delta` 中传递；Messages 流开始事件通过 `mergeUsage` 合并已有用量。web-search 合成事件和用量记录器继续携带 Copilot 用量。

**源码与接入**：[Messages 转换目录](../src/routes/messages/)、[messages-stream-translation.ts](../src/routes/responses/messages-stream-translation.ts)、[web-search fulfill](../src/routes/messages/web-search/fulfill.ts)、[api-flows.ts](../src/routes/messages/api-flows.ts) 与 [Messages local-behavior.ts](../src/routes/messages/local-behavior.ts)。

**验证入口**：[web-search-fulfill.test.ts](../tests/web-search-fulfill.test.ts)、[responses-stream-collection.test.ts](../tests/responses-stream-collection.test.ts) 与 [anthropic-response.test.ts](../tests/anthropic-response.test.ts)。

## 15. 模型目录信息与排序

**行为**：`GET /v1/models` 提供 premium、倍率、可用账号、模型限制、family、endpoints、工具调用、并行工具调用、流式与结构化输出能力等字段。排序依次考虑模型种类、premium、最大 prompt 和 context window；必要时使用已有的模型缓存加载路径。

**源码与接入**：[models route](../src/routes/models/route.ts) 按客户端调用共享发现模块；[model-discovery.ts](../src/routes/models/model-discovery.ts) 负责 `buildLimits`、`sortModels` 与模型缓存调用，[default-models.ts](../src/routes/models/default-models.ts) 保留普通客户端排序；Claude Code、Codex 与 OpenCode 使用各自的模型展示格式。[models.ts](../src/lib/types/models.ts) 保留 billing 类型。

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

## 19. Copilot Gemini 的 Chat 上游缓存标记

**行为**：Gemini 模型经 `createChatCompletions` 发往 Copilot `/chat/completions` 时自动添加消息缓存标记，覆盖 Chat Completions 入口、Messages 的 Chat fallback 和 Responses 的 Chat fallback。service 按 `payload.model` 在 `state.models` 中精确查找模型，仅在模型 metadata 的 `capabilities.family` 匹配 `/^gemini(?:-|$)/iu` 时调用共享 helper。metadata 缺失时，service 不添加标记。

共享 helper 选择前两条 content 非空的 system 消息和最后一条 content 非空的非 system 消息，为选中的消息写入 `copilot_cache_control: { type: "ephemeral" }`。已有 `copilot_cache_control` 保持原值，重复调用不会增加或改变标记。消息 content 和工具定义不变。

Messages 的 Chat fallback 仍在 route 层无条件调用共享 helper，非 Gemini 模型保持该入口的现有标记行为。这套 Gemini metadata 判定只作用于 Copilot Chat 上游，不影响其他 provider。标记不保证缓存命中、配额降低或费用节省。

**源码与接入**：[context-cache.ts](../src/services/copilot/context-cache.ts) 的 `applyCopilotContextCache` 负责选择与写入；[create-chat-completions.ts](../src/services/copilot/create-chat-completions.ts) 在发送前按模型 metadata 调用；[Messages api-flows.ts](../src/routes/messages/api-flows.ts) 保留 route 层调用。三个入口分别经过 [Chat handler](../src/routes/chat-completions/handler.ts)、Messages api-flows.ts 和 [Responses chat-handler.ts](../src/routes/responses/chat-handler.ts)。

**验证入口**：[copilot-context-cache.test.ts](../tests/copilot-context-cache.test.ts) 覆盖消息选择与已有标记保留；[copilot-context-cache-local-http.test.ts](../tests/copilot-context-cache-local-http.test.ts) 覆盖三个实际 handler 到本地 HTTP 的标记行为。
