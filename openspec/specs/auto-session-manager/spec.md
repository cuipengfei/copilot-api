# auto-session-manager Specification

## Purpose
在保持请求模型 ID 与传输选择不变的前提下，服务通过上游 `/auto` 与 `/model/fusion` 端点分别发现模型与会话令牌配对：有效 Fusion 配对预期 30% 折扣，有效 Auto 配对预期 10% 折扣。请求优先使用 Fusion，其次 Auto，都不可用时按原价发送；未命中的请求保持原有行为。CLI `-F` 在 `runServer` 初始化时赋值 `state.forceAgent`；折扣查表与该标志无关。

## Requirements

### Requirement: 启动时通过 /auto 与 /model/fusion 探测模型与会话配对
系统 MUST 在启动阶段并行运行 Auto 四个档位（efficiency、balance、intelligence、fast）各两种题目共 8 个探测点与 Fusion 四个固定题面，互不阻断。Auto 简单题 MUST 为 `hello`，难题 MUST 为从当前仓库运行时代码中随机选取的连续 100 行 TypeScript 片段附加固定问题，`intelligence` 使用固定真实源码样本与统一题面变体；Fusion 固定题面 MUST 为 `hello`、CSS Flexbox 题、`TARGET_CODE_PROMPT` 与 `getIntelligenceProbePrompt()`。同一探测点任意时刻只有一个在途请求；全部启动探测共享 30 秒等待上限（`STARTUP_PROBE_BUDGET_MS`），预算到期后未完成的 Auto 探测点在服务接收请求期间于后台继续补采，Auto 原有启动重试上限保持不变。Fusion 四个固定种子各自在每次身份下最多发送一次请求，种子失败不在该种子内重试，也不阻止后续共享轮次继续。

#### Scenario: 双来源探测点互不阻断地完成尝试
- **WHEN** 服务启动同时发起 Auto 8 个与 Fusion 4 个探测点
- **THEN** 每个点独立完成尝试，某来源失败不阻止另一来源或同来源其他点继续
- **AND** 同一来源的同一探测点已有在途请求时复用该请求，不另起并发
- **AND** Fusion 四个种子在每次身份下各自最多发送一次请求，失败不在该种子内重试

#### Scenario: 已有 Auto 配对的模型继续尝试 Fusion 升级
- **WHEN** 某配置目标在启动时已取得有效 Auto 配对
- **THEN** Fusion 固定题面与后续补充探测仍会尝试该模型
- **AND** 系统不因合并后的覆盖列表未变化而停止 Fusion 尝试

#### Scenario: 启动等待有上限且成功配对立即可用
- **WHEN** 上游持续故障导致探测未在预算内全部完成
- **THEN** 30 秒预算到期后服务正常启动，日志快照报告剩余未完成数量
- **AND** 已成功的配对立即可被后续请求命中，未完成的 Auto 探测点在后台继续补采，Fusion 种子在单次尝试结束后不再重试

#### Scenario: 同档难题与简单题选中同一模型时重采一次
- **WHEN** Auto 同一档位的难题与简单题返回相同模型 ID
- **THEN** 系统重新取样一次并再探测一次，随后接受上游实际返回
- **AND** 系统不保证难题必得不同或更强模型，仅按实际结果登记

### Requirement: 按来源分别维护模型配对并按实际响应登记
系统 MUST 以每次响应的实际模型 ID 为键，分别保存 Fusion 与 Auto 两份候选；每个候选记录 `session_token`、上游 `expires_at`、适用端点、取得时的 Copilot 凭据标识、成功探测来源与预期折扣。模型 ID、token、到期时间或端点非法，以及 Fusion 不是 `fusion_pattern === "solo"` 或步骤数不为 1 的响应 MUST NOT 进入候选表。选择时 MUST 同时校验最终上游模型、凭据身份、有效期与端点：有效 Fusion 始终优先于 Auto，两者都不可用时返回无 token。Fusion 候选的适用端点固定为已验证的 `/responses`，模型目录 MUST NOT 扩大该集合；目录缺少该模型或端点时不发送未知配对。

配置目标没有任何有效候选且补采正在进行时，系统 MUST 共享在途补采最多等待 2 秒，随后按原价发送；非配置目标 MUST NOT 等待补采。

#### Scenario: 有效 Fusion 优先，迟到的 Auto 不覆盖
- **WHEN** 同一模型同时存在有效 Fusion 与 Auto 候选，或 Auto 响应在 Fusion 之后到达
- **THEN** 请求使用 Fusion token，预期折扣为 30%
- **AND** 较晚的 Auto 响应保留为备选，不替换 Fusion 候选

