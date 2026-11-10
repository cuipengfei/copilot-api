import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { z } from "zod"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/types/anthropic"
import type { Model } from "~/lib/types/models"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"
import type {
  createMessages as createCopilotMessages,
  CreateMessagesReturn,
} from "~/services/copilot/create-messages"
import type {
  CreateResponsesReturn,
  ResponsesPayload,
  ResponsesResult,
  ResponsesTransport,
} from "~/lib/types/responses"

import { COMPACT_REQUEST } from "~/lib/compact"
import * as configModule from "~/lib/config"
import { installModelsDevCatalog } from "~/lib/models-dev-cache"
import { requestContext, type RequestTiming } from "~/lib/request-context"
import { requestEventsMiddleware } from "~/lib/request-events"
import { attachResponseHeaders } from "~/lib/response-headers"
import { closeUsageStore, getTokenUsageEventsPage } from "~/lib/token-usage"
import { traceIdMiddleware } from "~/lib/trace"

import { modelsDevCatalogFixture } from "./fixtures/models-dev-catalog"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

let capturedPayload: ChatCompletionsPayload | null = null
let capturedMessagesPayload: AnthropicMessagesPayload | null = null
let capturedResponsesPayload: ResponsesPayload | null = null
let capturedResponsesOptions: {
  transport?: ResponsesTransport
} | null = null
let responsesApiWebSocketEnabled = true

const createChatCompletions = mock(
  (payload: ChatCompletionsPayload): Promise<ChatCompletionResponse> => {
    capturedPayload = payload
    return Promise.resolve({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: payload.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "ok",
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
    })
  },
)
const createMessages = mock(
  (
    payload: AnthropicMessagesPayload,
    _anthropicBetaHeader: Parameters<typeof createCopilotMessages>[1],
    _options: Parameters<typeof createCopilotMessages>[2],
  ): Promise<CreateMessagesReturn> => {
    capturedMessagesPayload = payload
    return Promise.resolve(createMessagesResult(payload.model))
  },
)
const createResponses = mock(
  (
    payload: ResponsesPayload,
    options: {
      transport?: ResponsesTransport
    },
  ): Promise<CreateResponsesReturn> => {
    capturedResponsesPayload = payload
    capturedResponsesOptions = options
    return Promise.resolve(createResponsesResult(payload.model))
  },
)

const {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
  messagesApiFlowDependencies,
} = await import("../src/routes/messages/api-flows")
const { responsesUtilsDependencies } =
  await import("../src/routes/responses/utils")
const { tokenUsageRoute } = await import("../src/routes/token-usage/route")

const defaultMessagesApiFlowDependencies = { ...messagesApiFlowDependencies }
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }

const logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Parameters<typeof handleWithChatCompletions>[2]["logger"]

const createContext = () =>
  ({
    req: {
      raw: new Request("http://localhost/v1/messages"),
      header: (_name: string) => undefined,
    },
    json: (body: unknown) => Response.json(body),
  }) as Parameters<typeof handleWithChatCompletions>[0]

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  capturedPayload = null
  capturedMessagesPayload = null
  capturedResponsesPayload = null
  capturedResponsesOptions = null
  responsesApiWebSocketEnabled = true
  messagesApiFlowDependencies.createChatCompletions = createChatCompletions
  messagesApiFlowDependencies.createMessages = createMessages
  messagesApiFlowDependencies.createResponses = createResponses
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    undefined
  responsesUtilsDependencies.isContextManagementEnabledForMessages = () => true
  responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
    false
  responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () =>
    responsesApiWebSocketEnabled
  createChatCompletions.mockClear()
  createMessages.mockClear()
  createResponses.mockClear()
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  Object.assign(messagesApiFlowDependencies, defaultMessagesApiFlowDependencies)
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
})

test("messages Chat Completions flow shares the main cache key with dispatched subagents", async () => {
  const response = await handleWithChatCompletions(
    createContext(),
    {
      model: "gpt-test",
      max_tokens: 128,
      metadata: { user_id: JSON.stringify({ session_id: "root" }) },
      messages: [{ role: "user", content: "hello" }],
    },
    {
      logger,
      requestId: "request-subagent",
      subagentMarker: {
        session_id: "child",
        agent_id: "agent-a",
        agent_type: "collab_spawn",
      },
    },
  )

  expect(response.status).toBe(200)
  expect(capturedPayload?.prompt_cache_key).toBe("root")
})

test.each(["catalog", "live"])(
  "messages Chat Completions flow preserves PDFs supported by %s metadata",
  async (source) => {
    const selectedModel = createModel([])
    if (source === "live") {
      selectedModel.capabilities.limits.vision = {
        supported_media_types: ["application/pdf"],
      }
    }
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      "github-copilot": {
        models: {
          "gpt-test": {
            id: "gpt-test",
            modalities: {
              input: source === "catalog" ? ["text", "pdf"] : ["text"],
            },
          },
        },
      },
    })

    try {
      const response = await handleWithChatCompletions(
        createContext(),
        {
          model: "gpt-test",
          max_tokens: 128,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: "pdf-data",
                  },
                  title: "report.pdf",
                },
              ],
            },
          ],
        },
        { logger, requestId: "request-pdf", selectedModel },
      )

      expect(response.status).toBe(200)
      expect(capturedPayload?.messages[0]).toMatchObject({
        role: "user",
        content: [
          {
            type: "file",
            file: {
              file_data: "data:application/pdf;base64,pdf-data",
              filename: "report.pdf",
            },
          },
        ],
      })
    } finally {
      installModelsDevCatalog(modelsDevCatalogFixture)
    }
  },
)

test("messages Chat Completions flow adds Copilot cache control to system and latest non-system message", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-test",
    max_tokens: 128,
    system: [
      {
        type: "text",
        text: "system prompt",
      },
    ],
    messages: [
      { role: "user", content: "first user" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "second user",
          },
        ],
      },
      { role: "assistant", content: "older answer" },
      { role: "user", content: "latest user" },
      { role: "assistant", content: "latest answer" },
    ],
  }

  const response = await handleWithChatCompletions(createContext(), payload, {
    logger,
    requestId: "request-1",
  })

  expect(response.status).toBe(200)
  expect(createChatCompletions).toHaveBeenCalledTimes(1)
  expect(capturedPayload?.messages).toEqual([
    {
      role: "system",
      content: "system prompt",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
    {
      role: "user",
      content: "first user",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "second user",
        },
      ],
    },
    {
      role: "assistant",
      content: "older answer",
    },
    {
      role: "user",
      content: "latest user",
    },
    {
      role: "assistant",
      content: "latest answer",
      copilot_cache_control: {
        type: "ephemeral",
      },
    },
  ])
})

