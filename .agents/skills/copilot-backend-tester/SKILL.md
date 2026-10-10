---
name: copilot-backend-tester
description: "Use when testing GitHub Copilot upstream APIs directly, probing Auto model variety via POST /auto, comparing proxy and upstream responses, or checking usage/account endpoints; trigger on requests mentioning Copilot backend, /auto, Auto 选模, Auto 模型多样性, /v1/messages, /chat/completions, /copilot_internal/user, curl Copilot, or real backend usage."
---

# Copilot 后端测试

直接验证 GitHub Copilot 上游行为，先取得可观察证据，再判断代理代码是否需要修改。

## 目标边界

- 区分本地代理、Copilot 上游和 GitHub usage API 三个层次。
- Auto 本次可选模型以同一实例的上游 `POST /auto` 响应为准。
- 不把 `/v1/models`、本地模型缓存或模型命名规则当作 Auto 结果。
- 不猜模型名、账户类型、版本号、端点或响应字段；从运行进程、仓库源码和本次响应读取。
- 所有报告脱敏：不得打印 GitHub token、Copilot token、session token 或完整 Authorization header。

## 同类任务的最快路径：Auto 多样性探测

用户问“现在有哪些 Auto 模型”“Auto 这次能选到什么”时，主流程就是一次 `--variety` 探测。

1. **盘点运行实例**

   ```bash
   ss -tlnp
   ps -eo pid,args
   ```

   默认选一个当前运行的 `src/main.ts start` 实例；只有用户明确要求多实例时才逐一探测。记录端口、账户参数和 PID。展示进程参数时不得输出 `-g/--github-token` 的值，也不要假定端口一定是 `4141`、`4142` 或 `4146`。

   完成条件：选中实例的 PID、端口和账户参数已记录，token 字段已脱敏。

2. **运行 variety 探测**

   ```bash
   bun .agents/skills/copilot-backend-tester/scripts/test-auto-select.mjs \
     --proxy-url http://localhost:<PORT> \
     --variety
   ```

   账户明确为 business 时加 `--business`；不假定端口、账户或固定模型。

   完成条件：脚本输出纯 JSON 结果。

`--variety` 的约定：

- 12 个题目一次顺序请求 `/auto`，无重试，全程 AbortSignal，总预算最多 60 秒（含一次 token exchange 认证）。12 是请求预算上限，不是发现成功的标准：12 条全部成功也不等于发现了全部可选模型，只报告本次观测到的并集。
- 题目来自脚本内置的固定探测题（`src/lib/auto-probe-prompts.ts`）和运行仓库源码的真实 100 行片段（`sampleHardSnippet()`，源码 root、窗口行数等常量与 `src/lib/auto-session.ts` 运行时一致）：仅内存组合，无 SQLite/题库文件/多轮生成。
- 12 题顺序：`task-correctness`（intelligence）第 1，随后 hello（efficiency）、极短 hi（fast）、URL 任务（balance、fast 各一）、真实 100 行源码 + HARD_QUESTION 四档每档独立取样，最后行为说明（intelligence）、功能修改（balance）、并发调查（intelligence）。优先探测 Astra 的历史有效条件：P6 完整跨文件上下文、端到端正确性分析任务与 `intelligence`。该条件曾选中 Astra，另一个时间窗口未选中；实际选模随时间变化。
- 四个 task 题共用同一完整跨文件上下文：`src/lib/request-auth.ts`、`src/server.ts`、`src/lib/config.ts`、`tests/request-auth.test.ts`（前三个相对探测用 `sourceRoot` 读取，tests 从 `sourceRoot` 的兄弟目录 `tests` 读取；完整读入并保留末尾换行）。任务措辞与文件集保持稳定以便跨轮比较；每轮从当前文件重新构造，内容随源码变化；保留历史任务与文件集，不声明精确重放旧字节。
- 出处与追溯：hard 题只记录 `source`（`file`/`startLine`/`lineCount`，`lineCount` 恒为 100）；跨文件 task 题记录 `sources` 数组（每文件 `file`/`startLine: 0`/`lineCount` 为文件实际行数，路径统一相对 `REPO_ROOT`，repo 外 fixture 呈 `../` 前缀）。所有题带 `prompt_sha256`（题目正文的 SHA-256 hex）供跨轮比对；不打印题目正文与源码内容。
- 不预设选中模型；目标是尽可能发现本次可选模型。不声称观察到的是完整 available 名单；某模型本次未出现不等于已下架或不可用。

结果 JSON 形状：

