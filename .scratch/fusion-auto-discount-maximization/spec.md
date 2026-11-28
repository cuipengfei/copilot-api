# Copilot Fusion 与 Auto 折扣覆盖最大化规格

Status: ready-for-human

## Problem Statement

在保持客户端请求的模型 ID 与传输协议不变的前提下，代理需要尽可能为目标模型取得并保持 30% 的 Copilot Fusion 折扣凭据；当某个目标模型暂时没有 30% 凭据时，尽可能使用 10% 的 Auto 折扣凭据；只有当 30% 和 10% 都尚未取得或均被上游拒收时，才按原价发送。

经过真实后端探测与源码核查，当前实现还有五处尚未把 30% 和 10% 折扣机会用足：

1. **Fusion 后台每轮补刷上限被写死为 10 次**：`FUSION_TARGET_ATTEMPTS = 10` 小于当前候选条件池大小，一轮补刷还没把未尝试的候选条件试完就会提前耗尽并进入 90 秒冷却期，拖慢缺失模型的 30% 恢复。
2. **运行时探测池缺少跨文件真实源码题，且动态 100 行源码抽样题没有喂给 Fusion**：4 道完整跨文件源码任务题（`task-correctness`、`task-behavior`、`task-cancellation`、`task-concurrency`）只存在于测试脚本中；运行时启动预热抽取的 100 行真实源码题也只发给了 Auto，没有在运行时动态喂给 Fusion。
3. **Fusion Standard（`POST /auto` 传 `fusion: true`）尚未接入运行时**：实测确认向 `POST /auto` 发送 `fusion: true`（在支持的 `balance`、`intelligence`、`fast` 三个档位下）返回的 `session_token` 在生成账单上同样享受真金白银的 30% 折扣（四项 token 单价全部为原价的 70%），且能选出 `gpt-6-astra`、`gpt-6-luna`、`gpt-6.1-terra` 等单模型；但运行时目前只用 `POST /model/fusion` 获取 30% 凭据。
4. **`hydrafusion-max` 的 `plan_version: "1"` 尚未作为补充条件纳入**：在当前 business 账户上，虽然 `/meta` 将 `hydrafusion-max` 标为 `model_pool_not_eligible` 且 `plan_version: "2"` 返回 `HTTP 403`，但 `plan_version: "1"` 实测稳定返回 `HTTP 200`（如选中 `gpt-6.1-terra`）且生成账单实测同样为 30% 折扣。
5. **三处二层兼容重发路径绕过了折扣降级链**：当 `/responses` 因 `belong` 报错剥离 `reasoning.encrypted_content` 重发，或 `/v1/messages` 因 `invalid_reasoning_effort` / `thinking` 块签名报错调整请求体重发时，调用的是裸 HTTP 发送函数而非带会话令牌降级重试的入口；若在这一次重发时恰好遇到会话令牌过期或被拒，请求不会自动降级到 10% 或原价，而是直接失败。

## Solution

1. **动态计算每轮补刷上限**：移除写死的 `FUSION_TARGET_ATTEMPTS = 10`，让后台定向补刷（`discoverSourceTargets`）按当前轮次构建出的去重候选条件实际数量动态跑满整轮；只要中途所有缺失目标模型已拿齐就立即停手，整轮候选全部试完仍有缺失才进入 90 秒冷却。
2. **运行时共享 4 道跨文件真实源码题 + 动态 100 行源码抽样题**：
   - 将 4 道跨文件真实源码任务题纳入运行时共享条件生成逻辑（部署环境缺少源码文件（ENOENT）时记录日志并跳过，不影响静态条件；其他读取错误直接报告），供 Auto 与 Fusion 在启动和后台补刷时共同使用。
   - 在启动预热和后台补刷轮次中，每次动态从仓库 `src/` 抽样连续 100 行 TypeScript 源码拼接 `HARD_QUESTION`，不仅生成 Auto 的探测请求，也同步生成 Fusion 的探测请求。
3. **接入 Fusion Standard（`POST /auto` + `fusion: true`）与 `hydrafusion-max`（`plan_version: "1"`）扩大折扣来源**：
   - 支持向 `POST /auto` 发送 `{ prompt, tier, has_image: false, fusion: true, hydra_rl_multi_turn: {} }`（限定在后台支持的 `balance`、`intelligence`、`fast` 三档；本次 `efficiency` 携带 `fusion: true` 的请求返回 400，继续只用于普通 10% Auto）。
   - 凭据归属以同一账户、同一选模通路已核实的计费结果为准：实测 30% 登记到模型的 `fusion` 槽位，实测 10% 登记到 `auto` 槽位。本次核实的 Fusion Standard 使用 30% 归属；若未来某账户实测为 10%，仍保留该通路取得的凭据，补充该账户的 10% 模型覆盖。
   - 将 `fusion_mode: "hydrafusion-max"` + `plan_version: "1"` 作为可选补充条件纳入 Fusion 候选池；当某个条件返回 `403` 时，仅跳过该不可用条件，不把整个 `fusion` 来源永久锁死，避免 `hydrafusion-max` 的 `403` 误伤正常的 `hydrafusion` 探测。