#### Scenario: 已有 Auto 时立即使用且 Fusion 续期不阻塞
- **WHEN** 请求模型只有有效 Auto 候选，而 Fusion 正在取得或续期
- **THEN** 该请求立即使用 Auto token，不等待 30%
- **AND** 新的有效 Fusion 登记后，下一请求无需重启即优先使用 30%

#### Scenario: 无配对时按原价发送
- **WHEN** 请求模型没有任何有效候选
- **THEN** 系统不构造 0% token，也不更换用户模型，直接按原价发送

#### Scenario: 无候选的配置目标最多等待 2 秒共享补采
- **WHEN** 请求模型属于 `autoDiscovery.models` 配置目标、当前没有任何有效候选，且补采正在进行
- **THEN** 请求共享在途补采并最多等待 2 秒，补采登记该模型候选时立即使用
- **AND** 等待到期或凭据身份变化后按原价发送，后台补采继续
- **AND** 非配置目标不等待补采

#### Scenario: 端点不符不发送未知配对
- **WHEN** 候选仍在有效期内但请求端点不在其适用端点内，或 Fusion 候选用于非 `/responses` 端点
- **THEN** 系统不附加该 token，请求按原价发送

### Requirement: 各来源独立处理探测失败
系统 MUST 按状态类别处理每个来源的探测失败：429 优先遵守 `Retry-After`（缺失、空串或非法时回退随机退避）；网络失败与上游 5xx 按 1 秒起步、30 秒封顶的随机退避安排后续尝试，Fusion 的有界探测在单次请求结束后 MUST 保留该退避截止时间，后续 Fusion 请求不得早于截止时间发送，Fusion 5xx 带有效 `Retry-After` 时 MUST 以该值为准；401 视为身份异常并暂停两个来源的重复探测，403 只暂停当前来源，两者均待凭据变化后恢复；持续的请求格式类 400 记为待处理并报告状态，不反复发送相同请求。Fusion 返回 `model_pool_not_eligible` 或端点不支持时 MUST 只暂停该来源在当前身份下的探测，不得暂停 Auto 补采。

#### Scenario: 429 遵守 Retry-After 而 5xx 与网络失败退避重试
- **WHEN** 任一来源的探测收到 429 且带合法 `Retry-After`
- **THEN** 系统按该头指定时长等待后重试
- **WHEN** 探测收到网络错误或 5xx
- **THEN** 系统按 1 秒起步、30 秒封顶的随机退避安排后续尝试
- **AND** Fusion 5xx 带合法 `Retry-After` 时按该头指定时长等待，且该截止时间在单次有界探测结束后仍约束后续 Fusion 请求

#### Scenario: 鉴权失败按错误类别暂停
- **WHEN** 某来源的探测收到 401 且凭据未变化
- **THEN** 系统暂停两个来源的重复探测，待凭据变化后自动恢复
- **WHEN** 某来源的探测收到 403 且凭据未变化
- **THEN** 系统只暂停该来源在当前凭据下的重复探测，另一来源继续运行

#### Scenario: Fusion 来源限定拒绝不影响 Auto
- **WHEN** Fusion 返回 `model_pool_not_eligible` 或端点不支持
- **THEN** 系统只暂停当前身份下的 Fusion 探测
- **AND** Auto 探测与补采继续运行

### Requirement: 补充探测按来源限制请求预算并共享冷却
系统 MUST 限制补充探测：Auto 定向探测每档最多 10 次请求；Fusion 首轮包含 4 个固定种子，每个种子在每次身份下最多发送一次请求，种子失败不在该种子内重试，也不阻止共享轮次。同一来源同一时刻 MUST 只运行一个轮次，全部目标共享该轮次，不得为每个缺失模型重复整轮；Fusion 续期与重新取得 MUST 进入该共享轮次，保存成功题面的首次尝试与所有失败请求均计入共享轮次每轮最多追加 10 次请求的预算（四个种子不计入该追加预算）；响应返回其他模型时按实际模型 ID 登记，原模型仍缺失时继续尝试 intelligence 题面变体。一轮预算耗尽且仍有缺失目标时，系统 MUST 为该来源记录 90 秒冷却；冷却由该来源全部目标共享，冷却期内除 Copilot 凭据轮换外不重新开始轮次，冷却结束后由后续 miss 重新触发新轮次。同一来源相邻补充请求 MUST 间隔至少 3 秒，429 的 `Retry-After` 等待时长取头部指定值，可长于 3 秒间隔。预算耗尽、冷却与 429 等待 MUST NOT 阻止使用既有候选或按原价发送。

#### Scenario: Auto 每档与 Fusion 每轮受请求上限约束
- **WHEN** 配置目标或已取得 Auto 配对的模型在启动探测后仍缺失并进入补充探测
- **THEN** Auto 定向探测每档最多发送 10 次请求
- **AND** Fusion 四个种子各在每次身份下最多发送一次请求，失败不触发该种子重试
- **AND** Fusion 共享轮次每轮最多追加 10 次请求，保存题面的首次续期与全部失败尝试均计入该预算

