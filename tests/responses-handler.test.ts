import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono, type Context } from "hono"

import { attachResponseHeaders } from "../src/lib/response-headers"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/types/anthropic"
import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
  ChatCompletionResponse,
} from "~/lib/types/chat-completions"
import type {
  ResponseInputReasoning,
  ResponsesResult,
} from "~/lib/types/responses"
import type { CompletionPayloadOptions } from "~/routes/messages/handler"
import {
  encodeMessagesCompaction,
  MESSAGES_TOOL_CALL_TIPS,
} from "~/routes/responses/messages-translation"
import type { createResponses as createCopilotResponses } from "~/services/copilot/create-responses"

let responsesApiWebSocketEnabled = true

const createResponses = mock<typeof createCopilotResponses>(() =>
  Promise.resolve(streamChunks([])),
)

const createResponsesResult = (model: string) => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response" as const,
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

const createReasoningResult = (
  model: string,
  id: string,
  encryptedContent: string,
): ResponsesResult => ({
  ...createResponsesResult(model),
  output: [
    {
      id,
      type: "reasoning",
      status: "completed",
      summary: [],
      encrypted_content: encryptedContent,
    },
    {
      id: `msg-${id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: `Answer from ${model}`, annotations: [] },
      ],
    },
  ],
})

const getMessageBlocks = (
  payload: AnthropicMessagesPayload | undefined,
): Array<Record<string, unknown>> =>
  payload?.messages.flatMap((message): Array<Record<string, unknown>> =>
    Array.isArray(message.content) ?
      (message.content as unknown as Array<Record<string, unknown>>)
    : [],
  ) ?? []

const getThinkingSignatures = (
  payload: AnthropicMessagesPayload | undefined,
): Array<unknown> =>
  getMessageBlocks(payload)
    .filter((block) => block.type === "thinking")
    .map((block) => block.signature)

const createMessagesResponse = (
  content: AnthropicResponse["content"],
): Response =>
  Response.json({
    content,
    id: "msg-switch",
    model: "claude-test",
    role: "assistant",
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 8, output_tokens: 2 },
  })

const { state } = await import("~/lib/state")
const { closeUsageStore } = await import("~/lib/token-usage")
const { tokenUsageRoute } = await import("~/routes/token-usage/route")
const { responsesHandlerDependencies } =
  await import("~/routes/responses/handler")
const { responsesMessagesDependencies } =
  await import("~/routes/responses/messages-handler")
const { responsesChatDependencies } =
  await import("~/routes/responses/chat-handler")
const { responsesRoutes } = await import("~/routes/responses/route")
const { responsesUtilsDependencies } = await import("~/routes/responses/utils")
const { generateRequestIdFromPayload, getUUID } = await import("~/lib/utils")

const defaultResponsesHandlerDependencies = {
  ...responsesHandlerDependencies,
}
const defaultResponsesMessagesDependencies = {
  ...responsesMessagesDependencies,
}
const defaultResponsesChatDependencies = { ...responsesChatDependencies }
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  macMachineId: state.macMachineId,
  models: state.models,
  verbose: state.verbose,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}

function createApp(): Hono {
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  app.route("/token-usage", tokenUsageRoute)
  return app
}

async function* streamChunks(items: Array<Record<string, unknown>>) {
  await Promise.resolve()
  for (const item of items) {
    yield item
  }
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()

  state.copilotToken = "test-token"
  state.accountType = "individual"
  state.macMachineId = "machine-1"
  state.verbose = false
  state.vsCodeDeviceId = "device-1"
  state.vsCodeSessionId = "session-1"
  state.vsCodeVersion = "1.120.0"
  state.models = {
    object: "list",
    data: [
      {
        capabilities: {
          limits: {
            max_prompt_tokens: 128000,
          },
        },
        id: "gpt-responses-test",
        supported_endpoints: ["/responses"],
      },
    ],
  } as typeof state.models

  responsesApiWebSocketEnabled = true
  responsesHandlerDependencies.findEndpointModel = (model) =>
    state.models?.data.find((candidate) => candidate.id === model) ?? undefined
  responsesHandlerDependencies.createResponses = createResponses
  responsesHandlerDependencies.findEndpointModel = (model) =>
    state.models?.data.find((candidate) => candidate.id === model)
  responsesHandlerDependencies.isResponsesApiWebSearchEnabled = () => true
  responsesHandlerDependencies.resolveMappedModel = (model) => model
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    undefined
  responsesUtilsDependencies.isContextManagementEnabledForMessages = () => true
  responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
    false
  responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () =>
    responsesApiWebSocketEnabled
  responsesMessagesDependencies.handleCompletionPayload = mock(
    (_context: Context, payload: AnthropicMessagesPayload) =>
      Promise.resolve(
        Response.json({
          content: [{ text: "hi", type: "text" }],
          id: "msg_fallback",
          model: payload.model,
          role: "assistant",
          stop_reason: "end_turn",
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
  )
  createResponses.mockReset()
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)

  state.copilotToken = originalState.copilotToken
  state.accountType = originalState.accountType
  state.macMachineId = originalState.macMachineId
  state.verbose = originalState.verbose
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeSessionId = originalState.vsCodeSessionId
  state.vsCodeVersion = originalState.vsCodeVersion
  state.models = originalState.models
  Object.assign(
    responsesHandlerDependencies,
    defaultResponsesHandlerDependencies,
  )
  Object.assign(
    responsesMessagesDependencies,
    defaultResponsesMessagesDependencies,
  )
  Object.assign(responsesChatDependencies, defaultResponsesChatDependencies)
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
})

describe("responses reasoning transport isolation", () => {
  test("keeps only Messages reasoning when switching to a Messages model", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: { limits: { max_prompt_tokens: 128000 } },
          id: "claude-test",
          supported_endpoints: ["/v1/messages"],
        },
      ],
    } as typeof state.models
    const handleMessages = mock(
      (_context: Context, _payload: AnthropicMessagesPayload) =>
        Promise.resolve(
          createMessagesResponse([{ type: "text", text: "done" }]),
        ),
    )
    responsesMessagesDependencies.handleCompletionPayload = handleMessages

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "claude-test",
        input: [
          {
            id: "rs_native",
            type: "reasoning",
            summary: [],
            encrypted_content: "native-reasoning",
          },
          {
            role: "assistant",
            type: "message",
            content: "Visible answer",
          },
          {
            id: "rs_messages__a1",
            type: "reasoning",
            summary: [],
            encrypted_content: "messages-reasoning",
          },
          {
            type: "function_call",
            call_id: "call-1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
          {
            type: "function_call_output",
            call_id: "call-1",
            output: "file contents",
          },
          { role: "user", type: "message", content: "Continue" },
        ],
        tools: [
          {
            type: "function",
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object" },
            strict: false,
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
        "session-id": "switch-session",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const forwarded = handleMessages.mock.calls[0]?.[1]
    const blocks = getMessageBlocks(forwarded)
    expect(getThinkingSignatures(forwarded)).toEqual(["messages-reasoning"])
    expect(blocks).toContainEqual({ type: "text", text: "Visible answer" })
    expect(
      blocks.some(
        (block) => block.type === "tool_use" && block.id === "call-1",
      ),
    ).toBe(true)
    expect(
      blocks.some(
        (block) =>
          block.type === "tool_result" && block.content === "file contents",
      ),
    ).toBe(true)
  })

  for (const [name, models] of [
    [
      "Responses to Messages to Responses",
      ["gpt-test", "claude-test", "gpt-test"],
    ],
    [
      "Messages to Responses to Messages",
      ["claude-test", "gpt-test", "claude-test"],
    ],
  ] as const) {
    test(`round-trips retained client history from ${name}`, async () => {
      state.models = {
        object: "list",
        data: [
          {
            capabilities: { limits: { max_prompt_tokens: 128000 } },
            id: "gpt-test",
            supported_endpoints: ["/responses"],
          },
          {
            capabilities: { limits: { max_prompt_tokens: 128000 } },
            id: "claude-test",
            supported_endpoints: ["/v1/messages"],
          },
        ],
      } as typeof state.models
      createResponses.mockImplementation((payload) =>
        Promise.resolve(
          createReasoningResult(payload.model, "rs_native", "native-reasoning"),
        ),
      )
      const handleMessages = mock(
        (_context: Context, _payload: AnthropicMessagesPayload) =>
          Promise.resolve(
            createMessagesResponse([
              {
                type: "thinking",
                thinking: "Messages reasoning",
                signature: "messages-reasoning",
              },
              { type: "text", text: "Answer from claude-test" },
            ]),
          ),
      )
      responsesMessagesDependencies.handleCompletionPayload = handleMessages

      const history: Array<unknown> = []
      for (const [index, model] of models.entries()) {
        history.push({
          role: "user",
          type: "message",
          content: `Turn ${index + 1}`,
        })
        const response = await createApp().request("/v1/responses", {
          body: JSON.stringify({ model, input: history }),
          headers: {
            "content-type": "application/json",
            "session-id": "round-trip-session",
          },
          method: "POST",
        })

        expect(response.status).toBe(200)
        const result = (await response.json()) as ResponsesResult
        history.push(...result.output)
      }
      if (models[0] === "gpt-test") {
        const replayedInput = createResponses.mock.calls[1]?.[0].input
        const reasoningItems =
          Array.isArray(replayedInput) ?
            replayedInput.filter(
              (item): item is ResponseInputReasoning =>
                item.type === "reasoning",
            )
          : []
        expect(
          reasoningItems.map(({ encrypted_content }) => encrypted_content),
        ).toEqual(["native-reasoning"])
        expect(
          getThinkingSignatures(handleMessages.mock.calls[0]?.[1]),
        ).toEqual([])
      } else {
        const switchedInput = createResponses.mock.calls[0]?.[0].input
        expect(
          Array.isArray(switchedInput)
            && switchedInput.some((item) => item.type === "reasoning"),
        ).toBe(false)
        expect(
          getThinkingSignatures(handleMessages.mock.calls[1]?.[1]),
        ).toEqual(["messages-reasoning"])
      }
    })
  }
})

describe("responses handler token usage", () => {
  test("routes a Messages-only Copilot model through the Responses Lite adapter", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            family: "claude",
            limits: { max_prompt_tokens: 128000 },
            object: "model_capabilities",
            supports: { tool_calls: true },
            tokenizer: "o200k_base",
            type: "chat",
          },
          id: "claude-test",
          model_picker_enabled: true,
          name: "Claude Test",
          object: "model",
          preview: false,
          supported_endpoints: ["/v1/messages"],
          vendor: "anthropic",
          version: "test",
        },
      ],
    }
    const handleMessages = mock(
      (_context: Context, _payload: AnthropicMessagesPayload) =>
        Promise.resolve(
          Response.json({
            content: [
              {
                type: "tool_use",
                id: "call-patch",
                name: "apply_patch",
                input: { input: "*** Begin Patch" },
              },
            ],
            id: "msg-lite",
            model: "claude-test",
            role: "assistant",
            stop_reason: "tool_use",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 8, output_tokens: 4 },
          }),
        ),
    )
    responsesMessagesDependencies.handleCompletionPayload = handleMessages

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "claude-test",
        input: [
          {
            role: "developer",
            type: "additional_tools",
            tools: [{ type: "custom", name: "apply_patch" }],
          },
          { role: "user", type: "message", content: "Patch it" },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).not.toHaveBeenCalled()
    expect(handleMessages).toHaveBeenCalledTimes(1)
    expect(handleMessages.mock.calls[0]?.[1].tools?.[0]?.name).toBe(
      "apply_patch",
    )
    const body = (await response.json()) as { output: Array<unknown> }
    expect(body.output[0]).toEqual(
      expect.objectContaining({
        type: "custom_tool_call",
        call_id: "call-patch",
        name: "apply_patch",
        input: "*** Begin Patch",
      }),
    )
  })

  test("forwards session, request, and subagent context to the Messages adapter", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            family: "claude",
            limits: { max_prompt_tokens: 128000 },
            object: "model_capabilities",
            supports: { tool_calls: true },
            tokenizer: "o200k_base",
            type: "chat",
          },
          id: "claude-test",
          model_picker_enabled: true,
          name: "Claude Test",
          object: "model",
          preview: false,
          supported_endpoints: ["/v1/messages"],
          vendor: "anthropic",
          version: "test",
        },
      ],
    }
    const handleMessages = mock(
      (
        _context: Context,
        _payload: AnthropicMessagesPayload,
        _options?: CompletionPayloadOptions,
      ) =>
        Promise.resolve(
          Response.json({
            content: [{ type: "text", text: "hi" }],
            id: "msg-context",
            model: "claude-test",
            role: "assistant",
            stop_reason: "end_turn",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
        ),
    )
    responsesMessagesDependencies.handleCompletionPayload = handleMessages

    const payload = {
      input: [{ content: "Patch it", role: "user", type: "message" }],
      model: "claude-test",
    }

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-openai-subagent": "collab_spawn",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(handleMessages).toHaveBeenCalledTimes(1)

    const dispatchOptions = handleMessages.mock.calls[0]?.[2]
    const expectedSessionId = getUUID("root-session")
    expect(dispatchOptions?.sessionId).toBe(expectedSessionId)
    expect(dispatchOptions?.requestId).toBe(
      generateRequestIdFromPayload(
        { messages: payload.input },
        expectedSessionId,
      ),
    )
    expect(dispatchOptions?.subagentMarker).toEqual({
      agent_id: "child-thread",
      agent_type: "collab_spawn",
      session_id: "child-thread",
    })
  })

  test("rejects gpt-prefixed models without Responses endpoint support for Codex clients", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            family: "gpt",
            limits: { max_prompt_tokens: 128000 },
            object: "model_capabilities",
            supports: { tool_calls: true },
            tokenizer: "o200k_base",
            type: "chat",
          },
          id: "gpt-messages-only",
          model_picker_enabled: true,
          name: "GPT Messages Only",
          object: "model",
          preview: false,
          supported_endpoints: ["/v1/messages", "/chat/completions"],
          vendor: "openai",
          version: "test",
        },
      ],
    }
    const handleMessages = mock(
      (_context: Context, _payload: AnthropicMessagesPayload) =>
        Promise.resolve(Response.json({})),
    )
    responsesMessagesDependencies.handleCompletionPayload = handleMessages

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "gpt-messages-only",
        input: "hello",
      }),
      headers: {
        "content-type": "application/json",
        "user-agent": "codex-cli/1.0.0",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(createResponses).not.toHaveBeenCalled()
    expect(handleMessages).not.toHaveBeenCalled()
    const body = (await response.json()) as {
      error: { message: string; type: string }
    }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain(
      "This model does not support the responses endpoint",
    )
  })

  test("routes codex-prefixed models through the native Responses API for Codex clients", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            family: "codex",
            limits: { max_prompt_tokens: 128000 },
            object: "model_capabilities",
            supports: { tool_calls: true },
            tokenizer: "o200k_base",
            type: "chat",
          },
          id: "codex-mini-latest",
          model_picker_enabled: true,
          name: "Codex Mini Latest",
          object: "model",
          preview: false,
          supported_endpoints: ["/responses"],
          vendor: "openai",
          version: "test",
        },
      ],
    }
    const handleMessages = mock(
      (_context: Context, _payload: AnthropicMessagesPayload) =>
        Promise.resolve(Response.json({})),
    )
    responsesMessagesDependencies.handleCompletionPayload = handleMessages
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "codex-mini-latest",
        input: "hello",
      }),
      headers: {
        "content-type": "application/json",
        "user-agent": "codex-cli/1.0.0",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(handleMessages).not.toHaveBeenCalled()
  })

  test("routes non-gpt models without fallback endpoints through the Messages adapter for Codex clients", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            family: "claude",
            limits: { max_prompt_tokens: 128000 },
            object: "model_capabilities",
            supports: { tool_calls: true },
            tokenizer: "o200k_base",
            type: "chat",
          },
          id: "claude-no-endpoints",
          model_picker_enabled: true,
          name: "Claude No Endpoints",
          object: "model",
          preview: false,
          supported_endpoints: [],
          vendor: "anthropic",
          version: "test",
        },
      ],
    }
    const handleMessages = mock(
      (_context: Context, _payload: AnthropicMessagesPayload) =>
        Promise.resolve(
          Response.json({
            content: [{ type: "text", text: "hi" }],
            id: "msg-codex",
            model: "claude-no-endpoints",
            role: "assistant",
            stop_reason: "end_turn",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
        ),
    )
    responsesMessagesDependencies.handleCompletionPayload = handleMessages

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "claude-no-endpoints",
        input: "hello",
      }),
      headers: {
        "content-type": "application/json",
        "user-agent": "codex-cli/1.0.0",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).not.toHaveBeenCalled()
    expect(handleMessages).toHaveBeenCalledTimes(1)
  })

  test("routes non-gpt models with native Responses support through the Messages adapter for Codex clients", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            family: "claude",
            limits: { max_prompt_tokens: 128000 },
            object: "model_capabilities",
            supports: { tool_calls: true },
            tokenizer: "o200k_base",
            type: "chat",
          },
          id: "claude-responses",
          model_picker_enabled: true,
          name: "Claude Responses",
          object: "model",
          preview: false,
          supported_endpoints: ["/responses"],
          vendor: "anthropic",
          version: "test",
        },
      ],
    }
    const handleMessages = mock(
      (_context: Context, _payload: AnthropicMessagesPayload) =>
        Promise.resolve(
          Response.json({
            content: [{ type: "text", text: "hi" }],
            id: "msg-codex-native",
            model: "claude-responses",
            role: "assistant",
            stop_reason: "end_turn",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
        ),
    )
    responsesMessagesDependencies.handleCompletionPayload = handleMessages

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "claude-responses",
        input: "hello",
      }),
      headers: {
        "content-type": "application/json",
        "user-agent": "codex-cli/1.0.0",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).not.toHaveBeenCalled()
    expect(handleMessages).toHaveBeenCalledTimes(1)
  })

  test("injects tool call tips into the Messages adapter only for Codex clients", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            family: "claude",
            limits: { max_prompt_tokens: 128000 },
            object: "model_capabilities",
            supports: { tool_calls: true },
            tokenizer: "o200k_base",
            type: "chat",
          },
          id: "claude-tips",
          model_picker_enabled: true,
          name: "Claude Tips",
          object: "model",
          preview: false,
          supported_endpoints: ["/v1/messages"],
          vendor: "anthropic",
          version: "test",
        },
      ],
    }
    const handleMessages = mock(
      (_context: Context, _payload: AnthropicMessagesPayload) =>
        Promise.resolve(
          Response.json({
            content: [{ type: "text", text: "hi" }],
            id: "msg-tips",
            model: "claude-tips",
            role: "assistant",
            stop_reason: "end_turn",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
        ),
    )
    responsesMessagesDependencies.handleCompletionPayload = handleMessages

    const app = createApp()
    const codexResponse = await app.request("/v1/responses", {
      body: JSON.stringify({
        model: "claude-tips",
        instructions: "Base instructions",
        input: "hello",
      }),
      headers: {
        "content-type": "application/json",
        "user-agent": "codex-cli/1.0.0",
      },
      method: "POST",
    })
    const otherResponse = await app.request("/v1/responses", {
      body: JSON.stringify({
        model: "claude-tips",
        instructions: "Base instructions",
        input: "hello",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(codexResponse.status).toBe(200)
    expect(otherResponse.status).toBe(200)
    expect(handleMessages).toHaveBeenCalledTimes(2)
    expect(handleMessages.mock.calls[0]?.[1].system).toEqual([
      {
        type: "text",
        text: `Base instructions\n\n${MESSAGES_TOOL_CALL_TIPS}`,
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(handleMessages.mock.calls[1]?.[1].system).toEqual([
      {
        type: "text",
        text: "Base instructions",
        cache_control: { type: "ephemeral" },
      },
    ])
  })

  test("rejects models without fallback endpoints for non-Codex clients", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            family: "claude",
            limits: { max_prompt_tokens: 128000 },
            object: "model_capabilities",
            supports: { tool_calls: true },
            tokenizer: "o200k_base",
            type: "chat",
          },
          id: "claude-no-endpoints",
          model_picker_enabled: true,
          name: "Claude No Endpoints",
          object: "model",
          preview: false,
          supported_endpoints: [],
          vendor: "anthropic",
          version: "test",
        },
      ],
    }
    const handleMessages = mock(
      (_context: Context, _payload: AnthropicMessagesPayload) =>
        Promise.resolve(Response.json({})),
    )
    responsesMessagesDependencies.handleCompletionPayload = handleMessages

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "claude-no-endpoints",
        input: "hello",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(createResponses).not.toHaveBeenCalled()
    expect(handleMessages).not.toHaveBeenCalled()
    const body = (await response.json()) as {
      error: { message: string; type: string }
    }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain(
      "This model does not support the responses endpoint",
    )
  })

  test("uses websocket transport by default for dual-endpoint models", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "gpt-responses-test",
          supported_endpoints: ["/responses", "ws:/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-responses-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.transport).toBe("websocket")
    expect(createResponses.mock.calls[0][1]?.initiator).toBe("user")
    expect(createResponses.mock.calls[0][1]?.subagentMarker).toBeNull()
  })

  test("keeps HTTP transport for dual-endpoint models when websocket is disabled", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "gpt-responses-test",
          supported_endpoints: ["/responses", "ws:/responses"],
        },
      ],
    } as typeof state.models
    responsesApiWebSocketEnabled = false
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-responses-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.transport).toBe("http")
  })

  test("keeps HTTP transport when the selected model only supports /responses", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-responses-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.transport).toBe("http")
  })

  test("normalizes unsupported max reasoning effort to the highest supported level", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: { max_prompt_tokens: 128000 },
            supports: {
              reasoning_effort: ["low", "medium", "high", "xhigh"],
            },
          },
          id: "gpt-capability-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-capability-test",
        reasoning: { effort: "max" },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].reasoning).toEqual({
      effort: "xhigh",
    })
  })

  test("maps ultra reasoning effort to max when max is supported", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: { max_prompt_tokens: 128000 },
            supports: {
              reasoning_effort: [
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
          },
          id: "gpt-ultra-capability",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-ultra-capability",
        reasoning: { effort: "ultra" },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].reasoning).toEqual({
      effort: "max",
    })
  })

  test("preserves max reasoning effort when capabilities are unknown", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-responses-test",
        reasoning: { effort: "max" },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].reasoning).toEqual({
      effort: "max",
    })
  })

  test("maps ultra reasoning effort to max when capabilities are unknown", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-responses-test",
        reasoning: { effort: "ultra" },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].reasoning).toEqual({
      effort: "max",
    })
  })

  test("preserves unknown reasoning effort for upstream validation", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-responses-test",
        reasoning: { effort: "turbo" },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(
      (createResponses.mock.calls[0][0].reasoning as { effort?: string })
        ?.effort,
    ).toBe("turbo")
  })

  test("preserves supported max reasoning effort for native Responses", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: { max_prompt_tokens: 128000 },
            supports: {
              reasoning_effort: [
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
          },
          id: "gpt-max-capability",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-max-capability",
        reasoning: { effort: "max" },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].reasoning).toEqual({
      effort: "max",
    })
  })

  for (const [transport, supportedEndpoints] of [
    ["http", ["/responses"]],
    ["websocket", ["/responses", "ws:/responses"]],
  ] as const) {
    test(`sanitizes unsupported Copilot input fields before the ${transport} transport`, async () => {
      state.models = {
        object: "list",
        data: [
          {
            capabilities: { limits: { max_prompt_tokens: 128000 } },
            id: "gpt-test",
            supported_endpoints: [...supportedEndpoints],
          },
        ],
      } as typeof state.models
      createResponses.mockImplementation((payload) =>
        Promise.resolve(createResponsesResult(payload.model)),
      )

      const response = await createApp().request("/v1/responses", {
        body: JSON.stringify({
          input: [
            {
              content: "hello",
              internal_chat_message_metadata_passthrough: {
                private: "must-not-be-forwarded",
              },
              role: "user",
            },
          ],
          model: "gpt-test",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(createResponses).toHaveBeenCalledTimes(1)
      expect(createResponses.mock.calls[0][1]?.transport).toBe(transport)
      expect(createResponses.mock.calls[0][1]?.clientSignal).toBeInstanceOf(
        AbortSignal,
      )
      expect(createResponses.mock.calls[0][0].input).toEqual([
        { content: "hello", role: "user" },
      ])
    })
  }

  test("does not add context management to native Responses API by default", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-responses-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toBeUndefined()
  })

  test("uses model Responses API compact threshold before max token fallback", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "gpt-responses-threshold-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    responsesUtilsDependencies.getModelResponsesApiCompactThreshold = (
      model,
    ) => (model === "gpt-responses-threshold-test" ? 272_000 * 0.8 : undefined)
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-responses-threshold-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toEqual([
      {
        type: "compaction",
        compact_threshold: 217600,
      },
    ])
  })

  test("does not add context management when input ends with compaction trigger", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const latestInput = {
      content: "Continue after the latest compaction.",
      role: "user",
    }
    const compactionTrigger = {
      type: "compaction_trigger",
    }
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "old content before compaction",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: [
              {
                text: "Completed the review for the latest two commits.",
                type: "output_text",
              },
            ],
            phase: "final_answer",
            role: "assistant",
            type: "message",
          },
          latestInput,
          compactionTrigger,
        ],
        model: "gpt-responses-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toBeUndefined()
    expect(createResponses.mock.calls[0][0].input).toEqual([
      {
        encrypted_content: "cipher",
        id: "compaction-1",
        type: "compaction",
      },
      {
        content: [
          {
            text: "Completed the review for the latest two commits.",
            type: "output_text",
          },
        ],
        phase: "final_answer",
        role: "assistant",
        type: "message",
      },
      latestInput,
      compactionTrigger,
    ])
  })

  test("does not compact input ending with compaction trigger when context management is disabled", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const input = [
      {
        content: "old content before compaction",
        role: "user",
      },
      {
        encrypted_content: "cipher",
        id: "compaction-1",
        type: "compaction",
      },
      {
        content: "Continue after the latest compaction.",
        role: "user",
      },
      {
        type: "compaction_trigger",
      },
    ]

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input,
        model: "gpt-responses-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toBeUndefined()
    expect(createResponses.mock.calls[0][0].input).toEqual(input)
  })

  test("preserves custom apply_patch tools for Copilot Responses", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )
    const applyPatchTool = {
      type: "custom",
      name: "apply_patch",
      description: "Edit files with a patch",
      format: {
        type: "grammar",
        syntax: "lark",
        definition: "start: /.+/",
      },
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-responses-test",
        tools: [applyPatchTool],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].tools?.[0]).toEqual(applyPatchTool)
  })

  test("fills empty namespace descriptions before forwarding to Copilot Responses", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            call_id: "call-search",
            type: "tool_search_output",
            tools: [
              {
                description: "",
                name: "workspace",
                tools: [],
                type: "namespace",
              },
            ],
          },
        ],
        model: "gpt-responses-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(
      (
        createResponses.mock.calls[0][0].input?.[0] as {
          tools: Array<{ description: string }>
        }
      )?.tools[0]?.description,
    ).toBe("workspace")
  })

  test("disables context management for gpt-5.6 models even when responses context management is enabled", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 272000,
            },
          },
          id: "gpt-5.6-sol",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
      231200
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-5.6-sol",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toBeUndefined()
  })

  test("disables context management for gpt-6 models even when responses context management is enabled", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 272000,
            },
          },
          id: "gpt-6",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-6",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toBeUndefined()
  })

  test("uses Codex subagent headers for Responses request attribution", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "SUBAGENT_PROBE", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-responses-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
        "x-openai-subagent": "collab_spawn",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)

    const options = createResponses.mock.calls[0][1]
    const expectedSessionId = getUUID("root-session")
    expect(options?.initiator).toBe("agent")
    expect(options?.sessionId).toBe(expectedSessionId)
    expect(options?.requestId).toBe(
      generateRequestIdFromPayload(
        { messages: payload.input },
        expectedSessionId,
      ),
    )
    expect(options?.subagentMarker).toEqual({
      agent_id: "child-thread",
      agent_type: "collab_spawn",
      session_id: "child-thread",
    })
  })

  test("does not use Codex parent thread header as Responses session", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "SUBAGENT_PROBE", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-responses-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "x-codex-parent-thread-id": "parent-thread",
        "x-openai-subagent": "collab_spawn",
        "x-session-id": "alternate-session",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)

    const options = createResponses.mock.calls[0][1]
    const expectedSessionId = getUUID("root-session")
    expect(options?.initiator).toBe("agent")
    expect(options?.sessionId).toBe(expectedSessionId)
    expect(options?.requestId).toBe(
      generateRequestIdFromPayload(
        { messages: payload.input },
        expectedSessionId,
      ),
    )
    expect(options?.subagentMarker).toEqual({
      agent_id: "parent-thread",
      agent_type: "collab_spawn",
      session_id: "root-session",
    })
  })

  test("uses session headers when Codex subagent header is missing", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "hello", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-responses-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)

    const options = createResponses.mock.calls[0][1]
    const expectedSessionId = getUUID("root-session")
    const expectedRequestId = generateRequestIdFromPayload(
      { messages: payload.input },
      expectedSessionId,
    )
    expect(options?.initiator).toBe("user")
    expect(options?.requestId).toBe(expectedRequestId)
    expect(options?.sessionId).toBe(expectedSessionId)
    expect(options?.subagentMarker).toBeNull()
  })

  test("ignores unknown x-openai-subagent values", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "hello", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-responses-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-openai-subagent": "unexpected",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.initiator).toBe("user")
    expect(createResponses.mock.calls[0][1]?.subagentMarker).toBeNull()
  })

  test("accepts known Codex subagent header values", async () => {
    for (const agentType of ["compact", "memory_consolidation", "review"]) {
      createResponses.mockReset()
      createResponses.mockImplementation((payload) =>
        Promise.resolve(createResponsesResult(payload.model)),
      )

      const app = createApp()
      const response = await app.request("/v1/responses", {
        body: JSON.stringify({
          input: [
            {
              content: [{ text: "hello", type: "input_text" }],
              role: "user",
            },
          ],
          model: "gpt-responses-test",
        }),
        headers: {
          "content-type": "application/json",
          "session-id": "root-session",
          "thread-id": "child-thread",
          "x-openai-subagent": agentType,
        },
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(createResponses).toHaveBeenCalledTimes(1)
      expect(createResponses.mock.calls[0][1]?.initiator).toBe("agent")
      expect(createResponses.mock.calls[0][1]?.subagentMarker).toEqual({
        agent_id: "child-thread",
        agent_type: agentType,
        session_id: "child-thread",
      })
    }
  })

  test("omits oversized input images before forwarding to Copilot Responses", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
              vision: {
                max_prompt_image_size: 8,
              },
            },
          },
          id: "gpt-responses-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              { text: "look", type: "input_text" },
              {
                image_url: `data:image/png;base64,${"A".repeat(16)}`,
                type: "input_image",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-responses-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    const image = (
      createResponses.mock.calls[0][0].input as Array<{
        content: Array<{
          detail?: string
          image_url?: string
          text?: string
          type: string
        }>
      }>
    )[0].content[1]
    expect(image.type).toBe("input_image")
    expect(image.detail).toBe("low")
    expect(image.image_url?.startsWith("data:image/png;base64,")).toBe(true)
    expect(image.text).toBeUndefined()
  })

  test("preserves multiple input images before forwarding to Copilot Responses", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
              vision: {
                max_prompt_image_size: 1024,
                max_prompt_images: 1,
              },
            },
          },
          id: "gpt-responses-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const firstImageUrl = `data:image/png;base64,${"A".repeat(8)}`
    const secondImageUrl = `data:image/png;base64,${"B".repeat(8)}`

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              { text: "look", type: "input_text" },
              {
                detail: "low",
                image_url: firstImageUrl,
                type: "input_image",
              },
              {
                detail: "low",
                image_url: secondImageUrl,
                type: "input_image",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-responses-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].input).toEqual([
      {
        content: [
          { text: "look", type: "input_text" },
          { detail: "low", image_url: firstImageUrl, type: "input_image" },
          { detail: "low", image_url: secondImageUrl, type: "input_image" },
        ],
        role: "user",
      },
    ])
  })

  test("records usage from failed streaming responses and falls back to interaction id", async () => {
    createResponses.mockImplementation(() =>
      Promise.resolve(
        streamChunks([
          {
            data: JSON.stringify({
              response: {
                copilot_usage: {
                  total_nano_aiu: 1234,
                },
                created_at: 0,
                error: {
                  message: "request failed",
                },
                id: "resp_123",
                incomplete_details: null,
                instructions: null,
                metadata: null,
                model: "gpt-responses-test",
                object: "response",
                output: [],
                output_text: "",
                parallel_tool_calls: false,
                status: "failed",
                temperature: null,
                tool_choice: "auto",
                tools: [],
                top_p: null,
                usage: {
                  input_tokens: 5,
                  input_tokens_details: {
                    cached_tokens: 1,
                  },
                  output_tokens: 2,
                  total_tokens: 7,
                },
              },
              sequence_number: 1,
              type: "response.failed",
            }),
            event: "response.failed",
            id: "event_1",
          },
        ]),
      ),
    )

    const app = createApp()
    const payload = {
      input: "hello",
      model: "gpt-responses-test",
      stream: true,
    }

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    await response.text()

    const eventsResponse = await app.request(
      "/token-usage/events?period=day&page=1&page_size=10",
    )
    expect(eventsResponse.status).toBe(200)

    const page = (await eventsResponse.json()) as {
      items: Array<{
        cache_read_input_tokens: number
        cost: {
          amount: number
          currency: string
          source: string
          total_cost_nanos: number
        } | null
        input_tokens: number
        output_tokens: number
        session_id: string
        total_nano_aiu: number | null
        total_tokens: number
      }>
    }
    expect(page.items).toHaveLength(1)

    const expectedRequestId = generateRequestIdFromPayload({
      messages: payload.input,
    })
    const expectedInteractionId = getUUID(expectedRequestId)

    expect(page.items[0]?.session_id).toBe(expectedInteractionId)
    expect(page.items[0]?.cache_read_input_tokens).toBe(1)
    expect(page.items[0]?.input_tokens).toBe(4)
    expect(page.items[0]?.output_tokens).toBe(2)
    expect(page.items[0]?.total_nano_aiu).toBe(1234)
    expect(page.items[0]?.total_tokens).toBe(7)
    expect(page.items[0]?.cost).toEqual({
      amount: 0.000000012,
      currency: "USD",
      source: "copilot_aiu",
      total_cost_nanos: 12,
    })
  })
})

describe("responses handler upstream header forwarding across fallbacks", () => {
  const createMessagesResponse = (
    model: string,
    headers: Record<string, string> = {},
  ) =>
    new Response(
      JSON.stringify({
        content: [{ text: "hi", type: "text" }],
        id: "msg_123",
        model,
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { "content-type": "application/json", ...headers } },
    )

  const createChatResponse = (model: string): ChatCompletionResponse => ({
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        logprobs: null,
        message: { content: "hi", role: "assistant" },
      },
    ],
    created: 0,
    id: "chatcmpl_1",
    model,
    object: "chat.completion",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
  })

  async function* createChatStream(
    model: string,
    includeUsage = true,
  ): AsyncGenerator<ChatCompletionChunk> {
    await Promise.resolve()
    yield {
      choices: [
        {
          delta: { content: "hi" },
          finish_reason: null,
          index: 0,
          logprobs: null,
        },
      ],
      created: 0,
      id: "chatcmpl_1",
      model,
      object: "chat.completion.chunk",
    }
    if (includeUsage) {
      yield {
        choices: [],
        created: 0,
        id: "chatcmpl_1",
        model,
        object: "chat.completion.chunk",
        copilot_usage: {
          token_details: [
            {
              batch_size: 1,
              cost_per_batch: 2,
              token_count: 3,
              token_type: "input",
            },
          ],
          total_nano_aiu: 1_500_000,
        },
      }
    }
    yield {
      choices: [
        {
          delta: {},
          finish_reason: "stop",
          index: 0,
          logprobs: null,
        },
      ],
      created: 0,
      id: "chatcmpl_1",
      model,
      object: "chat.completion.chunk",
      ...(includeUsage ?
        {
          usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
          copilot_usage: { total_nano_aiu: 1_500_000 },
        }
      : {}),
    }
  }

  test("forwards upstream quota headers for messages fallback non-stream", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "claude-fallback-test",
          supported_endpoints: ["/v1/messages"],
        },
      ],
    } as typeof state.models

    responsesMessagesDependencies.handleCompletionPayload = mock(
      (_context: Context, payload: AnthropicMessagesPayload) =>
        Promise.resolve(
          createMessagesResponse(payload.model, {
            "x-quota-snapshot-premium_interactions": "ent=300;rem=60",
            "x-usage-ratelimit-weekly":
              "remaining=6;resetAt=2026-07-07T12:00:00.000Z",
          }),
        ),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "claude-fallback-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-quota-snapshot-premium_interactions")).toBe(
      "ent=300;rem=60",
    )
    expect(response.headers.get("x-usage-ratelimit-weekly")).toBe(
      "remaining=6;resetAt=2026-07-07T12:00:00.000Z",
    )
  })

  test("compacts replay input before messages fallback translation", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "claude-fallback-test",
          supported_endpoints: ["/v1/messages"],
        },
      ],
    } as typeof state.models

    let capturedMessages: unknown[] = []
    const handleCompletionPayload = mock(
      (_context: Context, payload: AnthropicMessagesPayload) => {
        capturedMessages = payload.messages
        return Promise.resolve(createMessagesResponse(payload.model))
      },
    )
    responsesMessagesDependencies.handleCompletionPayload =
      handleCompletionPayload

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          { type: "message", role: "user", content: "old" },
          {
            type: "compaction",
            id: "cmp_1",
            encrypted_content: encodeMessagesCompaction("summary"),
          },
          { type: "message", role: "user", content: "fresh" },
        ],
        model: "claude-fallback-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(handleCompletionPayload).toHaveBeenCalledTimes(1)
    const [firstMessage] = capturedMessages
    if (
      !firstMessage
      || typeof firstMessage !== "object"
      || !("content" in firstMessage)
      || typeof firstMessage.content !== "string"
    ) {
      throw new Error("Expected compacted user message")
    }
    expect(firstMessage).toMatchObject({ role: "user" })
    expect(firstMessage.content).toContain("summary")
    expect(capturedMessages[1]).toMatchObject({ role: "user" })
  })

  test("forwards upstream quota headers for chat fallback stream", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "chat-fallback-test",
          supported_endpoints: ["/v1/chat/completions"],
        },
      ],
    } as typeof state.models

    responsesChatDependencies.createChatCompletions = mock(
      (payload: ChatCompletionsPayload) =>
        Promise.resolve(
          attachResponseHeaders(
            createChatStream(payload.model),
            new Headers({
              "x-quota-snapshot-premium_interactions": "ent=400;rem=80",
              "x-usage-ratelimit-session":
                "remaining=4;resetAt=2026-07-05T14:00:00.000Z",
            }),
          ),
        ),
    ) as typeof responsesChatDependencies.createChatCompletions

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "chat-fallback-test",
        stream: true,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-quota-snapshot-premium_interactions")).toBe(
      "ent=400;rem=80",
    )
    expect(response.headers.get("x-usage-ratelimit-session")).toBe(
      "remaining=4;resetAt=2026-07-05T14:00:00.000Z",
    )
    const body = await response.text()
    const completedEvents = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>)
      .filter((event) => event.type === "response.completed")

    expect(completedEvents).toHaveLength(1)
    expect(completedEvents[0]).toMatchObject({
      response: {
        copilot_usage: {
          total_nano_aiu: 1_500_000,
        },
        output_text: "hi",
        status: "completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
      },
    })

    const eventsResponse = await app.request(
      "/token-usage/events?period=day&page=1&page_size=10",
    )
    const page = (await eventsResponse.json()) as {
      items: Array<{
        nano_cost_input: number | null
        total_nano_aiu: number | null
      }>
    }
    expect(page.items[0]).toMatchObject({
      nano_cost_input: 6,
      total_nano_aiu: 1_500_000,
    })
  })

  test("passes the client signal to chat fallback requests", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: { limits: { max_prompt_tokens: 128000 } },
          id: "chat-fallback-test",
          supported_endpoints: ["/v1/chat/completions"],
        },
      ],
    } as typeof state.models

    let clientSignal: AbortSignal | undefined
    responsesChatDependencies.createChatCompletions = mock(
      (_payload, options: { clientSignal?: AbortSignal } | undefined) => {
        clientSignal = options?.clientSignal
        return Promise.resolve(createChatResponse("chat-fallback-test"))
      },
    ) as typeof responsesChatDependencies.createChatCompletions

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "chat-fallback-test",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(clientSignal).toBeInstanceOf(AbortSignal)
  })

  test("flushes a completed chat fallback stream without a final usage chunk", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "chat-fallback-test",
          supported_endpoints: ["/v1/chat/completions"],
        },
      ],
    } as typeof state.models

    responsesChatDependencies.createChatCompletions = mock(
      (payload: ChatCompletionsPayload) =>
        Promise.resolve(createChatStream(payload.model, false)),
    ) as typeof responsesChatDependencies.createChatCompletions

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "chat-fallback-test",
        stream: true,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })
    const body = await response.text()
    const completedEvents = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>)
      .filter((event) => event.type === "response.completed")

    expect(completedEvents).toHaveLength(1)
    expect(completedEvents[0]).toMatchObject({
      response: {
        output_text: "hi",
        status: "completed",
        usage: null,
      },
    })
  })

  test("does not emit a failed event after a completed chat fallback stream", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "chat-fallback-test",
          supported_endpoints: ["/v1/chat/completions"],
        },
      ],
    } as typeof state.models

    async function* completedThenFailed(
      model: string,
    ): AsyncGenerator<ChatCompletionChunk> {
      yield* createChatStream(model)
      throw new Error("upstream failed after completion")
    }

    responsesChatDependencies.createChatCompletions = mock(
      (payload: ChatCompletionsPayload) =>
        Promise.resolve(completedThenFailed(payload.model)),
    ) as typeof responsesChatDependencies.createChatCompletions

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "chat-fallback-test",
        stream: true,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })
    const body = await response.text()
    const terminalTypes = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>)
      .map((event) => event.type)
      .filter((type) =>
        [
          "response.completed",
          "response.incomplete",
          "response.failed",
        ].includes(String(type)),
      )

    expect(terminalTypes).toEqual(["response.completed"])
  })

  test("compacts replay input before chat fallback translation", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "chat-fallback-test",
          supported_endpoints: ["/v1/chat/completions"],
        },
      ],
    } as typeof state.models

    let capturedMessages: unknown[] = []
    const createChatCompletions = mock((payload: ChatCompletionsPayload) => {
      capturedMessages = payload.messages
      return Promise.resolve(createChatResponse(payload.model))
    })
    responsesChatDependencies.createChatCompletions = createChatCompletions

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          { type: "message", role: "user", content: "old" },
          {
            type: "compaction",
            id: "cmp_1",
            encrypted_content: encodeMessagesCompaction("summary"),
          },
          { type: "message", role: "user", content: "fresh" },
        ],
        model: "chat-fallback-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createChatCompletions).toHaveBeenCalledTimes(1)
    expect(capturedMessages).toEqual([{ role: "user", content: "fresh" }])
  })
  test("tolerates upstream stream events shaped as SSE envelopes (no direct choices)", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: { max_prompt_tokens: 128000 },
          },
          id: "chat-fallback-test",
          supported_endpoints: ["/v1/chat/completions"],
        },
      ],
    } as typeof state.models

    // 真实 createChatCompletions 流式返回 fetch-event-stream 的 envelope
    // （{ data: "<json string>" }），不是裸 ChatCompletionChunk。
    // 复现线上 bug：chat-handler 直接 for-await envelope 当 chunk，
    // 读 chunk.choices.length 时崩（envelope 无 choices 字段）。
    async function* createEnvelopeStream(
      model: string,
    ): AsyncGenerator<{ data: string; event?: string }> {
      await Promise.resolve()
      yield {
        data: JSON.stringify({
          choices: [
            {
              delta: { content: "hi" },
              finish_reason: null,
              index: 0,
              logprobs: null,
            },
          ],
          created: 0,
          id: "chatcmpl_1",
          model,
        }),
      }
      yield {
        data: JSON.stringify({
          choices: [
            {
              delta: {},
              finish_reason: "stop",
              index: 0,
              logprobs: null,
            },
          ],
          created: 0,
          id: "chatcmpl_1",
          model,
          usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
        }),
      }
      yield { data: "[DONE]" }
    }

    responsesChatDependencies.createChatCompletions = mock(
      (payload: ChatCompletionsPayload) =>
        Promise.resolve(createEnvelopeStream(payload.model)),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "chat-fallback-test",
        stream: true,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    const body = await response.text()
    const types = body
      .split("\n")
      .filter((line) => line.startsWith("event:"))
      .map((line) => line.slice(6).trim())

    // 红→绿判据：envelope 流应被解包成 chunk 后正常完成，
    // 而不是因 chunk.choices 为 undefined 抛错发 response.failed。
    expect(types).toContain("response.completed")
    expect(types).not.toContain("response.failed")
  })
})

describe("responses handler interrupted streams", () => {
  test("delivers failure events when the Messages stream ends before initialization", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            family: "claude",
            limits: { max_prompt_tokens: 128000 },
            object: "model_capabilities",
            supports: { tool_calls: true },
            tokenizer: "o200k_base",
            type: "chat",
          },
          id: "claude-test",
          model_picker_enabled: true,
          name: "Claude Test",
          object: "model",
          preview: false,
          supported_endpoints: ["/v1/messages"],
          vendor: "anthropic",
          version: "test",
        },
      ],
    }
    const handleMessages = mock(
      (_context: Context, _payload: AnthropicMessagesPayload) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    )
    responsesMessagesDependencies.handleCompletionPayload = handleMessages

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "claude-test",
        input: [{ role: "user", type: "message", content: "hi" }],
        stream: true,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type") ?? "").toContain(
      "text/event-stream",
    )

    const body = await response.text()
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string })

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "error",
      "response.failed",
    ])
  })
})
