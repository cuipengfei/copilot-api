---
name: copilot-backend-tester
description: "Use when testing GitHub Copilot upstream APIs directly, comparing proxy and upstream responses, checking usage/account endpoints, or investigating Auto/Fusion model selection; trigger on Copilot backend, /auto, /model/fusion, Auto 选模, Fusion 选模, Auto/Fusion 模型多样性, /v1/messages, /chat/completions, /copilot_internal/user, curl Copilot, or real backend usage."
---

# Copilot 后端测试

直接验证 GitHub Copilot 上游行为，先取得可观察证据，再判断代理代码是否需要修改。

## 目标边界

- 区分本地代理、Copilot 上游和 GitHub usage API 三个层次。
- Auto 本次可选模型以同一实例的上游 `POST /auto` 响应为准。
- Fusion 本次选模以同一账户的上游 `POST /model/fusion` 响应为准，与 Auto 结果分开报告。
- 不把 `/v1/models`、本地模型缓存或模型命名规则当作 Auto 结果。
- 不猜模型名、账户类型、版本号、端点或响应字段；从运行进程、仓库源码和本次响应读取。
- 所有报告脱敏：不得打印 GitHub token、Copilot token、session token 或完整 Authorization header。

## 同类任务的最快路径：Auto 与 Fusion 多样性探测

用户问“现在有哪些 Auto 模型”或“Auto 这次能选到什么”时，运行 Auto `--variety`。同时询问 Fusion 时，再运行 Fusion 探测。两个脚本分别认证和报告，不把两个来源的模型合并成一个名单。

1. **盘点运行实例**

   ```bash
   ss -tlnp
   ps -eo pid,args
   ```

   默认选一个当前运行的 `src/main.ts start` 实例。只有用户明确要求多实例时才逐一探测。记录端口、账户参数和 PID。展示进程参数时不得输出 `-g/--github-token` 的值，也不要假定端口一定是 `4141`、`4142` 或 `4146`。

2. **运行共享条件探测**

   ```bash
   bun .agents/skills/copilot-backend-tester/scripts/test-auto-select.mjs \
     --proxy-url http://localhost:<PORT> \
     --variety \
     --budget-ms 600000 \
     --max-requests 128
   ```

   ```bash
   bun .agents/skills/copilot-backend-tester/scripts/test-fusion-select.mjs \
     --proxy-url http://localhost:<PORT> \
     --plan-version both \
     --budget-ms 600000 \
     --max-requests 128
   ```

   账户明确为 business 时加 `--business`。脚本使用 token exchange 返回的上游，不根据 hostname 推断账户类型。

### 条件和请求预算

- `createVarietyCases()` 把 `getProbeConditions()` 的共享固定条件和真实源码条件放进同一个数组。Auto 保留同一题面的四个 tier，因为它们的 `condition.id` 不同。Fusion 按 `condition.id` 去重，并在每个题面下交错执行 `--plan-version` 选择的版本。
- 真实源码条件保持不变。四个 task 题读取 `src/lib/request-auth.ts`、`src/server.ts`、`src/lib/config.ts`、`tests/request-auth.test.ts` 的完整当前内容。四个 hard 题分别采样连续 100 行真实 TypeScript 源码，再追加 `HARD_QUESTION`。脚本不打印这些正文。
- `expected_cases` 是去重后的条件数乘以 `--repeat`，不是已发请求数。`auto_requests`、`fusion_requests` 和 `generation_requests` 分别记录实际请求。token exchange 不计入这些字段。
- `--repeat <n>` 重复当前条件集，默认 `1`。只有这个选项允许同一 `condition.id` 在一轮计划中重复。
- `--interval-ms <n>` 设置条件之间的间隔，默认 `0`。
- `--budget-ms <n>` 设置包含认证、历史读写和生成的总时限，默认 `60000`。
- `--max-requests <n>` 设置选择与生成共用的请求上限，默认 `128`。Fusion 的 v1 和 v2 共用这一上限。带生成时按每个 Auto 条件最多三次请求、每个 Fusion v1 条件 `1 + 2 × step 数量` 次请求、每个 Fusion v2 条件最多三次请求估算预算。选择请求的 `429` 或 `5xx` 重试另计一次。
- 选择请求遇到 `429` 或 `5xx` 时按 `Retry-After` 或一秒退避，最多重试一次。`401` 和 `403` 设置 `identity_halt` 并停止。无效响应、超时、预算耗尽和历史写入错误都产生非零退出，不伪造成功条件。