#### Scenario: 连续补充请求间隔至少 3 秒
- **WHEN** 某来源连续发送补充探测请求
- **THEN** 相邻请求间隔至少 3 秒

#### Scenario: 轮次耗尽后冷却共享且不按模型重复
- **WHEN** 某来源一轮预算耗尽且仍有缺失目标
- **THEN** 该来源进入 90 秒冷却，所有目标共享，冷却期内除凭据轮换外不重新开始轮次
- **AND** 冷却结束后由后续 miss 重新开启新轮次，系统不为每个缺失模型重复整轮，既有候选使用与原价发送不受影响

### Requirement: 各来源候选独立到期刷新并持续补采
系统 MUST 按每条候选自己的 `expires_at` 在到期前 5 分钟安排刷新；同一来源探测点的并发刷新共享在途任务。刷新定时器超过 `2^31-1ms` 上限时 MUST 在触发时重算重排，不得提前请求。定时器发起的刷新若仍返回已进入 5 分钟窗口的到期时间，MUST NOT 以 0 毫秒间隔连续重排，候选保持到自然过期。Fusion 到期时 MUST 删除过期候选并按保存的成功题面重新取得，即使 Auto 仍有效也不得跳过；该重新取得 MUST 进入补充探测的共享有界轮次，保存题面的首次尝试与失败请求计入十次预算，原模型仍缺失时继续题面变体。Auto 到期时按该来源补采。Copilot 凭据变化时两个来源的旧候选 MUST 立即失效并清除刷新定时器；重新补采 MUST 在凭据轮换的元数据就绪入口（`resumeAutoSessionDiscoveryAfterRotation`）恢复发现身份后发起，种子、在途探测、共享轮次及其结束后的重启均 MUST 通过该门检；旧凭据下在途请求的结果与迟到响应 MUST NOT 写入新身份或覆盖较新候选，恢复与停止 MUST 唤醒等待门检的探测。重新探测选出不同模型时 MUST 按实际模型 ID 登记，不把新 token 写到原模型名下。系统 MUST NOT 设置促销日期截止常量、日期开关或按日期失效缓存；缓存有效期只取服务端返回的 token expiry。

#### Scenario: 到期前五分钟按来源刷新并共享在途
- **WHEN** 某来源的候选到达到期前 5 分钟
- **THEN** 系统按记录的来源点重新探测并用新 `expires_at` 续排
- **AND** 同一探测点已有在途请求时复用该请求

#### Scenario: Fusion 到期且 Auto 有效仍重新取得 30%
- **WHEN** 某模型的 Fusion 候选到达 `expires_at`
- **THEN** 系统删除该候选并启动或加入同来源的 Fusion 重新取得，Auto 候选保持可用
- **AND** 重新取得按保存的成功题面进入共享有界轮次，失败计入十次预算；等待期间请求继续使用有效 Auto，取得后下一请求恢复 Fusion

#### Scenario: 凭据轮换后旧候选失效并按新结果补采
- **WHEN** Copilot 凭据发生变化
- **THEN** 两个来源的旧凭据候选立即失效、刷新定时器清除；在元数据就绪入口恢复发现身份前，种子、在途探测、共享轮次及其结束后的重启均不发送新身份请求
- **AND** 迟到返回的旧凭据响应被丢弃；恢复后补采返回不同模型时按新模型 ID 登记
- **AND** 恢复与停止都会唤醒等待门检的探测，停止后不发送新身份请求

#### Scenario: 公开优惠日期变化不停止取得与刷新
- **WHEN** 当前时间跨过官方公布的优惠日期
- **THEN** 有效 Fusion 候选仍被选择、刷新与补采照常进行
- **AND** 系统不因日期开关或优惠说明字段缺失而停止 Fusion 探测

### Requirement: HTTP 推理按折扣降级链最多三次业务发送
系统 MUST 仅在实际 HTTP 生成分支按最终模型与端点附着所选候选；每次进入共享折扣降级链时最多三次业务发送，依次尝试 Fusion、Auto、无 token，并跳过不存在的候选。系统 MUST 仅在本次发送附加了 token 且上游返回 `400`/`401` 时失效该 token 对应的来源候选并推进到下一来源；`belong` 拒绝属于连接/内容绑定问题，MUST 交回既有兼容路径，不消耗降级机会。同一链 MUST NOT 回头使用已用来源。候选刷新或后台重获失败 MUST NOT 阻止使用另一候选或原价发送，也不得重放已经成功的生成。最终原价生成失败、`429`/`5xx`、取消及流开始后的错误 MUST 按原有路径返回。`413` 图片处理可能重新进入整条生成链，signature、effort 与 `belong` 修正各有既有兼容发送，TLS 重试独立计数；这些发送与三次业务发送分开记录。Responses WebSocket 分支 MUST NOT 附加会话 token，也不得因存在候选而切换传输。

