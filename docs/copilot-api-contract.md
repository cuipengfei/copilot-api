# Copilot API Contract

> 基于 `microsoft/vscode-copilot-chat` 源码分析（2026-01-27）

本文档记录 VSCode Copilot Chat 扩展与 GitHub Copilot 后端之间的 API 契约。

## 端点概览

| 端点             | 路径                | 用途                                   |
| ---------------- | ------------------- | -------------------------------------- |
| Chat Completions | `/chat/completions` | 标准 OpenAI 格式                       |
| Responses        | `/responses`        | OpenAI Responses API（支持 reasoning） |
| Messages         | `/v1/messages`      | Anthropic 原生格式（由实验开关控制）   |

### 端点选择逻辑

```typescript
// 来源: chatEndpoint.ts:236-249
function selectEndpoint(model: IChatModelInformation): ModelSupportedEndpoint {
  // 优先级：Responses > Messages > ChatCompletions
  if (
    model.supported_endpoints?.includes("Responses") &&
    !model.supported_endpoints?.includes("ChatCompletions")
  ) {
    return "/responses";
  }
  if (model.supported_endpoints?.includes("Responses")) {
    return "/responses";
  }
  if (enableMessagesApi && model.supported_endpoints?.includes("Messages")) {
    return "/v1/messages";
  }
  return "/chat/completions";
}
```

---

## 请求体结构

### Chat Completions API

```typescript
// 来源: networking.ts:61-119, networking.ts:282-298
interface ChatCompletionsRequestBody {
  // 必选
  messages: CAPIChatMessage[];
  model: string;

  // 可选 - 采样参数
  temperature?: number; // 默认 1
  top_p?: number; // 默认 1
  n?: number; // 并行生成数，默认 1
  max_tokens?: number; // 最大输出 tokens
  stop?: string[]; // 停止词

  // 可选 - 流式
  stream?: boolean; // 默认 true
  stream_options?: {
    include_usage?: boolean; // 包含 usage 统计
  };

  // 可选 - 工具调用
  tools?: OpenAiFunctionTool[];
  tool_choice?:
    | "none"
    | "auto"
    | { type: "function"; function: { name: string } };

  // 可选 - Anthropic 模型专用
  // 仅当满足以下条件时注入：
  // 1. isAnthropicFamily(model) - Anthropic 模型族
  // 2. !disableThinking - 未禁用 thinking
  // 3. location === ChatLocation.Agent - Agent 模式
  thinking_budget?: number; // 思考预算（1024-32000）

  // 可选 - 其他
  prediction?: Prediction; // 预测输出
  logprobs?: boolean; // 返回 log 概率

  // 可选 - 采样调整（通过 postOptions 合并）
  logit_bias?: number; // Token 偏置
  presence_penalty?: number; // 存在惩罚
  frequency_penalty?: number; // 频率惩罚

  // 可选 - Legacy 函数调用
  functions?: OpenAiFunctionDef[];
  function_call?: { name: string };

  // 可选 - reasoning（请求值优先；缺省用本地配置默认值收敛到模型能力，模型显式声明空列表则不注入）
  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max";

  // 可选 - Copilot 扩展
  copilot_thread_id?: string; // 会话线程 ID
  copilot_skills?: string[]; // 启用的 skills

  // 可选 - 替代 max_tokens
  max_completion_tokens?: number; // 与 max_tokens 二选一
}

interface CAPIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string; // role=tool 时必填

  // Copilot 扩展
  copilot_references?: ICopilotReference[];
  copilot_confirmations?: { state: string; confirmation: any }[];
  copilot_cache_control?: { type: "ephemeral" };

  // Thinking（历史消息中）
  reasoning_opaque?: string; // 加密的思考 ID
  reasoning_text?: string; // 思考摘要文本
}
```

### Responses API