### 实例历史和精确重放

历史根目录由 `PATHS.PROBE_HISTORY_DIR` 决定。默认是 `$COPILOT_API_HOME/probe-history`。OAuth app 子目录和 enterprise 的 `ent_` 前缀沿用 `src/lib/paths.ts`。每个实例和写者的文件布局如下：

```text
<history-root>/listen-<PORT>/tester-<UUID>/conditions.json
<history-root>/listen-<PORT>/tester-<UUID>/runs/YYYY-MM-DD.jsonl
```

runtime 使用 `runtime` 写者。每次 tester 运行使用新的 `tester-<UUID>` 写者，不覆盖 runtime 或其他 tester 的文件。`--proxy-url` 的端口决定 `listen-<PORT>`，因此重放时必须选择原实例端口。`--history-root <path>` 可显式指定历史根目录。

- `--replay` 重放历史中符合当前 source 和 `--plan-version` 的全部条件。
- `--replay-date YYYY-MM-DD` 只重放该 UTC 日期有观察记录的条件，并把该日期与本次 UTC 日期比较。
- 重放从 `conditions.json` 取得当时的完整 prompt 和全部实际请求参数，再执行新的 token exchange。历史不保存或恢复 Copilot token、session token、Authorization header 或上游完整响应。
- `coverage` 只用本次选择响应计算 `wanted`、`observed`、`missing` 和 `extra`。`wanted` 只读 `getWantedModels()`，脚本不写配置，也不把 extra 追加为目标。历史模型不计入今天的覆盖。
- `date_comparison.conditions[]` 区分 `selected`、`error` 和 `not_observed`。只有两个日期都取得有效选择时才填写 `added`、`removed` 和布尔 `changed`。未执行或出错的条件使用 `changed: null`，不能被解释成模型消失。`recovered_models` 只表示当前 wanted 模型在比较日缺失、在更早日历条件中出现、又在本次同一条件中恢复。

Auto 重放示例：

```bash
bun .agents/skills/copilot-backend-tester/scripts/test-auto-select.mjs \
  --proxy-url http://localhost:<PORT> \
  --replay-date <YYYY-MM-DD> \
  --history-root <HISTORY_ROOT> \
  --budget-ms 600000 \
  --max-requests 64
```

Fusion 重放示例：

```bash
bun .agents/skills/copilot-backend-tester/scripts/test-fusion-select.mjs \
  --proxy-url http://localhost:<PORT> \
  --plan-version both \
  --replay-date <YYYY-MM-DD> \
  --history-root <HISTORY_ROOT> \
  --budget-ms 600000 \
  --max-requests 128
```

### 结果和证据边界

- Auto 每项结果包含完整 `hydra_scores`、`discounted_costs`、模型、endpoint、`condition_id` 和 `prompt_sha256`。`discounted_costs` 是选择响应中的预期信息，不是实测费用。
- Fusion v1 保留完整有序 `steps`，包括重复 role 和重复模型。`models` 包含所有 step 的模型，不能只取 `steps[0]`。Fusion v2 只接受 `solo` 和恰好一个 step。两个版本都输出完整 `hydra_scores`。
- `coverage` 只描述选择观察。`generation_observations` 单独描述生成是否接受和费用证据。历史观察、有效 pairing、生成成功和实测折扣是四种不同事实。
- 报告不输出 prompt、session token 或上游错误正文。选择请求统一使用 `copilotSelectionHeaders(auth, requestId)`，最终 JSON 统一经过 `sanitizeJson`。

单次 Auto 选模仍支持 `--tier <efficiency|balance|intelligence|fast|all>` 和 `--prompt <任意题目>`。`--variety` 与 `--prompt`、`--tier`、`--show-headers` 互斥。`--runtime-seeds` 只用于 Fusion，从共享条件中选择原始四道 seed。

## Fusion 和 Auto 的真实生成对照

只有用户明确授权真实计费时才能加 `--with-inference`。variety 模式下，脚本对每个选中模型发送带 session token 和不带 session token 的两个最小请求。两个请求使用相同模型和固定输入 `Reply with exactly: hi`，输出上限为 64。