test("messages Chat Completions flow preserves supported reasoning effort", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-test",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    output_config: {
      effort: "medium",
    },
  }

  const response = await handleWithChatCompletions(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel([], {
      reasoningEffort: ["low", "medium", "high"],
    }),
  })

  expect(response.status).toBe(200)
  expect(capturedPayload?.reasoning_effort).toBe("medium")
})

test("messages Chat Completions flow downgrades unsupported reasoning effort", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-test",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    output_config: {
      effort: "xhigh",
    },
  }

  const response = await handleWithChatCompletions(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel([], {
      reasoningEffort: ["low", "medium", "high"],
    }),
  })

  expect(response.status).toBe(200)
  expect(capturedPayload?.reasoning_effort).toBe("high")
})

test("Messages 显式 effort 在能力未知时保留，在明确不支持时移除", async () => {
  const createPayload = (): AnthropicMessagesPayload => ({
    model: "gpt-test",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    output_config: {
      effort: "high",
    },
  })

  let response = await handleWithChatCompletions(
    createContext(),
    createPayload(),
    {
      logger,
      requestId: "request-1",
      selectedModel: createModel([]),
    },
  )

  expect(response.status).toBe(200)
  expect(capturedPayload?.reasoning_effort).toBe("high")

  capturedPayload = null
  createChatCompletions.mockClear()

  response = await handleWithChatCompletions(createContext(), createPayload(), {
    logger,
    requestId: "request-2",
    selectedModel: createModel([], {
      reasoningEffort: [],
    }),
  })

  expect(response.status).toBe(200)
  expect(capturedPayload).not.toHaveProperty("reasoning_effort")
})

test("messages Responses flow uses configured effort when request omits it", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-test",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
  }

  const effortSpy = spyOn(
    configModule,
    "getReasoningEffortForModel",
  ).mockReturnValue("high")

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses"]),
  })

  expect(response.status).toBe(200)
  expect(capturedResponsesPayload?.reasoning?.effort).toBe("high")
  effortSpy.mockRestore()
})

test("messages Responses flow maps request effort onto reasoning effort", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-test",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    output_config: { effort: "max" },
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses"]),
  })

  expect(response.status).toBe(200)
  expect(capturedResponsesPayload?.reasoning?.effort).toBe("xhigh")
})

