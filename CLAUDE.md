# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- Build: `bun run build`
- Dev (watch): `bun run dev`
- Start (production env): `bun run start`
- Lint (with cache): `bun run lint`
- Lint fix on staged: `bunx lint-staged`
- Typecheck: `bun run typecheck`
- Test all: `bun test`
- Test single file: `bun test tests/[filename].test.ts`
- Package (prepack builds): `bun run prepack`

Notes:
- 不要手动运行 Prettier；风格遵循 eslint 规则与现有配置，修复交给 lint-staged。
- 本仓库的命令使用 bash 运行。

## Project Architecture

High-level
- 这是一个 GitHub Copilot API 代理，统一暴露 OpenAI-compatible、Anthropic-compatible、Gemini-compatible API。基于 Hono + Bun。

Core components
- API Translation Layer
  - OpenAI ↔ Anthropic: `src/routes/messages/*`
  - OpenAI ↔ Gemini: `src/routes/generate-content/*`
- Token counting for Anthropic: `src/lib/tokenizer.ts`
- GitHub Copilot integration: `src/services/*`
- Controls: `src/lib/rate-limit.ts`, `src/lib/approval.ts`, `src/lib/state.ts`
- Server routes mounting: `src/server.ts`

API endpoints
- OpenAI compatible
  - `POST /v1/chat/completions`
  - `GET /v1/models`
  - `POST /v1/embeddings`
- Anthropic compatible
  - `POST /v1/messages`
  - `POST /v1/messages/count_tokens`
- Gemini compatible
  - `POST /v1beta/models/{model}:generateContent`
  - `POST /v1beta/models/{model}:streamGenerateContent`
  - `POST /v1beta/models/{model}:countTokens`
- Monitoring
  - `GET /usage`
  - `GET /token`

## Key Implementation Details

Gemini integration
- 路由装载与匹配
  - `src/server.ts:35` 将 `geminiRouter` 挂在根路径 `server.route("/", geminiRouter)`
  - 路由定义使用通配符与顺序匹配，必须先注册 stream，再注册 countTokens，最后才是 generateContent
    - `src/routes/generate-content/route.ts:15-25, 29-39, 43-56`
  - 型号提取通过 URL 正则，不能用 Hono 的 `:param` 方式处理冒号语法

- 请求翻译（Gemini → OpenAI）
  - `translateGeminiToOpenAINonStream/Stream` 生成 `ChatCompletionsPayload`，必要时从 `contents` 合成最小工具声明以满足 Copilot 的 tool schema 要求
  - 工具声明优先使用 `parametersJsonSchema`，否则回退 `parameters`，最终兜底为 `{type:"object",properties:{}}`
  - 取消的 tool call 会在后处理阶段从任意位置清理，以避免 400
  - 代码位置：
    - `translateGeminiToOpenAINonStream/Stream`: `src/routes/generate-content/translation.ts:39-63, 65-89`
    - `synthesizeToolsFromContents`: `translation.ts:304-326`
    - `translateGeminiToolsToOpenAI`: `translation.ts:365-431`
    - 取消工具调用清理与消息合并: `translation.ts:185-236, 297-302`

- 响应翻译与流式（OpenAI → Gemini）
  - 非流→流式回退：当上游返回非流响应时，拆分为小块 SSE 返回，保证 CLI 一致性
    - `handleNonStreamingToStreaming/sendTextInChunks`: `src/routes/generate-content/handler.ts:71-104, 106-143`
  - 流式 JSON 累积解析：`StreamingJSONParser` 先尝试直接解析，失败后切换累积模式直到形成完整 JSON，避免半包导致崩流
    - `StreamingJSONParser`: `handler.ts:158-188`
    - 逐块处理：`processAndWriteChunk/handleStreamingResponse`: `handler.ts:194-238, 241-282`
  - 工具调用的增量参数：不完整 JSON `arguments` 跳过当次块，等待后续完整块
    - `processToolCalls`: `translation.ts:537-577`
  - **工具响应处理**：确保 tool call 与 response 1:1 映射
    - `ensureToolCallResponseMatch`: `translation.ts` 对 tool responses 按 `tool_call_id` 去重
    - 问题：OpenAI 可能返回重复的 tool responses，导致 Gemini 1:1 映射要求失败
    - 解决：简单去重逻辑，保留每个 `tool_call_id` 的第一个响应
  - 终止原因映射
    - OpenAI → Gemini: `mapOpenAIFinishReasonToGemini` in `src/routes/generate-content/utils.ts:3-23`
    - Gemini → OpenAI: `mapGeminiFinishReasonToOpenAI` in `utils.ts:26-50`

- 计数（Gemini countTokens）
  - `getTokenCount` 返回 `{input, output}`；Gemini 期望 total
  - `totalTokens = input + output`，`translation.ts` 提供 `translateGeminiCountTokensToOpenAI` 与 `translateTokenCountToGemini`
    - handler: `src/routes/generate-content/handler.ts:314-336`
    - translation: `src/routes/generate-content/translation.ts:732-756`

Model mapping
- 仅映射不被 Copilot 支持的 Gemini 型号到已知等价（例如 `gemini-2.5-flash` → `gemini-2.0-flash-001`），已支持的型号保持原样
  - `translation.ts:27-35`

Error handling
- 路由层 try/catch 并使用 `forwardError` 规范转发
  - `src/routes/generate-content/route.ts:15-22, 29-36, 49-53`

## Code Style & Conventions

- TypeScript 严格模式；避免 `any`
- Imports 使用 `~/*` 别名
- 无分号、双引号、按组排序 imports
- 不要直接运行 Prettier；依赖 eslint 与 lint-staged 做自动修复
- 不要打印或写入敏感信息

## Debugging & Troubleshooting

- 常见 Gemini 问题
  - `invalid_tool_call_format`：工具声明缺失或参数为空；确保 `tools` 与 `tool_choice` 按需出现，并有非空 `parameters`
  - **Tool call/response 1:1 映射错误**："Please ensure that the number of function response parts is equal to the number of function call parts" - 通常由重复的 `tool_call_id` 响应引起，需要去重而不是拆分
  - 嵌套 `functionResponse`：Gemini CLI 会发送嵌套数组，需用 `processFunctionResponseArray` 处理
  - `tool_call_id` 关联：用函数名暂存并在用户回应时取回，保持一致性
  - 取消的 tool call：清理掉未完成的 `assistant+tool_calls` 信息
  - `HTTPError`：多半是 OpenAI 侧 payload 校验失败

- Debug 日志分析方法
  - 使用 `DebugLogger` 自动生成 debug-logs/ 文件夹中的请求日志
  - 压缩大日志文件便于分析：用 `compress-logs.js` 脚本删除重复内容
  - 分析时用 PowerShell/脚本统计 function calls vs responses 数量：检查 `functionCall` 与 `functionResponse` 计数，以及翻译后的 `tool_calls` 与 tool responses 计数
  - **调试方法论**：
    - **数据先行**：从实际 debug logs 出发，不要基于理论假设
    - **验证而非猜测**：每次修改后必须通过新 debug logs 验证效果
    - **简单解决方案优先**：去重 > 拆分，避免过度复杂化
    - **承认错误**：当证据显示修复制造了新问题时，快速重新思考

- 快速自检
  - `bun run lint && bun run typecheck && bun run build`
  - `curl http://localhost:4142/v1/models` 查看真实支持的模型集合
  - 不要在助手侧运行服务；由用户本地确认行为