4. **将三处二层兼容重发统一接入 `sendCopilotRequest`**：把 `/responses` 的 `belong` 剥离重发、以及 `/v1/messages` 的 `invalid_reasoning_effort` 和 `thinking` 块剥离重发全部改为调用 `sendCopilotRequest`，确保兼容重发遇到会话令牌被拒时同样按 `30% → 10% → 0%` 降级重发。

## User Stories

1. 作为 API 使用者，我希望当某个目标模型在启动预热后还没拿到 30% 凭据时，后台第一轮补刷能把当前所有可用的 Fusion 候选条件试完，以便不用试到第 10 个就白白等待 90 秒。
2. 作为 API 使用者，我希望随着题目数量或历史成功记录增减，每轮补刷的尝试上限自动跟着候选池大小变化，以便以后加减题目时不需要手动改常量。
3. 作为 API 使用者，我希望只要所有缺失的目标模型已经拿到对应凭据，当前补刷轮次就立刻停手，以便不发送多余的探测请求。
4. 作为 API 使用者，我希望运行时内置 4 道读取仓库真实源码文件的跨文件分析题，以便在上游偏爱长上下文代码题时也能稳定刷出 `gpt-6.1-sol`、`gpt-6-astra` 等模型。
5. 作为 API 使用者，我希望每次启动和补刷时继续动态随机抽取 100 行真实源码拼成难题，并同时喂给 Auto 和 Fusion，以便题面保持动态变化、应对上游选模策略调整。
6. 作为 API 使用者，我希望代理在 `POST /model/fusion` 之外也能通过 `POST /auto` 带 `fusion: true`（`balance`、`intelligence`、`fast` 三档）获取折扣凭据，并按同一账户、同一选模通路已核实的计费结果归属：本次实测 30% 登记 `fusion` 槽位；若未来某账户实测 10%，登记 `auto` 槽位，以便新增通路可以补充对应折扣的模型覆盖。
7. 作为 API 使用者，我希望普通 Auto 保留 `efficiency` 档位，而 Fusion Standard 条件只使用已成功选模的 `balance`、`intelligence`、`fast` 三档，以便遵守已观察到的请求边界。
8. 作为 API 使用者，我希望 `hydrafusion-max` 的 `plan_version: "1"` 能作为补充探测条件参与选模，同时当任何 `hydrafusion-max` 请求返回 `403` 时只停止 `hydrafusion-max` 自身而不中断 `hydrafusion`（High）或 Fusion Standard 的探测，以便取得当前账户可用的 Max v1 30% 凭据，并继续通过 High 与 Standard 获取其他模型的配对。
9. 作为 API 使用者，我希望当请求触发 `/responses` 的 `belong` 思考块剥离重发，或触发 `/v1/messages` 的推理档位降级 / 思考块剥离重发时，若上游在重发时拒收会话令牌，请求仍能自动按 `30% → 10% → 0%` 降级重发，以便不会因为边缘时序报错中断业务请求。
10. 作为维护者，我希望 `probe-history` 的条件 schema 能兼容新增的 Fusion Standard 条件与 `hydrafusion-max` 条件，以便历史成功条件可以正常写入并在重启后重放。

## Implementation Decisions

- **验证切面（Testing Seams）**：
  - 切面 1（会话发现与调度层）：通过 `prewarmAutoSession`、`getAutoSessionForModel` 与 `openProbeHistory` 观察启动预热、动态源码题注入、Fusion Standard / High / Max v1 条件构造、动态补刷预算、条件级 403 隔离以及 `30% > 10% > 0%` 选择结果。
  - 切面 2（HTTP 发送与兼容重发层）：通过 `sendResponsesRequestWithReasoningReplay` 与 `sendWithSignatureRetry` 观察兼容重发时的 `Copilot-Session-Token` 降级重发行为。