test("messages Chat Completions flow emits an error event when the stream breaks during thinking output", async () => {
  createChatCompletions.mockImplementationOnce(
    (payload: ChatCompletionsPayload) => {
      capturedPayload = payload
      const stream = createChatCompletionsStream([
        {
          id: "chatcmpl-thinking-cut",
          object: "chat.completion.chunk",
          created: 0,
          model: payload.model,
          choices: [
            {
              index: 0,
              delta: { reasoning_text: "partial thought" },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        // The stream ends here: no [DONE], no finish_reason, no usage.
      ])
      return Promise.resolve(
        stream,
      ) as unknown as Promise<ChatCompletionResponse>
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithChatCompletions(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())
  const eventTypes = events.map((event) => event.event)

  expect(eventTypes).toContain("message_start")
  expect(eventTypes).toContain("content_block_delta")
  expect(eventTypes).not.toContain("message_stop")
  expect(events.at(-1)?.event).toBe("error")
  expect(JSON.parse(events.at(-1)?.data ?? "{}")).toEqual({
    type: "error",
    error: {
      message:
        "An unexpected error occurred during streaming, retry your request.",
      type: "api_error",
    },
  })
})

test("messages Chat Completions flow emits an error event when the upstream stream throws", async () => {
  createChatCompletions.mockImplementationOnce(
    (payload: ChatCompletionsPayload) => {
      capturedPayload = payload
      const stream = (async function* (): AsyncGenerator<{ data: string }> {
        await Promise.resolve()
        yield {
          data: JSON.stringify({
            id: "chatcmpl-throw",
            object: "chat.completion.chunk",
            created: 0,
            model: payload.model,
            choices: [
              {
                index: 0,
                delta: { content: "partial" },
                finish_reason: null,
                logprobs: null,
              },
            ],
          }),
        }
        throw new Error("upstream connection reset")
      })()
      return Promise.resolve(
        stream,
      ) as unknown as Promise<ChatCompletionResponse>
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithChatCompletions(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())
  const eventTypes = events.map((event) => event.event)

  expect(eventTypes).toContain("message_start")
  expect(eventTypes).not.toContain("message_stop")
  expect(events.at(-1)?.event).toBe("error")
})

test("messages Chat Completions flow ends without an error event on normal completion", async () => {
  createChatCompletions.mockImplementationOnce(
    (payload: ChatCompletionsPayload) => {
      capturedPayload = payload
      const stream = createChatCompletionsStream([
        {
          id: "chatcmpl-ok",
          object: "chat.completion.chunk",
          created: 0,
          model: payload.model,
          choices: [
            {
              index: 0,
              delta: { content: "hello" },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        {
          id: "chatcmpl-ok",
          object: "chat.completion.chunk",
          created: 0,
          model: payload.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        },
        "[DONE]",
      ])
      return Promise.resolve(
        stream,
      ) as unknown as Promise<ChatCompletionResponse>
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithChatCompletions(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())
  const eventTypes = events.map((event) => event.event)

  expect(eventTypes).toContain("message_delta")
  expect(eventTypes).toContain("message_stop")
  expect(eventTypes).not.toContain("error")
})

test("messages Chat Completions stream preserves Copilot AIU across metadata and usage chunks", async () => {
  createChatCompletions.mockImplementationOnce(
    (payload: ChatCompletionsPayload): Promise<ChatCompletionResponse> => {
      capturedPayload = payload
      return Promise.resolve(
        createMessagesStream([
          {
            event: "data",
            data: JSON.stringify({
              id: "chatcmpl-cost",
              object: "chat.completion.chunk",
              created: 0,
              model: payload.model,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant" },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
            }),
          },
          {
            event: "data",
            data: JSON.stringify({
              id: "chatcmpl-cost",
              object: "chat.completion.chunk",
              created: 0,
              model: payload.model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                  logprobs: null,
                },
              ],
            }),
          },
          {
            event: "data",
            data: JSON.stringify({
              id: "chatcmpl-cost",
              object: "chat.completion.chunk",
              created: 0,
              model: payload.model,
              choices: [],
              copilot_usage: {
                total_nano_aiu: 1_500_000,
              },
            }),
          },
          {
            event: "data",
            data: JSON.stringify({
              id: "chatcmpl-cost",
              object: "chat.completion.chunk",
              created: 0,
              model: payload.model,
              choices: [],
              copilot_usage: null,
              usage: {
                prompt_tokens: 5,
                completion_tokens: 1,
                total_tokens: 6,
              },
            }),
          },
        ]) as unknown as ChatCompletionResponse,
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gemini-3.6-flash",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithChatCompletions(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).toContain('"copilot_usage":{"total_nano_aiu":1500000}')

  const usageEvents = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })
  expect(usageEvents.items).toHaveLength(1)
  expect(usageEvents.items[0]).toMatchObject({
    cost: {
      amount: 0.000015,
      currency: "USD",
      source: "copilot_aiu",
      total_cost_nanos: 15_000,
    },
    input_tokens: 5,
    model: "gemini-3.6-flash",
    output_tokens: 1,
    total_nano_aiu: 1_500_000,
  })
})

const anthropicGenerationErrorSchema = z.looseObject({
  type: z.literal("error"),
  error: z.object({
    type: z.literal("api_error"),
    code: z.string().optional(),
    message: z.string().min(1),
  }),
})

const contentBlockIndexSchema = z.object({
  index: z.number().int().nonnegative(),
})

test.each([
  { failure: "finish_reason", output: "text", trailingUsage: false },
  { failure: "finish_reason", output: "tool", trailingUsage: true },
  { failure: "top_level", output: "text", trailingUsage: true },
  { failure: "top_level", output: "tool", trailingUsage: false },
  { failure: "finish_reason", output: "none", trailingUsage: false },
  { failure: "top_level", output: "none", trailingUsage: true },
  { failure: "finish_reason", output: "thinking", trailingUsage: true },
  { failure: "top_level", output: "thinking", trailingUsage: false },
] as const)(
  "Messages Chat fallback fails once on $failure after $output output with trailing usage $trailingUsage",
  async ({ failure, output, trailingUsage }) => {
    const upstreamError = {
      type: "server_error",
      code: "generation_failed",
      message: "The model could not generate a completion",
    }
    const metadata = {
      id: "chatcmpl-generation-failed",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-test",
    }
    const finalUsage = {
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      copilot_usage: { total_nano_aiu: 250_000 },
    }
    const failedChunk = {
      ...metadata,
      choices:
        failure === "finish_reason" ?
          [{ index: 0, delta: {}, finish_reason: "error", logprobs: null }]
        : [],
      ...(failure === "top_level" && { error: upstreamError }),
      ...(trailingUsage ?
        {
          usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
          copilot_usage: { total_nano_aiu: 100_000 },
        }
      : finalUsage),
    }
    const delta: ChatCompletionChunk["choices"][number]["delta"] =
      output === "tool" ?
        {
          tool_calls: [
            {
              index: 0,
              id: "call-partial",
              type: "function",
              function: { name: "weather", arguments: '{"city":' },
            },
          ],
        }
      : output === "thinking" ? { reasoning_text: "partial thought" }
      : { content: "partial answer" }
    const usageChunk = {
      ...metadata,
      choices: [],
      ...(trailingUsage ? finalUsage : {}),
    }
    const chunks = [
      ...(output === "none" ?
        []
      : [
          {
            ...metadata,
            choices: [{ index: 0, delta, finish_reason: null, logprobs: null }],
          },
        ]),
      failedChunk,
      failedChunk,
      {
        ...metadata,
        choices: [
          {
            index: 0,
            delta: { content: "must-not-appear" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      },
      usageChunk,
      usageChunk,
    ]
    messagesApiFlowDependencies.createChatCompletions = () =>
      Promise.resolve(
        createMessagesStream([
          ...chunks.map((chunk) => ({
            event: "message",
            data: JSON.stringify(chunk),
          })),
          { event: "message", data: "[DONE]" },
        ]),
      )
    let timing: RequestTiming | undefined
    const app = new Hono()
    app.use(traceIdMiddleware)
    app.use(requestEventsMiddleware(undefined, 4141))
    app.post("/v1/messages", (c) => {
      timing = requestContext.getStore()?.requestTiming
      return handleWithChatCompletions(
        c,
        {
          model: "gpt-test",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        },
        { logger, requestId: "request-generation-failed" },
      )
    })

    const response = await app.request("/v1/messages", { method: "POST" })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const body = await response.text()
    const events = parseSseEvents(body)
    const errors = events.filter((event) => event.event === "error")
    expect(errors).toHaveLength(1)
    const error = anthropicGenerationErrorSchema.parse(
      JSON.parse(errors[0].data),
    )
    if (failure === "top_level") {
      expect(error.error.message).toContain(upstreamError.message)
      expect(error.error.code).toBe(upstreamError.code)
    }
    expect(events.at(-1)?.event).toBe("error")
    expect(events.some((event) => event.event === "message_stop")).toBe(false)
    for (const event of events.filter(
      (event) => event.event === "message_delta",
    )) {
      expect(JSON.parse(event.data)).toHaveProperty("delta.stop_reason", null)
    }
    expect(body).not.toContain("must-not-appear")
    if (output !== "none") {
      expect(
        events.filter((event) => event.event === "content_block_start"),
      ).toHaveLength(1)
      expect(
        events.filter((event) => event.event === "content_block_delta").length,
      ).toBeGreaterThan(0)
      expect(body).toContain(
        output === "tool" ? "call-partial"
        : output === "thinking" ? "partial thought"
        : "partial answer",
      )
    }
    const startedBlocks = events
      .filter((event) => event.event === "content_block_start")
      .map(
        (event) => contentBlockIndexSchema.parse(JSON.parse(event.data)).index,
      )
    const stoppedBlocks = events
      .filter((event) => event.event === "content_block_stop")
      .map(
        (event) => contentBlockIndexSchema.parse(JSON.parse(event.data)).index,
      )
    expect(stoppedBlocks).toEqual(startedBlocks)
    expect(timing?.outcome).toBe("error")
    const usageEvents = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "today",
    })
    expect(usageEvents.items).toHaveLength(1)
    expect(usageEvents.items[0]).toMatchObject({
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      total_nano_aiu: 250_000,
    })
  },
)

test.each(["finish_reason", "top_level"] as const)(
  "Messages Chat fallback returns a JSON failure and records usage once for non-streaming %s",
  async (failure) => {
    const upstreamError = {
      type: "server_error",
      code: "generation_failed",
      message: "The model could not generate a completion",
    }
    messagesApiFlowDependencies.createChatCompletions = () =>
      Promise.resolve(
        attachResponseHeaders(
          {
            id: "chatcmpl-generation-failed",
            object: "chat.completion",
            created: 0,
            model: "gpt-test",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "partial answer" },
                finish_reason: failure === "finish_reason" ? "error" : "stop",
                logprobs: null,
              },
            ],
            ...(failure === "top_level" && { error: upstreamError }),
            usage: {
              prompt_tokens: 12,
              completion_tokens: 5,
              total_tokens: 17,
            },
            copilot_usage: { total_nano_aiu: 250_000 },
          } as unknown as ChatCompletionResponse,
          new Headers({ "x-ratelimit-remaining": "42" }),
        ),
      )
    let timing: RequestTiming | undefined
    const app = new Hono()
    app.use(traceIdMiddleware)
    app.use(requestEventsMiddleware(undefined, 4141))
    app.post("/v1/messages", (c) => {
      timing = requestContext.getStore()?.requestTiming
      return handleWithChatCompletions(
        c,
        {
          model: "gpt-test",
          max_tokens: 128,
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        },
        { logger, requestId: "request-generation-failed" },
      )
    })

    const response = await app.request("/v1/messages", { method: "POST" })
    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(response.status).toBeLessThan(600)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("x-ratelimit-remaining")).toBe("42")
    const body = anthropicGenerationErrorSchema.parse(await response.json())
    if (failure === "top_level") {
      expect(body.error.message).toContain(upstreamError.message)
      expect(body.error.code).toBe(upstreamError.code)
    }
    expect(body).not.toHaveProperty("stop_reason")
    expect(timing?.outcome).toBe("error")
    const usageEvents = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "today",
    })
    expect(usageEvents.items).toHaveLength(1)
    expect(usageEvents.items[0]).toMatchObject({
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      total_nano_aiu: 250_000,
    })
  },
)

test("messages Messages flow records Copilot AIU from streaming message delta", async () => {
  createMessages.mockImplementationOnce(
    (payload: AnthropicMessagesPayload): Promise<CreateMessagesReturn> => {
      capturedMessagesPayload = payload
      return Promise.resolve(
        createMessagesStream([
          {
            event: "message_start",
            data: JSON.stringify({
              message: {
                content: [],
                id: "msg-test",
                model: payload.model,
                role: "assistant",
                stop_reason: null,
                stop_sequence: null,
                type: "message",
                usage: {
                  input_tokens: 3,
                  output_tokens: 0,
                },
              },
              type: "message_start",
            }),
          },
          {
            event: "message_delta",
            data: JSON.stringify({
              copilot_usage: {
                total_nano_aiu: 4_119_900_000,
              },
              delta: {
                stop_reason: "end_turn",
                stop_sequence: null,
              },
              type: "message_delta",
              usage: {
                cache_creation_input_tokens: 10_612,
                cache_read_input_tokens: 0,
                input_tokens: 3,
                output_tokens: 93,
              },
            }),
          },
          {
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          },
        ]) as unknown as CreateMessagesReturn,
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "claude-sonnet-4.6",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithMessagesApi(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  await response.text()

  const usageEvents = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })

  expect(capturedMessagesPayload?.model).toBe("claude-sonnet-4.6")
  expect(usageEvents.items).toHaveLength(1)
  expect(usageEvents.items[0]).toMatchObject({
    cache_creation_input_tokens: 10_612,
    cache_read_input_tokens: 0,
    cost: {
      amount: 0.041199,
      currency: "USD",
      source: "copilot_aiu",
      total_cost_nanos: 41_199_000,
    },
    input_tokens: 3,
    model: "claude-sonnet-4.6",
    output_tokens: 93,
    total_nano_aiu: 4_119_900_000,
  })
})

test("messages Messages flow emits an error event when the stream ends without message_stop", async () => {
  createMessages.mockImplementationOnce(
    (payload: AnthropicMessagesPayload): Promise<CreateMessagesReturn> => {
      capturedMessagesPayload = payload
      return Promise.resolve(
        createMessagesStream([
          {
            event: "message_start",
            data: JSON.stringify({
              message: {
                content: [],
                id: "msg-cut",
                model: payload.model,
                role: "assistant",
                stop_reason: null,
                stop_sequence: null,
                type: "message",
                usage: {
                  input_tokens: 3,
                  output_tokens: 0,
                },
              },
              type: "message_start",
            }),
          },
          {
            event: "content_block_delta",
            data: JSON.stringify({
              delta: { text: "partial", type: "text_delta" },
              index: 0,
              type: "content_block_delta",
            }),
          },
          // The stream ends here: no message_stop and no [DONE].
        ]) as unknown as CreateMessagesReturn,
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "claude-sonnet-4.6",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithMessagesApi(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())
  const eventTypes = events.map((event) => event.event)

  expect(eventTypes).toContain("message_start")
  expect(eventTypes).not.toContain("message_stop")
  expect(events.at(-1)?.event).toBe("error")
  expect(JSON.parse(events.at(-1)?.data ?? "{}")).toEqual({
    type: "error",
    error: {
      message:
        "An unexpected error occurred during streaming, retry your request.",
      type: "api_error",
    },
  })
})

test("messages Messages flow emits an error event when the upstream stream throws", async () => {
  createMessages.mockImplementationOnce(
    (payload: AnthropicMessagesPayload): Promise<CreateMessagesReturn> => {
      capturedMessagesPayload = payload
      const stream = (async function* (): AsyncGenerator<{
        data: string
        event: string
      }> {
        await Promise.resolve()
        yield {
          event: "message_start",
          data: JSON.stringify({
            message: {
              content: [],
              id: "msg-throw",
              model: payload.model,
              role: "assistant",
              stop_reason: null,
              stop_sequence: null,
              type: "message",
              usage: {
                input_tokens: 3,
                output_tokens: 0,
              },
            },
            type: "message_start",
          }),
        }
        throw new Error("upstream connection reset")
      })()
      return Promise.resolve(stream)
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "claude-sonnet-4.6",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithMessagesApi(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())
  const eventTypes = events.map((event) => event.event)

  expect(eventTypes).toContain("message_start")
  expect(eventTypes).not.toContain("message_stop")
  expect(events.at(-1)?.event).toBe("error")
})

test("messages Messages flow forwards an upstream error event without appending another", async () => {
  const upstreamError = JSON.stringify({
    error: { message: "overloaded", type: "overloaded_error" },
    type: "error",
  })
  createMessages.mockImplementationOnce((): Promise<CreateMessagesReturn> =>
    Promise.resolve(
      createMessagesStream([
        {
          event: "error",
          data: upstreamError,
        },
        // The stream ends here without message_stop.
      ]) as unknown as CreateMessagesReturn,
    ),
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "claude-sonnet-4.6",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithMessagesApi(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())

  expect(events).toEqual([{ data: upstreamError, event: "error" }])
})

test("messages Messages flow ends without an error event on normal completion", async () => {
  createMessages.mockImplementationOnce(
    (payload: AnthropicMessagesPayload): Promise<CreateMessagesReturn> => {
      capturedMessagesPayload = payload
      return Promise.resolve(
        createMessagesStream([
          {
            event: "message_start",
            data: JSON.stringify({
              message: {
                content: [],
                id: "msg-ok",
                model: payload.model,
                role: "assistant",
                stop_reason: null,
                stop_sequence: null,
                type: "message",
                usage: {
                  input_tokens: 3,
                  output_tokens: 0,
                },
              },
              type: "message_start",
            }),
          },
          {
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          },
          {
            event: "message_stop",
            data: "[DONE]",
          },
        ]) as unknown as CreateMessagesReturn,
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "claude-sonnet-4.6",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithMessagesApi(c, payload, {
      logger,
      requestId: "request-1",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const eventTypes = parseSseEvents(await response.text()).map(
    (event) => event.event,
  )

  expect(eventTypes.filter((event) => event === "message_stop")).toHaveLength(1)
  expect(eventTypes).not.toContain("error")
})

test("messages Messages flow records Copilot AIU from non-streaming response", async () => {
  createMessages.mockImplementationOnce(
    (payload: AnthropicMessagesPayload): Promise<CreateMessagesReturn> => {
      capturedMessagesPayload = payload
      return Promise.resolve({
        ...createMessagesResult(payload.model),
        copilot_usage: {
          total_nano_aiu: 1_000_000_000,
        },
        usage: {
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 30,
          input_tokens: 12,
          output_tokens: 8,
        },
      })
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "claude-sonnet-4.6",
  }

  const response = await handleWithMessagesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
  })
  expect(response.status).toBe(200)
  await response.json()

  const usageEvents = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })

  expect(capturedMessagesPayload?.model).toBe("claude-sonnet-4.6")
  expect(usageEvents.items).toHaveLength(1)
  expect(usageEvents.items[0]).toMatchObject({
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 30,
    cost: {
      amount: 0.01,
      currency: "USD",
      source: "copilot_aiu",
      total_cost_nanos: 10_000_000,
    },
    input_tokens: 12,
    model: "claude-sonnet-4.6",
    output_tokens: 8,
    total_nano_aiu: 1_000_000_000,
  })
})

test("messages Responses flow uses websocket transport by default for dual-endpoint models", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses", "ws:/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesOptions?.transport).toBe("websocket")
})

test("messages Responses flow adds context management by default", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesPayload?.context_management).toEqual([
    {
      type: "compaction",
      compact_threshold: 108800,
    },
  ])
})

test("messages Responses flow disables context management for gpt-5.6 models", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-5.6-sol",
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesPayload?.context_management).toBeUndefined()
})

test("messages Responses flow keeps HTTP transport for dual-endpoint models when websocket is disabled", async () => {
  responsesApiWebSocketEnabled = false
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses", "ws:/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesOptions?.transport).toBe("http")
})

test("messages Responses flow keeps HTTP transport for compact requests", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "compact" }],
    model: "gpt-test",
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    compactType: COMPACT_REQUEST,
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses", "ws:/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesOptions?.transport).toBe("http")
})

test("messages Responses flow keeps HTTP transport for /responses-only models", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesOptions?.transport).toBe("http")
})

test("messages Responses flow keeps streaming transport for deferred tool search", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "fetch a page" }],
    model: "gpt-5.4",
    tools: [
      {
        name: "mcp__tool_search__search",
        input_schema: { type: "object" },
      },
      {
        name: "mcp__fetch__fetch",
        description: "Fetch a URL",
        input_schema: { type: "object" },
      },
    ],
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses", "ws:/responses"]),
  })

  expect(response.status).toBe(200)
  expect(createResponses).toHaveBeenCalledTimes(1)
  expect(capturedResponsesPayload?.stream).toBe(true)
  expect(capturedResponsesOptions?.transport).toBe("websocket")
})