#### Scenario: Fusion 拒绝且已有 Auto 时下一次发送使用 Auto
- **WHEN** 携带 Fusion token 的请求收到非 `belong` 的 `400`/`401`，且该模型存在有效 Auto 候选
- **THEN** 系统仅失效实际发送的 Fusion token，同一请求链的下一次发送携带 Auto token
- **AND** 原模型、输入内容、请求标识关系与取消行为保持不变

#### Scenario: 两来源均拒绝时最后按原价发送一次
- **WHEN** Fusion 与 Auto 先后被非 `belong` 的 `400`/`401` 拒绝
- **THEN** 该链的最后一次发送不携带 token，且不再回到已用来源
- **AND** 每次进入折扣链最多三次业务发送

#### Scenario: 刷新失败不阻断原价发送
- **WHEN** 候选失效后的重新取得失败，或刷新探测异常
- **THEN** 系统不因此终止请求，继续使用另一有效候选或按原价发送
- **AND** 最终生成失败仍按原有错误路径返回

#### Scenario: WebSocket 不附 token 且不切换传输
- **WHEN** 传输选择为 Responses WebSocket，即使该模型存在有效 Fusion 或 Auto 候选
- **THEN** 请求继续使用 WebSocket 且不附加 `Copilot-Session-Token`
- **AND** info 日志记录 `source=none expected_discount=0% reason=websocket`，缓存取得日志仍可报告该模型已有 HTTP 可用候选

#### Scenario: 413 重新进入与兼容重试独立计数
- **WHEN** 图片请求触发 413 处理，或发生 signature、effort、`belong` 兼容重试与 TLS 重试
- **THEN** 各兼容发送按既有规则执行，TLS 重试独立计数
- **AND** 这些发送与每次折扣链的三次业务发送分别记录，不宣称整个客户端请求最多三次网络发送

### Requirement: 折扣日志、覆盖汇总与成本数据约束
系统 MUST 以 `consola.info` 记录候选取得、升级、失效、续期与逐请求选择，字段限于转义后的模型 ID、source（`fusion`/`auto`/`none`）、expected_discount、升级时的 previous_discount、endpoint、未完成数量与固定 reason；MUST NOT 输出 session token、Copilot token、header 对象、题面、源码、原始响应或原始错误消息。有效 Fusion 候选记录预期 30%，有效 Auto 候选记录预期 10%，无 token 记录 0%；这些值只表示所附 token 来源的预期，不声明账单已确认。`discounted_costs` 仅作补充证据，缺失或无法解释时不得把有效 Auto 候选降为 unknown，也不得据该字段推算实际优惠。启动汇总 MUST 保留 `wanted`、`obtained`、`missing` 的现有含义（`obtained` 为当前身份下至少有一个有效候选的模型并集），并增加 `fusion_obtained`、`auto_obtained`、`fusion_missing`、`auto_missing` 展示各来源覆盖；升级等级变化即使合并后的 `obtained` 未变化也 MUST 输出更新。请求计费 MUST 沿用上游返回的实际成本字段，不重复应用折扣。

#### Scenario: 取得与逐请求选择分别记录预期折扣
- **WHEN** 系统登记候选或为请求选择候选
- **THEN** 取得日志报告已登记的模型与来源，逐请求日志报告本次携带 token 的来源与预期折扣
- **AND** 日志不宣称账单已确认，真实费用以上游 `copilot_usage` 为准

#### Scenario: 日志只含允许字段
- **WHEN** 系统记录探测、命中、未命中、升级、失效、续期或 token 拒绝事件
- **THEN** 日志仅包含模型 ID、source、expected_discount、升级时的 previous_discount、endpoint、状态类别与固定 reason
- **AND** 不包含任何令牌、header 对象、题面、源码、session 标识片段或原始错误消息

#### Scenario: 来源覆盖分别展示
- **WHEN** 某模型由 Auto 升级至 Fusion，或过期 Fusion 被移除而 Auto 仍有效
- **THEN** 启动汇总与后续更新分别显示 `fusion_obtained`、`auto_obtained`、`fusion_missing`、`auto_missing`
- **AND** 合并后的 `obtained`、`missing` 含义保持不变

#### Scenario: 成本沿用上游实际数据
- **WHEN** 请求经任一折扣配对路径完成
- **THEN** 成本与用量展示沿用上游响应实际返回的 `copilot_usage` 字段
- **AND** 不再次乘 0.7 或 0.9