```json
{
  "observed_at": "<UTC 时间>",
  "proxy_url": "http://localhost:<PORT>",
  "upstream": "<token exchange 返回的 endpoints.api>",
  "account": "business",
  "account_source": "expectation",
  "complete": true,
  "stop_reason": null,
  "auto_requests": 12,
  "results": [
    {
      "prompt_id": "task-correctness",
      "tier": "intelligence",
      "status": 200,
      "selected_model": "<模型 ID>",
      "supported_endpoints": ["<端点>"],
      "sources": [
        { "file": "src/lib/request-auth.ts", "startLine": 0, "lineCount": "<文件实际行数>" },
        { "file": "src/server.ts", "startLine": 0, "lineCount": "<文件实际行数>" },
        { "file": "src/lib/config.ts", "startLine": 0, "lineCount": "<文件实际行数>" },
        { "file": "tests/request-auth.test.ts", "startLine": 0, "lineCount": "<文件实际行数>" }
      ],
      "prompt_sha256": "<题目正文的 SHA-256 hex>"
    },
    {
      "prompt_id": "hard-efficiency",
      "tier": "efficiency",
      "status": 200,
      "selected_model": "<模型 ID>",
      "supported_endpoints": ["<端点>"],
      "source": { "file": "<仓库内路径>", "startLine": 0, "lineCount": 100 },
      "prompt_sha256": "<题目正文的 SHA-256 hex>"
    }
  ],
  "observed_models": ["<排序去重后的模型 ID>"],
  "expected_cases": 12
}
```
- 跨文件 task 题的 `sources` 恒为上述 4 项；hard 题用单数 `source`。
- `account` 按 CLI 取 `business`（`--business`）或 `individual`；`account_source` 固定 `expectation`，只是预期值，不能称已验证。账户归属仍以核实的选定实例启动参数为准。
- `status` 为 HTTP 状态码，失败无响应时为 `null`。`source.startLine`/`sources[].startLine` 为零起点；hard 的 `lineCount` 固定 100，跨文件 task 的 `lineCount` 为文件实际行数；`prompt_sha256` 供跨轮比对追溯。给用户指出阅读位置时可转为一基显示。
- `supported_endpoints` 缺失时该字段按 `null` 记录并继续后续题目，不视为该题失败。

- 无 `selected_model` 的条件不算成功。`stop_reason` 非空时是部分结果（`complete: false`、`stop_reason` 为停止原因），已拿到的结果与停止原因必须原样可见；token exchange 失败时记录其实际 HTTP 状态。
- `auto_requests` 是实际 `/auto` 请求数；token exchange 认证请求数另列，不计入。

单次选模能力保留：`--tier <efficiency|balance|intelligence|fast|all>` 与 `--prompt <任意题目>` 仍可单独使用。`--variety` 与 `--prompt`、`--tier`、`--with-inference`、`--show-headers` 互斥。

`--with-inference` 会用同一次 `/auto` 的 `session_token` 向 `selected_model.supported_endpoints` 的第一个非 WebSocket 端点发送最小请求，产生真实计费；只在用户明确要求验证生成链路时使用，不得与 `--variety` 同开。

认证失败或上游返回 401/403/429 时立即停止：不换账号、不重试，报告已拿到的部分结果与实际状态码。

## 认证分层

### Copilot 后端

用于 `/auto`、`/v1/messages`、`/responses`、`/chat/completions`：

```text
GET https://api.github.com/copilot_internal/v2/token (GitHub token)
→ Copilot token → Authorization: Bearer <Copilot token>
→ endpoints.api 决定后续 host（business 或 individual）
```

token exchange 返回的 `endpoints.api` 是该 token 的路由权威来源；账户以核实的选定实例启动参数为准，脚本只知道预期值（如 `--business`）时明确标注为 expectation，不由 hostname 推断。不要调用不存在的本地 `/token` 端点，也不要把 GitHub token 直接当作 Copilot token。

脚本的 GitHub token 来源优先级：选定运行进程的 `-g/--github-token` → 执行脚本自身的 `COPILOT_API_GITHUB_TOKEN` 环境变量 → 仓库 credential 文件。脚本读取的是自身进程环境，不是运行实例的 `/proc/<pid>/environ`；其次为脚本自身 env，最后为 credential 文件。

session 计费未经核实，不得声称 `/auto` 会话免费。

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
- `src/lib/auto-probe-prompts.ts` — 固定探测题目（hello、HARD_QUESTION、URL 任务）
- `src/lib/auto-session.ts` — 进程内存 session 配对、预热/刷新/过期、`sampleHardSnippet()` 真实片段采样
- `src/services/get-vscode-version.ts` — VS Code fallback
- `src/services/github/get-copilot-token.ts` — `/copilot_internal/v2/token`

如需说明“仓库当前值”，引用读取时的源码值和观测结果。

## 结果报告契约

先给结论，再给证据。Auto 多样性探测的报告至少包含：

```text
结论：<本次观测到的可选模型集合>
观测：<UTC 时间、端口、PID、账户、上游 host>
matrix：<12 个条件逐一列出 prompt_id、tier、status、selected_model、source 或 sources(file:startLine)、prompt_sha256>
请求数：auto=<实际 /auto 请求数>，token exchange=<认证请求数，另列>
限制：<失败条件、未确认可选的模型、stop_reason>
```

- `observed_models` 只报告为“本次观测到的可选模型”，是本次观测到的并集；未出现在并集中的模型不能断定不可用。`/v1/models` 结果单独标为静态兼容层模型列表，不与 Auto 观测混同。
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
- `/auto` 返回 `401`/`403`/`429`：立即停止，不换账号、不重试，报告部分结果与实际状态码。
- `selected_model` 为空或字段缺失：记录实际 HTTP 状态与脱敏错误类别，先确认 token、endpoint 与实例没有混用。
- `421 Misdirected Request`：token 的 `endpoints.api` 与手工指定 host 不一致；以 token exchange 路由为准。
- usage API `401`：检查是否误用了 Copilot token。
- Auto 结果与 `/v1/models` 不一致：这是两个不同事实层，分别报告。