test("messages Responses flow records top-level copilot_usage from terminal stream events", async () => {
  createResponses.mockImplementationOnce(
    (
      payload: ResponsesPayload,
      options: { transport?: ResponsesTransport },
    ) => {
      capturedResponsesPayload = payload
      capturedResponsesOptions = options
      return Promise.resolve(
        createMessagesStream([
          {
            event: "response.completed",
            data: JSON.stringify({
              type: "response.completed",
              copilot_usage: {
                token_details: [
                  {
                    batch_size: 1_000_000,
                    cost_per_batch: 25_000_000_000,
                    token_count: 4,
                    token_type: "input",
                  },
                  {
                    batch_size: 1_000_000,
                    cost_per_batch: 2_500_000_000,
                    token_count: 1,
                    token_type: "cache_read",
                  },
                  {
                    batch_size: 1_000_000,
                    cost_per_batch: 200_000_000_000,
                    token_count: 2,
                    token_type: "output",
                  },
                ],
                total_nano_aiu: 502_500,
              },
              response: {
                ...createResponsesResult(payload.model),
                usage: {
                  input_tokens: 5,
                  input_tokens_details: { cached_tokens: 1 },
                  output_tokens: 2,
                  total_tokens: 7,
                },
              },
            }),
          },
        ]),
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
  }

  const app = new Hono()
  app.post("/messages-responses", (c) =>
    handleWithResponsesApi(c, payload, {
      logger,
      requestId: "request-1",
      selectedModel: createModel(["/responses"]),
      sessionId: "stream-session",
    }),
  )
  app.route("/token-usage", tokenUsageRoute)

  const response = await app.request("/messages-responses", {
    method: "POST",
  })

  expect(response.status).toBe(200)
  await response.text()

  const eventsResponse = await app.request(
    "/token-usage/events?period=day&page=1&page_size=10",
  )
  expect(eventsResponse.status).toBe(200)

  const page = (await eventsResponse.json()) as {
    items: Array<{
      nano_cost_cache_read: number | null
      nano_cost_input: number | null
      nano_cost_output: number | null
      session_id: string
      total_nano_aiu: number | null
    }>
  }

  expect(page.items).toHaveLength(1)
  expect(page.items[0]?.session_id).toBe("stream-session")
  expect(page.items[0]?.nano_cost_cache_read).toBe(2_500)
  expect(page.items[0]?.nano_cost_input).toBe(100_000)
  expect(page.items[0]?.nano_cost_output).toBe(400_000)
  expect(page.items[0]?.total_nano_aiu).toBe(502_500)
})

test("messages Responses flow falls back to nested copilot_usage when top-level payload is empty", async () => {
  createResponses.mockImplementationOnce(
    (
      payload: ResponsesPayload,
      options: { transport?: ResponsesTransport },
    ) => {
      capturedResponsesPayload = payload
      capturedResponsesOptions = options
      return Promise.resolve(
        createMessagesStream([
          {
            event: "response.incomplete",
            data: JSON.stringify({
              type: "response.incomplete",
              copilot_usage: {},
              response: {
                ...createResponsesResult(payload.model),
                copilot_usage: {
                  token_details: [
                    {
                      batch_size: 1_000_000,
                      cost_per_batch: 12_500_000_000,
                      token_count: 3,
                      token_type: "input",
                    },
                  ],
                  total_nano_aiu: 37_500,
                },
                status: "incomplete",
                usage: {
                  input_tokens: 3,
                  output_tokens: 0,
                  total_tokens: 3,
                },
              },
            }),
          },
        ]),
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
  }

  const app = new Hono()
  app.post("/messages-responses", (c) =>
    handleWithResponsesApi(c, payload, {
      logger,
      requestId: "request-2",
      selectedModel: createModel(["/responses"]),
      sessionId: "nested-session",
    }),
  )
  app.route("/token-usage", tokenUsageRoute)

  const response = await app.request("/messages-responses", {
    method: "POST",
  })

  expect(response.status).toBe(200)
  await response.text()

  const eventsResponse = await app.request(
    "/token-usage/events?period=day&page=1&page_size=10",
  )
  expect(eventsResponse.status).toBe(200)

  const page = (await eventsResponse.json()) as {
    items: Array<{
      nano_cost_input: number | null
      session_id: string
      total_nano_aiu: number | null
    }>
  }

  expect(page.items).toHaveLength(1)
  expect(page.items[0]?.session_id).toBe("nested-session")
  expect(page.items[0]?.nano_cost_input).toBe(37_500)
  expect(page.items[0]?.total_nano_aiu).toBe(37_500)
})

test("messages Responses flow preserves the configured tool_search alias in non-streaming responses", async () => {
  createResponses.mockImplementationOnce(
    (
      payload: ResponsesPayload,
      options: { transport?: ResponsesTransport },
    ) => {
      capturedResponsesPayload = payload
      capturedResponsesOptions = options
      return Promise.resolve({
        ...createResponsesResult(payload.model),
        output: [
          {
            id: "search-1",
            type: "tool_search_call",
            call_id: "call_search",
            arguments: { names: ["mcp__fetch__fetch"] },
            status: "completed",
          },
        ],
      })
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "fetch a page" }],
    model: "gpt-5.4",
    tools: [
      {
        name: "tool_search_search",
        input_schema: { type: "object" },
      },
      {
        name: "mcp__fetch__fetch",
        description: "Fetch a URL",
        input_schema: { type: "object" },
      },
    ],
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-1",
    selectedModel: createModel(["/responses"]),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    id: "resp-test",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "call_search",
        name: "tool_search_search",
        input: {
          names: "mcp__fetch__fetch",
        },
      },
    ],
    model: "gpt-5.4",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
    copilot_usage: null,
  })
})

