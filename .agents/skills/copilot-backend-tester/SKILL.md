---
name: copilot-backend-tester
description: "Use when testing GitHub Copilot upstream APIs directly, listing Auto models, comparing proxy and upstream responses, or probing usage/account endpoints; trigger on requests mentioning Copilot backend, /models/session, Auto models, /copilot_internal/user, curl Copilot, or real backend usage."
---

# Copilot 后端测试

直接验证 GitHub Copilot 上游行为，先取得可观察证据，再判断代理代码是否需要修改。

## 目标边界

- 区分本地代理、Copilot 上游和 GitHub usage API 三个层次。
- Auto 模型列表以同一实例的上游 `POST /models/session` 响应为准。
- 不把 `/v1/models`、本地模型缓存或模型命名规则当作 Auto 列表。
- 不猜模型名、账户类型、版本号、端点或响应字段；从运行进程、仓库源码和本次响应读取。
- 所有报告脱敏：不得打印 GitHub token、Copilot token、session token 或完整 Authorization header。

## 同类任务的最快路径：列出 Auto 模型

用户要求“现在有哪些 Auto 模型”时，按以下顺序执行：

1. **盘点运行实例**

   ```bash
   ss -tlnp
   ps -eo pid=,args=
   ```

   选择两个或三个当前运行的 `src/main.ts start` 实例，记录端口、账户参数和进程 PID。不要假定端口一定是 `4141`、`4142` 或 `4146`。

   完成条件：候选实例、PID、端口和账户参数已记录，且所有 token 字段已脱敏。

2. **按仓库认证链路获取 token**

   使用脚本：

   ```bash
   bash .agents/skills/copilot-backend-tester/scripts/test-auto-route.sh \
     --proxy-url http://localhost:<PORT> \
     --list-models
   ```

   脚本遵循仓库 `start.ts` 的凭据优先级：选定进程的 `-g/--github-token`、`COPILOT_API_GITHUB_TOKEN` 环境变量、仓库 credential store 文件。然后复现 `getCopilotToken()`：

   ```text
   GET https://api.github.com/copilot_internal/v2/token
   → response.token
   → response.endpoints.api
   ```

   `response.endpoints.api` 是该 token 的路由权威来源。不要调用不存在的本地 `/token` 端点，也不要把 GitHub token 直接当作 Copilot token。

   完成条件：同一实例已得到可用的 Copilot token 和上游 endpoint，且 token 原值未进入输出。

3. **调用仓库使用的 Auto session**

   对上一步得到的 Copilot endpoint 发送：

   ```http
   POST /models/session
   Content-Type: application/json
   Authorization: Bearer <Copilot token>
   ```

   请求体必须是：

   ```json
   {"auto_mode":{"model_hints":["auto"]}}
   ```

   请求头应跟随 `src/lib/api-config.ts` 的 `copilotModelsHeaders()`：当前 `COPILOT_VERSION`、VS Code fallback、`x-github-api-version`、`editor-device-id`、`x-vscode-user-agent-library-version` 等值从源码或 helper 动态取得，不复制旧常量。

   完成条件：请求返回可解析 JSON，且 HTTP 状态、响应 headers 和实例归属已记录。

4. **只从 `available_models` 得出列表**

   记录每个实例的：

   - 观测时间（UTC）
   - 代理端口、PID、账户类型和上游 host
   - HTTP 状态
   - `available_models` 原始顺序和排序后的去重集合
   - `selected_model`、`expires_at` 是否存在

   不把顺序当作规则，不把 `selected_model` 当作永久默认值，不把一次探针结果写成静态配置。

   完成条件：每个实例都有原始顺序、排序去重集合和字段存在性记录。

5. **交叉检查**

   对多个实例重复同一请求。只有在实例之间集合相同，才能报告“本次探测集合一致”；若不同，按实例分别报告。将 `/v1/models` 结果单独标为兼容层模型列表。

   完成条件：已明确报告集合是否一致，并把 `/v1/models` 与 Auto 结果分开。

## Auto intent 与最终请求

`/models/session/intent` 是“本次 prompt 最终选择哪个模型”的额外后端探针，不是列出 Auto 可用模型的必要步骤。

只有用户明确询问 `chosen_model`、Auto 是否能完成一条 prompt 或需要复现后端路由时才继续：

1. 使用同一次 `/models/session` 返回的 `session_token`。
2. 将同一次响应的 `available_models` 原样放入 intent 请求。
3. 带 `Copilot-Session-Token`，不得跨实例或跨 token 复用。
4. 记录 `chosen_model`、候选集和最终请求 HTTP 状态。
5. 按当前模型元数据的 `supported_endpoints` 选择 `/v1/messages`、`/responses` 或 `/chat/completions`；不能只凭模型名猜端点。

`test-auto-route.sh --list-models` 只做 session 列表；`--skip-final` 可做 session + intent；默认最终请求仍使用同一 session token。

完成条件：若运行 intent，`chosen_model` 与最终 HTTP 状态来自同一 session，且没有跨实例复用 token。