- **探测条件模型扩展**：
  - `ProbeCondition` 扩展支持 Fusion Standard（走 `/auto` 且 `fusion: true`，限定 `tier` 为 `"balance" | "intelligence" | "fast"`）以及 `/model/fusion` 的 `fusionMode: "hydrafusion" | "hydrafusion-max"`。
  - `auto-probe-history` 的 zod schema 同步支持新的条件形态，保持对已有 `conditions.json` 与 `runs/*.jsonl` 的向后兼容。
- **折扣归属**：
  - 按同一账户、同一选模通路已核实的计费结果确定归属：30% 使用 `fusion` 槽位，10% 使用 `auto` 槽位。本次已核实的新增通路使用 30% 归属；后续账户的归属调整须有同一 `token_type` 的 `cost_per_batch / batch_size` 对照证据，不能仅凭选模 HTTP 状态或接口名称调整。
- **跨文件源码题与动态抽样题共享**：
  - 将 4 道跨文件任务题的读取与拼接逻辑提取到运行时模块，默认读取当前仓库的 `src/lib/auth/request-auth.ts`、`src/server.ts`、`src/lib/config/index.ts` 与 `tests/request-auth.test.ts`；当运行环境缺少源码文件时返回空列表并记录 warn，不中断服务启动。
  - 测试脚本 `.agents/skills/copilot-backend-tester/scripts/auto-variety-prompts.mjs` 复用同一套题目构造逻辑，消除脚本与运行时的题目分叉。
- **单轮补刷动态预算与 403 粒度隔离**：
  - Fusion 补刷轮次的请求上限由当前轮次去重后的候选条件数决定（不再使用固定 10 次上限）；相邻请求仍保持 3 秒间隔，一旦 `getMissingSourceModels` 为空立即返回。
  - 当 `hydrafusion-max` 返回 `403` 或 `model_pool_not_eligible` 时，仅标记 `hydrafusion-max` 在当前 Copilot token 下不可用，不得设置整个 `fusion` 来源的 `haltActive` / `unavailable`，确保 `hydrafusion` 和 Fusion Standard 继续正常工作。
- **兼容重发接入折扣降级链**：
  - `sendResponsesRequestWithReasoningReplay` 在剥离 `reasoning.encrypted_content` 后的重发改用 `sendCopilotRequest`。
  - `sendWithSignatureRetry` 在降级 `output_config.effort` 或剥离 `thinking` 块后的重发改用 `sendCopilotRequest`。

## Testing Decisions

- **好测试的标准**：只断言外部可观察行为（发往上游的 URL、请求体字段、携带或移除的 `Copilot-Session-Token` 头、返回的模型配对与折扣等级、冷却与停止时机），不绑死内部私有变量名。
- Responses 兼容恢复测试须覆盖有效的 Fusion → Auto 或无令牌路径；原生 Messages 测试须覆盖其有效的 Auto → 无令牌路径，不得通过模型目录数据扩展 Fusion 对 `/responses` 端点的支持。
- **受测模块与既有测试参考**：
  - `src/lib/auto-probe-prompts.ts` 与 `src/lib/auto-probe-history.ts`：参照 `tests/auto-probe-conditions.test.ts`、`tests/auto-probe-history.test.ts`。
  - `src/lib/auto-session.ts`：参照 `tests/auto-session-chains.test.ts`、`tests/auto-session-miss-guards.test.ts`。
  - `src/services/copilot/responses-compat.ts` 与 `src/services/copilot/messages-compat.ts`：参照 `tests/responses-compat.test.ts`、`tests/messages-compat.test.ts`、`tests/auto-session-retry.test.ts`。

## Out of Scope

- WebSocket 传输的会话令牌支持。
- `/v1/chat/completions` 路由向 `/responses` 的跨协议转译。
- 修改客户端指定的模型 ID 或改变现有的 2 秒前台等待上限（`TARGET_MISS_WAIT_MS`）与 90 秒轮次冷却时长（`TARGET_DISCOVERY_COOLDOWN_MS`）。

## Further Notes

- 2026-11-28 真实 business 账户实测确认：
  - `POST /auto` 传 `fusion: true` 在 `balance`、`intelligence`、`fast` 三档均返回 `HTTP 200`，且生成账单的四项 `token_type`（`input`、`cache_read`、`cache_write`、`output`）单价全部精确为原价的 70%（30% 折扣）；本次 `efficiency` 携带 `fusion: true` 的选模请求返回 `HTTP 400`。
  - `POST /model/fusion` 传 `fusion_mode: "hydrafusion-max"` 时，`plan_version: "2"` 返回 `HTTP 403`（`Fusion Max requires access to all required models`），但 `plan_version: "1"` 稳定返回 `HTTP 200`（`solo` `gpt-6.1-terra`），且生成账单实测同样为精确的 30% 折扣。