test("messages Responses flow stops on invalid JSON, emits an error, and records usage", async () => {
  const warnings: Array<Array<unknown>> = []
  createResponses.mockImplementationOnce(() =>
    Promise.resolve(
      createResponsesStream([
        {
          event: "response.created",
          data: JSON.stringify({
            response: {
              ...createResponsesResult("gpt-test"),
              status: "in_progress",
              usage: {
                input_tokens: 11,
                output_tokens: 4,
                total_tokens: 15,
              },
            },
            sequence_number: 1,
            type: "response.created",
          }),
        },
        { data: "not-json", event: "response.output_text.delta" },
        {
          data: JSON.stringify({
            response: {
              ...createResponsesResult("gpt-test"),
              output_text: "should-not-appear",
              usage: {
                input_tokens: 99,
                output_tokens: 99,
                total_tokens: 198,
              },
            },
            sequence_number: 3,
            type: "response.completed",
          }),
          event: "response.completed",
        },
      ]) as unknown as CreateResponsesReturn,
    ),
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithResponsesApi(c, payload, {
      logger: {
        ...logger,
        warn: (...args: Array<unknown>) => {
          warnings.push(args)
        },
      } as unknown as typeof logger,
      requestId: "request-invalid-json",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())

  expect(events.some((event) => event.event === "message_start")).toBe(true)
  expect(events.some((event) => event.data.includes("should-not-appear"))).toBe(
    false,
  )
  expect(events.at(-1)?.event).toBe("error")
  expect(JSON.parse(events.at(-1)?.data ?? "{}")).toEqual({
    error: {
      message: "Responses stream ended without completion, retry your request.",
      type: "api_error",
    },
    type: "error",
  })
  expect(
    warnings.some((warning) => String(warning[0]).includes("not valid JSON")),
  ).toBe(true)

  const usageEvents = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })
  expect(usageEvents.items).toHaveLength(1)
  expect(usageEvents.items[0]).toMatchObject({
    endpoint: "responses",
    input_tokens: 11,
    model: "gpt-test",
    output_tokens: 4,
    total_tokens: 15,
  })
})