- Auto 使用响应中第一个非 WebSocket endpoint。缺失或不支持的 endpoint 会记录为无法验证。
- Fusion 使用 `/responses`。v1 对每个有序 step 分别发送请求，包括重复模型 role；不会执行 cascade 全文，也不会把客户端 model 改成另一个模型。
- `accepted` 只表示对应生成请求被接受。任一生成 HTTP 失败都会使 `complete: false` 并非零退出。带 token 的请求返回 `401` 或 `403` 时设置 `identity_halt`，不发送对照请求或后续条件。其他生成失败在保留对照结果后停止。
- `expected_discount_percent` 是路由预期，Fusion 为 30，Auto 为 10。`measured_discount_percent` 只从本次 `copilot_usage.token_details` 计算。
- 实测逻辑按相同 `token_type` 比较 `cost_per_batch / batch_size`。只有两侧所有 token type 都有有效字段，而且各类型折扣一致时才填写总实测折扣。`total_nano_aiu` 仅列为观察值，不能在 token 数不同或缺少单价字段时直接相除得出折扣。

带生成的重放必须提高 `--max-requests`。例如：

```bash
bun .agents/skills/copilot-backend-tester/scripts/test-fusion-select.mjs \
  --proxy-url http://localhost:<PORT> \
  --plan-version both \
  --replay-date <YYYY-MM-DD> \
  --history-root <HISTORY_ROOT> \
  --with-inference \
  --budget-ms 600000 \
  --max-requests 128
```

## 认证分层

### Copilot 后端

用于 `/auto`、`/model/fusion`、`/v1/messages`、`/responses`、`/chat/completions`：

```text
GET https://api.github.com/copilot_internal/v2/token (GitHub token)
→ Copilot token → Authorization: Bearer <Copilot token>
→ endpoints.api 决定后续 host（business 或 individual）
```

token exchange 返回的 `endpoints.api` 是该 token 的路由权威来源；账户以核实的选定实例启动参数为准，脚本只知道预期值（如 `--business`）时明确标注为 expectation，不由 hostname 推断。不要调用不存在的本地 `/token` 端点，也不要把 GitHub token 直接当作 Copilot token。

脚本的 GitHub token 来源优先级：选定运行进程的 `-g/--github-token` → 执行脚本自身的 `COPILOT_API_GITHUB_TOKEN` 环境变量 → 仓库 credential 文件。脚本读取的是自身进程环境，不是运行实例的 `/proc/<pid>/environ`；其次为脚本自身 env，最后为 credential 文件。

session 计费未经核实，不得声称 `/auto` 或 `/model/fusion` 会话免费。

### GitHub usage API

用于 `https://api.github.com/copilot_internal/user`：

- 直接使用 GitHub token；
- 不得使用 Copilot token。

手动探针：

```bash
curl -sS https://api.github.com/copilot_internal/user \
  -H "authorization: token <GitHub token>" \
  -H "x-github-api-version: 2025-04-01"
```

`401 Bad credentials` 通常表示把 Copilot token 误用于 usage API；先检查 token 层次，再检查账户权限。

## 直接后端脚本

脚本目录为 `.agents/skills/copilot-backend-tester/scripts/`；`.claude/skills/copilot-backend-tester` 只是兼容指针。

所有脚本均为 `.mjs`，由 Bun 直接运行（`bun <script>.mjs`）。脚本共享 `copilot-auth.mjs`（token exchange、版本常量运行时读取、凭证优先级），输出辅助共享 `probe-common.mjs`（脱敏、响应头过滤、SSE 透传）。不要为单次探针重新实现 `/token` 或硬编码旧版本。

Fusion 探测使用 `test-fusion-select.mjs`，默认执行去重后的共享条件及真实源码条件，`--runtime-seeds` 只选择原始四题。输出始终是单个脱敏 JSON 报告。

### Messages

```bash
bun .agents/skills/copilot-backend-tester/scripts/test-messages.mjs \
  <LIVE_MODEL_ID> \
  --proxy-url http://localhost:<PORT> \
  --prompt "Reply with exactly: hi"
```

支持 `--business`、`--stream`、`--adaptive`、`--effort`、`--thinking`、`--initiator` 和 `--show-headers`。模型 ID 先从本次 `/v1/models` 或 Auto 探针取得；不使用猜测的示例模型。

### Chat Completions

```bash
bun .agents/skills/copilot-backend-tester/scripts/test-chat-completions.mjs \
  <LIVE_MODEL_ID> \
  --proxy-url http://localhost:<PORT> \
  --prompt "Reply with exactly: hi"
```