```typescript
// 来源: responsesApi.ts:29-72
interface ResponsesRequestBody {
  model: string;
  input: ResponseInputItem[];

  // 流式
  stream: true; // 始终 true

  // 工具
  // 注意：tools 会被转换为以下格式：
  // { type: 'function', strict: false, parameters: {...} }
  tools?: ResponsesFunctionTool[];
  tool_choice?: "none" | "auto" | { type: "function"; name: string };

  // 输出控制
  max_output_tokens?: number;
  top_logprobs?: number; // logprobs ? 3 : undefined

  // 状态管理
  // previous_response_id 来自 stateful marker 机制：
  // 1. 从消息历史中查找 statefulMarker
  // 2. 如果找到，设置 previous_response_id 并截断消息
  previous_response_id?: string; // 上次响应 ID（用于多轮对话）
  store: false; // 始终 false

  // 截断
  truncation: "auto" | "disabled";

  // Reasoning
  reasoning?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max"; // 请求值优先；缺省用本地按模型配置的默认值
    summary?: "auto" | "brief" | "detailed";
  };
  include: ["reasoning.encrypted_content"]; // 请求返回加密推理状态，始终保留

  // 文本控制
  text?: {
    verbosity?: "low" | "medium" | "high";
  };
}

type ResponseInputItem =
  | { role: "user"; content: ResponseInputContent[] }
  | { role: "system"; content: ResponseInputContent[] }
  | ResponseOutputMessage // assistant 消息
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string }
  // belong 4xx 重试或已学习身份命中时，移除 input 中 reasoning item 的 encrypted_content，保留 id/type/summary
  | { type: "reasoning"; id: string; summary: []; encrypted_content: string };
```