test("messages Responses flow skips a [DONE] sentinel and keeps translating", async () => {
  createResponses.mockImplementationOnce(() =>
    Promise.resolve(
      createResponsesStream([
        {
          data: JSON.stringify({
            response: createResponsesResult("gpt-test"),
            sequence_number: 1,
            type: "response.created",
          }),
          event: "response.created",
        },
        { data: "[DONE]" },
        {
          data: JSON.stringify({
            content_index: 0,
            delta: "kept",
            item_id: "item-1",
            output_index: 0,
            sequence_number: 2,
            type: "response.output_text.delta",
          }),
          event: "response.output_text.delta",
        },
      ]) as unknown as CreateResponsesReturn,
    ),
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
    stream: true,
  }
  const app = new Hono()
  app.post("/", (c) =>
    handleWithResponsesApi(c, payload, {
      logger,
      requestId: "request-done",
    }),
  )

  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  const events = parseSseEvents(await response.text())
  const text = events
    .filter((event) => event.event === "content_block_delta")
    .map((event) => event.data)
    .join("\n")

  expect(text).toContain("kept")
  expect(events.at(-1)?.event).toBe("error")
  expect(events.some((event) => event.data.includes("not valid JSON"))).toBe(
    false,
  )
})

test.each(["completed", "failed", "throw", "invalid-json"] as const)(
  "messages Responses flow retains partial usage and token details on %s",
  async (ending) => {
    const warnings: Array<Array<unknown>> = []
    const tokenDetails = [
      {
        batch_size: 1_000_000,
        cost_per_batch: 25_000_000_000,
        token_count: 4,
        token_type: "input",
      },
    ]
    createResponses.mockImplementationOnce(() =>
      Promise.resolve(
        (async function* () {
          await Promise.resolve()
          yield {
            event: "response.created",
            data: JSON.stringify({
              type: "response.created",
              sequence_number: 1,
              response: {
                ...createResponsesResult("gpt-test"),
                status: "in_progress",
                usage: {
                  input_tokens: 11,
                  input_tokens_details: {
                    cached_tokens: 3,
                    cache_write_tokens: 2,
                  },
                  output_tokens: 4,
                  total_tokens: 15,
                },
                copilot_usage: {
                  token_details: tokenDetails,
                  total_nano_aiu: 100_000,
                },
              },
            }),
          }
          yield {
            event: "response.in_progress",
            data: JSON.stringify({
              type: "response.in_progress",
              sequence_number: 2,
              copilot_usage: { total_nano_aiu: 125_000 },
              response: {
                ...createResponsesResult("gpt-test"),
                status: "in_progress",
                usage: { output_tokens: 6 },
                copilot_usage: { total_nano_aiu: 999 },
              },
            }),
          }
          yield {
            event: "response.in_progress",
            data: JSON.stringify({
              type: "response.in_progress",
              sequence_number: 3,
              response: {
                ...createResponsesResult("gpt-test"),
                status: "in_progress",
                usage: { input_tokens_details: { cache_write_tokens: 4 } },
              },
            }),
          }
          yield {
            event: "response.in_progress",
            data: JSON.stringify({
              type: "response.in_progress",
              sequence_number: 4,
              response: createResponsesResult("gpt-test"),
            }),
          }
          if (ending === "throw") throw new Error("upstream connection reset")
          if (ending === "invalid-json") {
            yield { event: "response.output_text.delta", data: "not-json" }
            return
          }
          yield {
            event: `response.${ending}`,
            data: JSON.stringify({
              type: `response.${ending}`,
              sequence_number: 5,
              copilot_usage: {},
              response: {
                ...createResponsesResult("gpt-test"),
                status: ending,
                usage: {
                  input_tokens: 13,
                  total_tokens: 19,
                  input_tokens_details: { cache_write_tokens: 0 },
                },
                copilot_usage: { total_nano_aiu: 150_000 },
                error:
                  ending === "failed" ?
                    { code: "server_error", message: "upstream failed" }
                  : null,
              },
            }),
          }
        })() as unknown as CreateResponsesReturn,
      ),
    )
    const app = new Hono()
    app.post("/", (c) =>
      handleWithResponsesApi(
        c,
        {
          model: "gpt-test",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        },
        {
          logger: {
            ...logger,
            warn: (...args: Array<unknown>) => warnings.push(args),
          } as unknown as typeof logger,
          requestId: "request-partial-usage",
        },
      ),
    )
    const response = await app.request("/", { method: "POST" })
    const events = parseSseEvents(await response.text())
    const completed = ending === "completed"
    const terminal = completed || ending === "failed"
    expect(
      events.filter((event) => event.event === "message_stop"),
    ).toHaveLength(completed ? 1 : 0)
    expect(events.filter((event) => event.event === "error")).toHaveLength(
      completed ? 0 : 1,
    )
    if (!completed) expect(events.at(-1)?.event).toBe("error")
    if (ending === "throw" || ending === "invalid-json") {
      expect(
        warnings.some((warning) =>
          String(warning[0]).includes(
            ending === "throw" ? "interrupted" : "not valid JSON",
          ),
        ),
      ).toBe(true)
    }
    const usageEvents = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "today",
    })
    expect(usageEvents.items).toHaveLength(1)
    expect(usageEvents.items[0]).toMatchObject({
      endpoint: "responses",
      input_tokens: terminal ? 10 : 4,
      output_tokens: 6,
      total_tokens: terminal ? 19 : 15,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: terminal ? 0 : 4,
      total_nano_aiu: terminal ? 150_000 : 125_000,
      nano_cost_input: 100_000,
    })
  },
)