## 版本和 headers

版本不是 skill 的静态事实。请求头与身份常量（`COPILOT_VERSION`、`API_VERSION`、`x-github-api-version`、VS Code fallback、编辑器身份头）由 `copilot-auth.mjs` 运行时从仓库源码读取，每次探针取当前值；不要把某次读取结果复制为永久默认值。

修改或排查选模与 header 行为时先读：

- `src/services/copilot/get-auto-selection.ts` — `POST /auto` 请求体、tier 参数和响应解析
- `src/services/copilot/get-fusion-selection.ts` — `POST /model/fusion` 请求体、Fusion 响应校验
- `src/lib/auto-probe-prompts.ts` — `ProbeCondition`、`getProbeConditions()`、四档 Auto 条件和两个 Fusion 版本共用的题面
- `src/lib/auto-session.ts` — 进程内存 session 配对、预热/刷新/过期、`sampleHardSnippet()` 真实片段采样
- `src/services/get-vscode-version.ts` — VS Code fallback
- `src/services/github/get-copilot-token.ts` — `/copilot_internal/v2/token`

如需说明“仓库当前值”，引用读取时的源码值和观测结果。

## 结果报告契约

先给结论，再给证据。Auto 报告至少包含：

```text
结论：<本次观测到的可选模型集合>
观测：<UTC 时间、端口、PID、账户、上游 host>
matrix：<expected_cases 个条件逐一列出 condition_id、prompt_id、tier 或 plan_version、status、models、hydra_scores、source 或 sources(file:startLine)、prompt_sha256>
覆盖：<本次 wanted、observed、missing、extra>
生成：<accepted、with/without token 状态、expected 与 measured 折扣、token_type 单价证据>
请求数：auto=<实际 /auto 请求数>，generation=<实际生成请求数>，token exchange=<认证请求数，另列>
限制：<失败条件、未确认可选的模型、stop_reason>
```

Fusion 报告使用相同元数据与限制说明。`matrix` 还列出有序 `steps`、`fusion_pattern` 和 `expires_at`，请求数写 `fusion=<实际 /model/fusion 请求数>`。Auto 和 Fusion 的模型集合不得合并成一个未注明来源的列表。

- `observed_models` 只报告为对应来源在本次观测到的模型并集；未出现不等于已下架或不可用。`/v1/models` 结果单独标为静态兼容层模型列表，不与 Auto 或 Fusion 观测混同。
- 报告中禁止出现 token、session token、完整 Authorization header、完整私密响应。失败时报告实际状态码和脱敏错误类别，不用“应该”“大概”“可能支持”替代探针。

## 代理与上游差异调查

需要判断问题出在代理还是后端时：

1. 固定同一个真实模型 ID、prompt、请求头意图和 request ID 形态。
2. 分别记录代理响应与上游响应的状态、headers、body 结构。
3. 从日志中使用确切模型名、request ID 和错误文本；不要自行替换成“类似模型”。
4. 对流式请求同时检查清理路径和终止事件。

### OpenCode 错误

同时检查 `~/.local/share/opencode/log/` 和 `~/.local/share/opencode/opencode.db`。日志只做定向搜索，不读取完整大文件；SQLite 查询 `message.data` 的 `modelID`、`finish` 和 `part.data` 的 error 内容。日志和数据库互相印证后，再构造最小的真实后端请求。

## 常见失败与处理

- `/token` 为 `404`：这是旧入口，不是后端模型不可用；改走 token exchange。
- `/auto` 或 `/model/fusion` 返回 `401`/`403`：停止并设置 `identity_halt`，不换账号。返回 `429`/`5xx` 时最多退避重试一次，仍失败则保留实际状态并停止。
- 无效结构、生成 HTTP 失败、历史写入失败或预算耗尽：停止并报告 `stop_reason`，保留已获得的脱敏结果。
- `selected_model` 为空或字段缺失：记录实际 HTTP 状态与脱敏错误类别，先确认 token、endpoint 与实例没有混用。
- `421 Misdirected Request`：token 的 `endpoints.api` 与手工指定 host 不一致；以 token exchange 路由为准。
- usage API `401`：检查是否误用了 Copilot token。
- Auto 结果与 `/v1/models` 不一致：这是两个不同事实层，分别报告。