HTTP Responses 收到 `error.message` 包含 `belong` 的实际 `4xx` 且输入含 `encrypted_content` 时，规范化输入并重试一次。同一明确 session 与 agent、模型、上游 URL、`Authorization` 和 `Copilot-Session-Token` 的后续请求会在首发前应用已学习的处理；缓存键只保存两种凭据的 SHA-256 摘要。HTTP 重试更新令牌时，学习使用最终请求凭据。记录仅保存在当前进程，最多 1024 条，按首次插入顺序淘汰。未提供明确 session 身份的请求保留逐次检查，WebSocket 请求沿用原有处理。身份选择顺序见[Responses HTTP replay 兼容](local-features.md#4-responses-http-replay-兼容)。

native Responses 只在模型支持时注入配置 effort，空能力列表时省略配置值，能力数据未知时保留配置默认行为。显式请求继续使用既有能力归一化规则。Chat fallback 的整体终态在上游流结束时提交，流内错误生成 `response.failed`，不会先发送整体成功终态。

### Messages API（Anthropic 原生格式）

> **重要发现**：Copilot 后端**原生支持** `/v1/messages` 端点，可直接透传 Anthropic 格式请求，无需转换为 OpenAI 格式。

```typescript
// 来源: messagesApi.ts:115-127
interface MessagesRequestBody {
  model: string;
  messages: MessageParam[];
  system?: TextBlockParam[]; // 系统消息（Anthropic 风格）

  // 流式
  stream: true; // 始终 true

  // 工具
  tools?: AnthropicTool[];
  top_p?: number;
  max_tokens?: number;

  // Thinking（Anthropic 原生）
  thinking?: {
    type: "enabled";
    budget_tokens: number; // 1024-32000，受 max_tokens-1 限制
  };

  // Context Management（实验性）
  context_management?: ContextManagementConfig;
}

interface MessageParam {
  role: "user" | "assistant";
  content: ContentBlock[];
}
```

#### 启用条件

```typescript
// 来源: chatEndpoint.ts:247-250
function shouldUseMessagesApi(model: IChatModelInformation): boolean {
  const enableMessagesApi = configService.getExperimentBasedConfig(
    ConfigKey.UseAnthropicMessagesApi,
    expService,
  );
  return !!(
    enableMessagesApi &&
    model.supported_endpoints?.includes(ModelSupportedEndpoint.Messages)
  );
}
```

#### Messages API SSE 事件类型

```typescript
// 来源: messagesApi.ts:381-673
| 'message_start'           // 消息开始，包含 usage
| 'content_block_start'     // 内容块开始（text/tool_use/thinking/server_tool_use/tool_search_tool_result）
| 'content_block_delta'     // 内容增量
| 'content_block_stop'      // 内容块结束
| 'message_delta'           // 消息增量（stop_reason, usage, context_management）
| 'message_stop'            // 消息结束
| 'error'                   // 错误
```

#### content_block 类型详解

```typescript
// 来源: messagesApi.ts:395-434
// content_block_start 事件中的 content_block.type 可能为：

| 'text'                    // 文本内容
| 'tool_use'                // 工具调用（客户端工具）
| 'thinking'                // 思考内容（当启用 thinking 时）
| 'server_tool_use'         // 服务器端工具调用（如 tool_search）
| 'tool_search_tool_result' // 工具搜索结果

// server_tool_use 示例
{
  "type": "content_block_start",
  "index": 1,
  "content_block": {
    "type": "server_tool_use",
    "id": "toolu_xxx",
    "name": "tool_search"
  }
}

// tool_search_tool_result 示例
{
  "type": "content_block_start",
  "index": 2,
  "content_block": {
    "type": "tool_search_tool_result",
    "tool_use_id": "toolu_xxx",
    "content": {
      "type": "tool_search_tool_search_result",
      "tool_references": [{ "tool_name": "read_file" }, ...]
    }
  }
}
```

#### context_management 响应

```typescript
// 来源: messagesApi.ts:578-584
// 在 message_delta 事件中可能包含 context_management 字段

{
  "type": "message_delta",
  "delta": { "stop_reason": "end_turn" },
  "context_management": {
    "applied_edits": [
      { "cleared_input_tokens": 1000, ... }
    ]
  }
}
```

示例事件：

```
data: {"type":"message_start","message":{"id":"msg_xxx","model":"claude-sonnet-4","usage":{"input_tokens":10}}}

data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

data: {"type":"content_block_stop","index":0}

data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}

data: {"type":"message_stop"}
```

#### 对我们项目的意义（潜在优化建议）

> ⚠️ 以下为基于源码分析的**推论**，非契约事实。实际可行性需验证。

```
当前实现：
Client (Anthropic) → 转换 → OpenAI → Copilot /chat/completions

潜在优化：
Client (Anthropic) → 直接透传 → Copilot /v1/messages
```

潜在优势：

- 省去格式转换
- 完整支持 Anthropic 原生 thinking
- 更好的工具调用兼容性

注意事项：

- 需验证 Copilot 后端是否对外开放此端点
- 需确认实验开关 `UseAnthropicMessagesApi` 的启用条件

---

## 请求 Headers

### 自动注入 Headers

以下 Headers 由 `baseFetchFetcher.ts` 自动注入：

| Header                                | 值                             | 用途       |
| ------------------------------------- | ------------------------------ | ---------- |
| `User-Agent`                          | `GitHubCopilotChat/${version}` | 客户端标识 |
| `X-VSCode-User-Agent-Library-Version` | 运行时动态                     | 库版本标识 |
| `Content-Type`                        | `application/json`             | 请求体类型 |

### 基础 Headers

| Header                 | 必选 | 值来源                       | 用途             |
| ---------------------- | ---- | ---------------------------- | ---------------- |
| `Authorization`        | ✅   | `Bearer ${copilotToken}`     | 认证             |
| `X-Request-Id`         | ✅   | `generateUuid()`             | 请求追踪         |
| `X-GitHub-Api-Version` | ✅   | `2025-05-01`                 | API 版本         |
| `X-Interaction-Type`   | ✅   | `locationToIntent(location)` | 功能标识         |
| `OpenAI-Intent`        | ✅   | 同 `X-Interaction-Type`      | 功能标识（别名） |

### 额外 Headers

| Header                   | 必选 | 值来源                                | 用途             |
| ------------------------ | ---- | ------------------------------------- | ---------------- |
| `X-Interaction-Id`       | ✅   | `interactionService.interactionId`    | 会话 ID          |
| `X-Initiator`            | ✅   | `'user'` 或 `'agent'`                 | 请求发起者       |
| `Copilot-Vision-Request` | ❌   | `'true'`（有图片且 `supportsVision`） | 标记 vision 请求 |

### 模型元数据注入 Headers

以下 Headers 由 `modelMetadata.requestHeaders` 动态注入：

| Header                        | 条件                                  | 用途           |
| ----------------------------- | ------------------------------------- | -------------- |
| `X-Model-Provider-Preference` | 配置了 `ModelProviderPreference`      | 模型提供商偏好 |
| 其他                          | `modelMetadata.requestHeaders` 中定义 | 模型特定配置   |

### Messages API Beta Headers

| Header           | 条件                 | 值                                |
| ---------------- | -------------------- | --------------------------------- |
| `anthropic-beta` | 启用 thinking        | `interleaved-thinking-2025-05-14` |
| `anthropic-beta` | 启用 context editing | `context-management-2025-06-27`   |
| `anthropic-beta` | 启用 tool search     | `advanced-tool-use-2025-11-20`    |

多个 beta 特性用逗号连接：`interleaved-thinking-2025-05-14,context-management-2025-06-27`

### OpenAI-Intent 值映射

```typescript
// 来源: chatMLFetcher.ts:1405-1426
function locationToIntent(location: ChatLocation): string {
  switch (location) {
    case ChatLocation.Panel:
      return "conversation-panel";
    case ChatLocation.Editor:
      return "conversation-inline";
    case ChatLocation.EditingSession:
      return "conversation-edits";
    case ChatLocation.Notebook:
      return "conversation-notebook";
    case ChatLocation.Terminal:
      return "conversation-terminal";
    case ChatLocation.Other:
      return "conversation-other";
    case ChatLocation.Agent:
      return "conversation-agent";
    case ChatLocation.ResponsesProxy:
      return "responses-proxy";
    case ChatLocation.MessagesProxy:
      return "messages-proxy";
  }
}
```

---

## 响应 Headers

| Header                               | 用途                            |
| ------------------------------------ | ------------------------------- |
| `x-request-id`                       | 请求 ID（用于追踪）             |
| `x-github-request-id`                | GitHub 请求 ID                  |
| `X-Copilot-Experiment`               | 服务端实验标识                  |
| `azureml-model-deployment`           | 模型部署 ID                     |
| `apim-request-id`                    | Azure API Management ID         |
| `Copilot-Edits-Session`              | Speculative decoding 端点 token |
| `retry-after`                        | 限流时的重试等待时间            |
| `x-ratelimit-exceeded`               | 触发限流的 key                  |
| `x-quota-snapshot-chat`              | 免费用户配额快照（URL 编码）    |
| `x-quota-snapshot-premium_models`    | 高级模型配额快照                |
| `x-quota-snapshot-premium_interactions` | 高级交互配额快照             |

### 配额快照 Header 格式

```
x-quota-snapshot-premium_interactions: ent=1000&rem=75.5&ov=0&ovPerm=false&rst=2026-02-01
```

| 参数     | 含义                   | 类型    |
| -------- | ---------------------- | ------- |
| `ent`    | 配额上限（entitlement）| number  |
| `rem`    | 剩余百分比             | number  |
| `ov`     | 超额使用量             | number  |
| `ovPerm` | 是否允许超额           | boolean |
| `rst`    | 配额重置日期           | ISO8601 |

---

## 流式响应格式

### Chat Completions SSE 格式

```
data: {"id":"chatcmpl-xxx","model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"}}]}

data: {"id":"chatcmpl-xxx","model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","model":"gpt-4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_xxx","function":{"name":"get_weather","arguments":""}}]}}]}

data: {"id":"chatcmpl-xxx","model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}

data: [DONE]
```

#### Delta 结构

```typescript
// 来源: stream.ts:185-207
interface ExtendedChoiceJSON {
  index: number;
  delta?: {
    content: string | null;
    role?: string;
    name?: string;
    function_call?: { name: string; arguments: string };
    tool_calls?: IToolCall[];
    copilot_annotations?: {
      CodeVulnerability: ICodeVulnerabilityAnnotation[];
      IPCodeCitations: IIPCodeCitation[];
      TextCopyright: boolean;
      // ... 其他过滤标志
    };
    // Thinking（内联在 delta 中）
    reasoning_opaque?: string;
    reasoning_text?: string;
  };
  finish_reason?:
    | "stop"
    | "length"
    | "function_call"
    | "tool_calls"
    | "content_filter"
    | "error"
    | null;
  logprobs?: ChoiceLogProbs;
  // 注意：content_filter_results 不包含 'snippy'（copyright）
  content_filter_results?: Record<
    Exclude<FilterReason, "snippy">,
    { filtered: boolean; severity: string }
  >;
}
```

#### Copilot 扩展事件（choices 为 null 或空数组）

除标准 choices 事件外，还有以下 Copilot 特有的顶层事件：

```typescript
// 来源: stream.ts:364-409
// 这些事件的 choices 可能为 null 或空数组，仅包含顶层字段
// 注意：初始 chunk 可能发送空 choices 数组来承载 prompt_filter_results

// Usage 事件（仅包含 usage）
data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}

// Copilot Confirmation 事件
data: {"copilot_confirmation":{"state":"accepted","confirmation":{...}}}

// Copilot Errors 事件
data: {"copilot_errors":[{"code":"rate_limit","message":"..."}]}

// Copilot References 事件
data: {"copilot_references":[{"type":"file","uri":"..."}]}
```

```typescript
// 来源: responsesApi.ts:376-512
// 事件类型：
| 'response.output_text.delta'              // 文本增量
| 'response.output_item.added'              // 工具调用开始
| 'response.function_call_arguments.delta'  // 工具参数增量
| 'response.output_item.done'               // 工具/推理完成
| 'response.reasoning_summary_text.delta'   // 推理摘要增量
| 'response.reasoning_summary_part.done'    // 推理摘要完成
| 'response.completed'                      // 响应完成
| 'error'                                   // 错误
```

示例事件：

```
data: {"type":"response.output_text.delta","delta":"Hello","output_index":0,"content_index":0}

data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","name":"get_weather","call_id":"call_xxx"}}

data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"location\":\""}

data: {"type":"response.completed","response":{"id":"resp_xxx","model":"gpt-4","output":[...],"usage":{...}}}
```

---

## 非流式响应格式

```typescript
// 来源: chatEndpoint.ts:65-112
interface NonStreamResponse {
  id: string;
  model: string;
  created: number;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      name?: string;
      tool_calls?: ToolCall[];
    };
    finish_reason: FinishedCompletionReason;
  }>;
  usage: APIUsage;
}

interface APIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
  completion_tokens_details?: {
    reasoning_tokens: number;
    accepted_prediction_tokens: number;
    rejected_prediction_tokens: number;
  };
}
```

---

## finish_reason 取值

| 值               | 来源   | 含义                 |
| ---------------- | ------ | -------------------- |
| `stop`           | 服务器 | 正常结束             |
| `length`         | 服务器 | 达到 max_tokens      |
| `function_call`  | 服务器 | 函数调用（已废弃）   |
| `tool_calls`     | 服务器 | 工具调用             |
| `content_filter` | 服务器 | 内容被过滤           |
| `error`          | 服务器 | 服务器错误           |
| `client-trimmed` | 客户端 | 客户端主动截断       |
| `Iteration Done` | 客户端 | 未收到 finish_reason |
| `DONE`           | 客户端 | 收到 [DONE]          |

---

## 错误响应与重试

### 可重试的网络错误

```typescript
// 来源: networking.ts:383-393
const RETRYABLE_ERRORS = [
  "ECONNRESET",
  "ETIMEDOUT",
  "ERR_NETWORK_CHANGED",
  "ERR_HTTP2_INVALID_SESSION",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_PROTOCOL_ERROR",
];
```

### 重试策略

- 首次遇到上述错误时，断开所有连接并重试一次
- 请求超时：30 秒（`requestTimeoutMs = 30 * 1000`）
- 取消请求会发送遥测事件 `networking.cancelRequest`

### Server Error 重试

```typescript
// 来源: chatMLFetcher.ts:305-329
// 基于配置的状态码重试
const retryServerErrorStatusCodes = configService.getExperimentBasedConfig(
  ConfigKey.TeamInternal.RetryServerErrorStatusCodes, expService);
const statusCodesToRetry = retryServerErrorStatusCodes.split(',').map(s => parseInt(s.trim(), 10));

// 如果状态码在重试列表中，触发重试
if (enableRetryOnError && statusCodesToRetry.includes(actualStatusCode)) {
  await this._retryAfterError({ retryReason: 'server_error', ... });
}
```

### 连接性回退

```typescript
// 来源: chatMLFetcher.ts:91
// 连接检查延迟（毫秒）
public connectivityCheckDelays = [1000, 10000, 10000];
```

### Rate Limiting 处理

| 状态码 | 处理     | 响应 Headers                          |
| ------ | -------- | ------------------------------------- |
| `429`  | 限流     | `retry-after`, `x-ratelimit-exceeded` |
| `402`  | 配额超限 | `retry-after`                         |

```typescript
// 来源: chatMLFetcher.ts:877-966
// 解析 retry-after header
const retryAfter = response.headers.get("retry-after");
const retryAfterDate = convertToDate(retryAfter);

// 返回失败信息
return {
  failKind: ChatFailKind.RateLimited,
  data: { retryAfter, rateLimitKey },
};
```

### 错误响应结构

```typescript
interface APIErrorResponse {
  code: number;
  message: string;
  metadata?: Record<string, any>;
}

// SSE 流中的错误
data: {"choices":null,"error":{"code":500,"message":"Internal server error"}}

// Responses API 错误事件
data: {"type":"error","code":"rate_limit_exceeded","message":"Rate limit exceeded","param":null}
```

### 内容过滤原因

| FilterReason | 描述         |
| ------------ | ------------ |
| `hate`       | 仇恨言论     |
| `self_harm`  | 自我伤害内容 |
| `sexual`     | 色情内容     |
| `violence`   | 暴力内容     |
| `snippy`     | 版权内容     |
| `prompt`     | 提示词被过滤 |

---

## 特殊功能

### Thinking / Reasoning

#### 请求配置

**Chat Completions（Anthropic 模型）**:

```typescript
{
  thinking_budget: 10000,  // 1024-32000，会被 maxOutputTokens-1 限制
}
```

**Responses API**:

```typescript
{
  reasoning: {
    effort: 'medium',      // low | medium | high | xhigh | max；请求值优先，缺省用本地配置默认值
    summary: 'auto',       // auto | brief | detailed
  },
  include: ['reasoning.encrypted_content'],
}
```

#### 响应中的 Thinking

**Chat Completions 流**:

```typescript
// 在 delta 中
{
  delta: {
    reasoning_opaque: 'copilot-thinking-xxx',  // 加密 ID
    reasoning_text: '分析用户请求...',          // 思考摘要
  }
}
```

**Responses API 流**:

```
data: {"type":"response.reasoning_summary_text.delta","delta":"分析中...","item_id":"reasoning_xxx"}

data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"reasoning_xxx","summary":[{"text":"..."}],"encrypted_content":"..."}}
```

### Tool Calls

#### 请求格式

```typescript
{
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '获取天气信息',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string' }
          },
          required: ['location']
        }
      }
    }
  ],
  tool_choice: 'auto'  // 或 'none' 或 { type: 'function', function: { name: 'xxx' } }
}
```

#### 响应格式

**Chat Completions**:

```typescript
{
  delta: {
    tool_calls: [{
      index: 0,
      id: 'call_xxx',
      function: {
        name: 'get_weather',
        arguments: '{"location":"北京"}'
      }
    }]
  },
  finish_reason: 'tool_calls'
}
```

**Responses API**:

```
data: {"type":"response.output_item.added","item":{"type":"function_call","name":"get_weather","call_id":"call_xxx"}}

data: {"type":"response.function_call_arguments.delta","delta":"{\"location\":\"北京\"}"}

data: {"type":"response.output_item.done","item":{"type":"function_call","name":"get_weather","call_id":"call_xxx","arguments":"{\"location\":\"北京\"}"}}
```

### Vision

#### 请求格式

```typescript
{
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "这张图片是什么？" },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,...",
            detail: "auto", // auto | low | high
            media_type: "image/png", // CAPI 特有
          },
        },
      ],
    },
  ];
}
```

#### 条件性 Header

当请求包含图片**且**模型 `supportsVision` 时，需要添加：

```
Copilot-Vision-Request: true
```

---

## 模型能力

```typescript
// 来源: endpointProvider.ts:37-58
interface IChatModelCapabilities {
  type: "chat";
  family: string; // gpt-4.1, claude-sonnet-4.5, etc.
  tokenizer: TokenizerType;
  limits?: {
    max_prompt_tokens?: number;
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    vision?: {
      max_prompt_images?: number;
    };
  };
  supports: {
    parallel_tool_calls?: boolean;
    tool_calls?: boolean;
    streaming?: boolean;
    vision?: boolean;
    prediction?: boolean;
    thinking?: boolean;
  };
}
```

---

## 参考文件

| 文件                                               | 用途                      |
| -------------------------------------------------- | ------------------------- |
| `src/platform/networking/common/networking.ts`     | 请求体构建、postRequest   |
| `src/platform/endpoint/node/chatEndpoint.ts`       | 端点选择、请求定制        |
| `src/platform/endpoint/node/responsesApi.ts`       | Responses API 处理        |
| `src/platform/networking/node/stream.ts`           | SSEProcessor              |
| `src/platform/networking/common/fetch.ts`          | 类型定义                  |
| `src/platform/networking/common/openai.ts`         | OpenAI 类型               |
| `src/extension/prompt/node/chatMLFetcher.ts`       | Headers 设置、intent 映射 |
| `src/platform/endpoint/common/endpointProvider.ts` | 模型能力定义              |
| `src/platform/thinking/common/thinking.ts`         | Thinking 类型             |

---

## 与我们 Proxy 的对比

### Headers 差异

| Header                   | 官方值                  | 我们的值                | 状态        |
| ------------------------ | ----------------------- | ----------------------- | ----------- |
| `Authorization`          | `Bearer ${token}`       | ✅ 一致                 | ✅          |
| `X-Request-Id`           | `generateUuid()`        | ✅ `randomUUID()`       | ✅          |
| `X-GitHub-Api-Version`   | `2025-05-01`            | `2025-10-01`            | ✅ 我们更新 |
| `X-Interaction-Type`     | `locationToIntent()`    | ❌ **缺失**             | ⚠️          |
| `OpenAI-Intent`          | `locationToIntent()`    | ✅ `conversation-agent` | ✅          |
| `X-Interaction-Id`       | `interactionService.id` | ❌ **缺失**             | ⚠️          |
| `X-Initiator`            | `user` / `agent`        | ✅ 动态计算             | ✅          |
| `Copilot-Vision-Request` | `true`                  | ✅ 一致                 | ✅          |

**建议**：

- 添加 `X-Interaction-Id`（可用固定值或生成 UUID）
- 添加 `X-Interaction-Type`（与 `OpenAI-Intent` 相同值）

### 类型差异

| 字段                                         | 官方 | 我们    | 状态              |
| -------------------------------------------- | ---- | ------- | ----------------- |
| `finish_reason: function_call`               | ✅   | ❌ 缺失 | ⚠️ 已废弃，可忽略 |
| `finish_reason: error`                       | ✅   | ❌ 缺失 | ⚠️ 建议添加       |
| `completion_tokens_details.reasoning_tokens` | ✅   | ❌ 缺失 | ⚠️ 建议添加       |
| `thinking_budget`                            | ✅   | ✅      | ✅                |
| `reasoning_text/opaque`                      | ✅   | ✅      | ✅                |

### 源文件对应

| 官方文件                               | 我们的文件                                            |
| -------------------------------------- | ----------------------------------------------------- |
| `networking.ts` (IEndpointBody)        | `create-chat-completions.ts` (ChatCompletionsPayload) |
| `networking.ts` (postRequest)          | `api-config.ts` (copilotHeaders)                      |
| `stream.ts` (SSEProcessor)             | `stream-translation.ts`                               |
| `openai.ts` (FinishedCompletionReason) | `create-chat-completions.ts` (finish_reason)          |

---

## 附录：IEndpointBody 完整字段（2026-01-27 LSP 分析）

> 以下字段来自 `networking.ts:61-119` 的 `IEndpointBody` 接口定义，部分为内部使用或实验性字段。

### 已记录字段

参见上方「请求体结构」章节。

### 未公开使用字段

| 字段               | 类型                  | 用途/说明                      |
| ------------------ | --------------------- | ------------------------------ |
| `intent`           | `boolean`             | 意图检测开关（内部使用）       |
| `intent_threshold` | `number`              | 意图检测阈值（内部使用）       |
| `state`            | `'enabled'`           | 功能状态标记（内部使用）       |
| `snippy`           | `{ enabled: boolean }`| 版权检测配置（内部使用）       |
| `qos`              | `any`                 | QoS 配置（内部使用）           |
| `scopingQuery`     | `string`              | 搜索范围查询（代码搜索相关）   |
| `scoping_query`    | `string`              | 同上（snake_case 变体）        |

### Thinking 类型扩展

```typescript
// 来源: thinking.ts:16-28
interface RawThinkingDelta {
  // Azure OpenAI 字段
  cot_id?: string;      // Chain-of-Thought ID
  cot_summary?: string; // Chain-of-Thought 摘要

  // Copilot API 字段
  reasoning_opaque?: string; // 加密推理 ID
  reasoning_text?: string;   // 推理文本

  // Anthropic 字段
  thinking?: string;   // 思考内容
  signature?: string;  // 签名
}

// EncryptedThinkingDelta - 用于传递加密思考内容
interface EncryptedThinkingDelta {
  id: string;
  text?: string;
  encrypted: string;
}
```

### Rate Limit 重试逻辑

```typescript
// 来源: throttlingChatMLFetcher.ts:83-107
async function handleRateLimit(baseDelay: number, retryCount: number): boolean {
  if (retryCount > 3) return false; // 最多重试 3 次

  const delay = baseDelay * retryCount; // 指数退避
  await sleep(delay);
  return true;
}

// retryAfter 最小值为 5 秒
result.retryAfter = Math.max(5, result.retryAfter || 0);
```

### getExtraHeaders 实现汇总

不同端点类型提供不同的额外 Headers：

| 端点类型                        | Headers                                                                 | 文件位置                                   |
| ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| **ChatEndpoint**                | `modelMetadata.requestHeaders`, `X-Model-Provider-Preference`, `anthropic-beta` | `chatEndpoint.ts:175-205`                  |
| **Proxy4oEndpoint**             | `Copilot-Edits-Session`                                                 | `proxy4oEndpoint.ts:83-88`                 |
| **ProxyInstantApplyShortEndpoint** | `Copilot-Edits-Session`                                              | `proxyInstantApplyShortEndpoint.ts:80-85`  |
| **OpenAIEndpoint** (BYOK)       | `Content-Type`, `Authorization`/`api-key`, `_customHeaders`             | `openAIEndpoint.ts:309-321`                |
| **AzureOpenAIEndpoint**         | 强制 `Authorization: Bearer ...`，删除 `api-key`                        | `azureOpenAIEndpoint.ts:16-21`             |
| **XtabEndpoint**                | `Authorization` + `api-key`                                             | `xtabEndpoint.ts:87-97`                    |
| **StreamingPassThroughEndpoint**| `User-Agent`（前缀拼接）                                                | `oaiLanguageModelServer.ts:308-313`        |
| **Code/Docs Search**            | `Accept: application/json`, `X-GitHub-Api-Version: 2023-12-12-preview`  | `codeOrDocsSearchClientImpl.ts:185-191`    |

#### anthropic-beta Header 值

ChatEndpoint 根据模型能力设置 `anthropic-beta` header：

```typescript
// chatEndpoint.ts:175-205
const betaFeatures: string[] = [];

if (supportsInterleavedThinking) {
  betaFeatures.push('interleaved-thinking-2025-05-14');
}
if (supportsContextManagement) {
  betaFeatures.push('context-management-2025-01-14');
}
if (supportsAdvancedToolUse) {
  betaFeatures.push('advanced-tool-use-2025-01-14');
}

if (betaFeatures.length > 0) {
  headers['anthropic-beta'] = betaFeatures.join(',');
}
```