test.each(["throw", "invalid-json", "missing-stop"] as const)(
  "native Messages retains partial usage and emits one error on %s",
  async (ending) => {
    createMessages.mockImplementationOnce(() =>
      Promise.resolve(
        (async function* () {
          await Promise.resolve()
          yield {
            event: "message_start",
            data: JSON.stringify({
              type: "message_start",
              message: {
                ...createMessagesResult("claude-sonnet-4.6"),
                usage: {
                  input_tokens: 10,
                  cache_read_input_tokens: 2,
                  cache_creation_input_tokens: 3,
                },
              },
            }),
          }
          yield {
            event: "message_delta",
            data: JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 4 },
              copilot_usage: { total_nano_aiu: 123_000 },
            }),
          }
          if (ending === "throw") throw new Error("upstream connection reset")
          if (ending === "invalid-json") {
            yield { event: "content_block_delta", data: "not-json" }
          }
        })() as unknown as CreateMessagesReturn,
      ),
    )
    const app = new Hono()
    app.post("/", (c) =>
      handleWithMessagesApi(
        c,
        {
          model: "claude-sonnet-4.6",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        },
        { logger, requestId: "request-native-partial-usage" },
      ),
    )
    const response = await app.request("/", { method: "POST" })
    const events = parseSseEvents(await response.text())
    expect(
      events.filter((event) => event.event === "message_start"),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.event === "message_delta"),
    ).toHaveLength(1)
    expect(events.filter((event) => event.event === "error")).toHaveLength(1)
    expect(events.some((event) => event.event === "message_stop")).toBe(false)
    expect(events.at(-1)?.event).toBe("error")
    const usageEvents = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "today",
    })
    expect(usageEvents.items).toHaveLength(1)
    expect(usageEvents.items[0]).toMatchObject({
      endpoint: "messages",
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
      total_nano_aiu: 123_000,
    })
  },
)