## 认证分层

### Copilot 后端

用于 `/models/session`、`/v1/messages`、`/responses`、`/chat/completions`：

```text
GitHub token
  → GET /copilot_internal/v2/token
  → Copilot token + endpoints.api
  → Copilot upstream
```

### GitHub usage API

用于 `https://api.github.com/copilot_internal/user`：

- 直接使用 GitHub token；
- 不使用 Copilot token；
- token 来源仍遵循仓库的 CLI、`COPILOT_API_GITHUB_TOKEN`、credential file 优先级；
- 记录响应状态、关键 body 字段和必要的 GitHub REST headers，但不记录 token 原值。

手动探针：

```bash
curl -sS -D /tmp/copilot-usage.headers \
  -o /tmp/copilot-usage.json \
  https://api.github.com/copilot_internal/user \
  -H "authorization: token $GITHUB_TOKEN" \
  -H "accept: application/vnd.github+json" \
  -H "x-github-api-version: 2025-04-01"
jq '{login, access_type_sku, copilot_plan, endpoints, quota_snapshots}' \
  /tmp/copilot-usage.json
```

`401 Bad credentials` 通常表示把 Copilot token 误用于 usage API；先检查 token 层次，再检查账户权限。

## 直接后端脚本

脚本目录为 `.agents/skills/copilot-backend-tester/scripts/`；`.claude/skills/copilot-backend-tester` 只是兼容指针。

脚本共享 `copilot-auth.sh`，因此不要为单次探针重新实现 `/token` 或硬编码旧版本。

### Messages

```bash
bash .agents/skills/copilot-backend-tester/scripts/test-messages.sh \
  <LIVE_MODEL_ID> \
  --proxy-url http://localhost:<PORT> \
  --prompt "Reply with exactly: hi"
```

支持 `--business`、`--stream`、`--adaptive`、`--effort`、`--thinking`、`--initiator` 和 `--show-headers`。模型 ID 先从本次 `/v1/models` 或 Auto 探针取得；不使用猜测的示例模型。

### Chat Completions

```bash
bash .agents/skills/copilot-backend-tester/scripts/test-chat-completions.sh \
  <LIVE_MODEL_ID> \
  --proxy-url http://localhost:<PORT> \
  --prompt "Reply with exactly: hi"
```

### Auto

```bash
# 只列出 Auto session 的 available_models
bash .agents/skills/copilot-backend-tester/scripts/test-auto-route.sh \
  --proxy-url http://localhost:<PORT> \
  --list-models

# 解析 chosen_model，但不发送最终 prompt
bash .agents/skills/copilot-backend-tester/scripts/test-auto-route.sh \
  --proxy-url http://localhost:<PORT> \
  --skip-final \
  --prompt "Reply with exactly: hi"

# 解析并发送最终请求
bash .agents/skills/copilot-backend-tester/scripts/test-auto-route.sh \
  --proxy-url http://localhost:<PORT> \
  --prompt "Reply with exactly: hi"
```

可用 `--business`、`--show-headers` 和 `--max-output`。`--business` 只用于选择/校验账户分支；token exchange 返回的 `endpoints.api` 优先。

## 版本和 headers

版本不是 skill 的静态事实。修改或排查 header 时先读：

- `src/lib/api-config.ts`
  - `COPILOT_VERSION`
  - Copilot `API_VERSION`
  - `copilotModelsHeaders()`
  - `githubHeaders()`
- `src/services/get-vscode-version.ts`
  - VS Code fallback
- `src/services/github/get-copilot-token.ts`
  - `/copilot_internal/v2/token`
- `src/services/copilot/get-models-session.ts`
  - `/models/session` body 和错误处理
- `src/lib/auto-session.ts`
  - `available_models` 缓存、过期和 token 绑定

如需说明“仓库当前值”，引用读取时的源码值和观测结果；不要把本次值复制为永久默认值。

## 结果报告契约

先给结论，再给证据。至少包含：

```text
结论：<本次探针得到的 Auto 模型集合/实例差异>
观测：<UTC 时间、端口、PID、账户类型、上游 host>
session：HTTP <状态>，available_models=<...>，selected_model=<...>
交叉检查：<各实例集合是否一致>
限制：<未探测的实例、失败请求或未验证字段>
```

报告中禁止出现 token、session token、完整 Authorization header、完整私密响应。失败时报告实际状态码和脱敏错误类别，不用“应该”“大概”“可能支持”替代探针。

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
- `available_models` 为空或字段缺失：保存 HTTP 状态和脱敏 body，先确认 token、endpoint 与实例没有混用。
- `Missing/Invalid Copilot-Session-Token`：重新获取同实例的 session，不复用旧 token。
- `421 Misdirected Request`：token 的 `endpoints.api` 与手工指定 host 不一致；以 token exchange 路由为准。
- usage API `401`：检查是否误用了 Copilot token。
- Auto 列表与 `/v1/models` 不一致：这是两个不同事实层，分别报告。