test.each([
  { event: "message_delta", type: "error", failed: true },
  { event: "message_stop", type: "error", failed: true },
  { event: "error", type: "message_stop", failed: true },
  { event: "error", type: "ping", failed: true },
  { event: "message_delta", type: "message_stop", failed: false },
])(
  "native Messages attributes SSE $event / JSON $type without duplicating events",
  async ({ event, type, failed }) => {
    const data = JSON.stringify({
      type,
      ...(type === "error" && {
        error: { type: "overloaded_error", message: "upstream error" },
      }),
    })
    createMessages.mockImplementationOnce(() =>
      Promise.resolve(
        createMessagesStream([
          { event, data },
        ]) as unknown as CreateMessagesReturn,
      ),
    )
    const timing: RequestTiming = {
      id: "request-protocol-attribution",
      firstTokenMs: null,
      durationMs: null,
      outcome: null,
      hasUsage: false,
      recordFirstToken: () => {},
    }
    const app = new Hono()
    app.post("/", (c) =>
      requestContext.run(
        {
          traceId: "trace-protocol-attribution",
          startTime: Date.now(),
          userAgent: "test",
          sessionAffinity: undefined,
          parentSessionId: undefined,
          requestTiming: timing,
        },
        () =>
          handleWithMessagesApi(
            c,
            {
              model: "claude-sonnet-4.6",
              max_tokens: 128,
              stream: true,
              messages: [{ role: "user", content: "hello" }],
            },
            { logger, requestId: timing.id },
          ),
      ),
    )
    const response = await app.request("/", { method: "POST" })
    expect(parseSseEvents(await response.text())).toEqual([{ event, data }])
    expect(timing.protocolFailed === true).toBe(failed)
  },
)

const createModel = (
  supportedEndpoints: Array<string>,
  options: { reasoningEffort?: Array<string> } = {},
): Model => ({
  capabilities: {
    family: "gpt",
    limits: {
      max_prompt_tokens: 128000,
    },
    object: "model_capabilities",
    supports:
      options.reasoningEffort === undefined ?
        {}
      : { reasoning_effort: options.reasoningEffort },
    tokenizer: "o200k_base",
    type: "chat",
  },
  id: "gpt-test",
  model_picker_enabled: true,
  name: "gpt-test",
  object: "model",
  preview: false,
  supported_endpoints: supportedEndpoints,
  vendor: "openai",
  version: "1",
})

const createMessagesResult = (model: string): AnthropicResponse => ({
  content: [],
  id: "msg-test",
  model,
  role: "assistant",
  stop_reason: "end_turn",
  stop_sequence: null,
  type: "message",
  usage: {
    input_tokens: 0,
    output_tokens: 0,
  },
})

async function* createMessagesStream(
  events: Array<{ data: string; event: string }>,
): AsyncGenerator<{ data: string; event: string }> {
  for (const event of events) {
    await Promise.resolve()
    yield event
  }
}

async function* createResponsesStream(
  chunks: Array<{ data?: string; event?: string }>,
): AsyncGenerator<{ data?: string; event?: string }> {
  for (const chunk of chunks) {
    await Promise.resolve()
    yield chunk
  }
}

async function* createChatCompletionsStream(
  chunks: Array<ChatCompletionChunk | string>,
): AsyncGenerator<{ data: string }> {
  for (const chunk of chunks) {
    await Promise.resolve()
    yield { data: typeof chunk === "string" ? chunk : JSON.stringify(chunk) }
  }
}

const parseSseEvents = (
  text: string,
): Array<{ data: string; event: string }> => {
  const events: Array<{ data: string; event: string }> = []
  let eventName = ""
  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) {
      eventName = line.slice("event: ".length).trim()
    } else if (line.startsWith("data: ")) {
      events.push({ data: line.slice("data: ".length), event: eventName })
    }
  }
  return events
}

const createResponsesResult = (model: string): ResponsesResult => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response",
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

test("messages Chat Completions flow forwards upstream quota headers", async () => {
  createChatCompletions.mockImplementationOnce(
    (payload: ChatCompletionsPayload): Promise<ChatCompletionResponse> => {
      capturedPayload = payload
      return Promise.resolve(
        attachResponseHeaders(
          {
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 0,
            model: payload.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "ok",
                },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
          },
          new Headers({
            "x-quota-snapshot-premium_interactions": "ent=100;rem=75",
            "x-usage-ratelimit-session":
              "remaining=12;resetAt=2026-07-05T12:00:00.000Z",
          }),
        ),
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    model: "gpt-test",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
  }

  const response = await handleWithChatCompletions(createContext(), payload, {
    logger,
    requestId: "request-headers-chat",
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("x-quota-snapshot-premium_interactions")).toBe(
    "ent=100;rem=75",
  )
  expect(response.headers.get("x-usage-ratelimit-session")).toBe(
    "remaining=12;resetAt=2026-07-05T12:00:00.000Z",
  )
})

test("messages Responses flow forwards upstream quota headers", async () => {
  createResponses.mockImplementationOnce(
    (
      payload: ResponsesPayload,
      options: { transport?: ResponsesTransport },
    ) => {
      capturedResponsesPayload = payload
      capturedResponsesOptions = options
      return Promise.resolve(
        attachResponseHeaders(
          {
            ...createResponsesResult(payload.model),
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
            },
          },
          new Headers({
            "x-quota-snapshot-premium_interactions": "ent=200;rem=50",
            "x-usage-ratelimit-weekly":
              "remaining=6;resetAt=2026-07-07T12:00:00.000Z",
          }),
        ),
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-test",
  }

  const response = await handleWithResponsesApi(createContext(), payload, {
    logger,
    requestId: "request-headers-responses",
    selectedModel: createModel(["/responses"]),
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("x-quota-snapshot-premium_interactions")).toBe(
    "ent=200;rem=50",
  )
  expect(response.headers.get("x-usage-ratelimit-weekly")).toBe(
    "remaining=6;resetAt=2026-07-07T12:00:00.000Z",
  )
})

test("messages Messages flow forwards upstream quota headers", async () => {
  createMessages.mockImplementationOnce(
    (payload: AnthropicMessagesPayload): Promise<CreateMessagesReturn> => {
      capturedMessagesPayload = payload
      return Promise.resolve(
        attachResponseHeaders(
          {
            ...createMessagesResult(payload.model),
            usage: {
              input_tokens: 12,
              output_tokens: 8,
            },
          },
          new Headers({
            "x-quota-snapshot-premium_interactions": "ent=300;rem=60",
            "x-usage-ratelimit-session":
              "remaining=4;resetAt=2026-07-05T14:00:00.000Z",
          }),
        ),
      )
    },
  )

  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: "claude-sonnet-4.6",
  }

  const response = await handleWithMessagesApi(createContext(), payload, {
    logger,
    requestId: "request-headers-messages",
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("x-quota-snapshot-premium_interactions")).toBe(
    "ent=300;rem=60",
  )
  expect(response.headers.get("x-usage-ratelimit-session")).toBe(
    "remaining=4;resetAt=2026-07-05T14:00:00.000Z",
  )
})
