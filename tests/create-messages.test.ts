import { test, expect, mock, spyOn, afterEach, beforeEach } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/lib/types/anthropic"

import * as configModule from "../src/lib/config"
import { getAttachedPremiumInfo } from "../src/lib/logger"
import { getAttachedResponseHeaders } from "../src/lib/response-headers"
import { clearSmartAgentCache } from "../src/lib/smart-agent"
import { state } from "../src/lib/state"
import { createMessages } from "../src/services/copilot/create-messages"
import * as telemetryModule from "../src/services/telemetry/telemetry"

/* eslint-disable @typescript-eslint/no-non-null-assertion */

// Telemetry mock (captures modelCallId for assertions)
let capturedModelCallId: string | undefined

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Helper to mock fetch
let fetchMock: ReturnType<typeof mock>
type FetchCall = [string, RequestInit]

const findMessagesCall = (): FetchCall => {
  const messagesCall = fetchMock.mock.calls.find((call) =>
    (call[0] as string).includes("/v1/messages"),
  )
  expect(messagesCall).toBeDefined()
  return messagesCall as FetchCall
}

const getMessagesHeaders = (): Record<string, string> =>
  (findMessagesCall()[1] as { headers: Record<string, string> }).headers

const getMessagesBody = (): string =>
  (findMessagesCall()[1] as { body: string }).body

beforeEach(() => {
  capturedModelCallId = undefined
  state.interactionId = "test-interaction-id"
  state.forceAgent = false
  state.models = undefined
  clearSmartAgentCache() // Clear cache between tests
  fetchMock = mock((_url: string, opts: { headers: Record<string, string> }) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          id: "msg-123",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          model: "claude-sonnet-4-20250514",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        {
          status: 200,
          headers: new Headers({
            ...opts.headers,
            "x-quota-snapshot-premium_interactions":
              "ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z",
          }),
        },
      ),
    ),
  )
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

  // Capture modelCallId using spyOn (can be restored by mock.restore())
  spyOn(telemetryModule, "trackRequestSent").mockImplementation(
    (
      _model: string,
      _accountType: string,
      _requestId?: string,
      modelCallId?: string,
      // eslint-disable-next-line max-params
    ) => {
      capturedModelCallId = modelCallId
    },
  )
  spyOn(telemetryModule, "trackResponseSuccess").mockImplementation(() => {})
  spyOn(telemetryModule, "trackResponseError").mockImplementation(() => {})
})

afterEach(() => {
  mock.restore()
})

test("calls /v1/messages endpoint", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, undefined)
  expect(fetchMock).toHaveBeenCalled()
  const url = findMessagesCall()[0]
  expect(url).toContain("/v1/messages")
})

test("sets X-Initiator to user by default", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, undefined, { initiator: "user" })
  const headers = getMessagesHeaders()
  expect(headers["x-initiator"]).toBe("user")
})

test("sets X-Initiator to agent when specified", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, undefined, { initiator: "agent" })
  const headers = getMessagesHeaders()
  expect(headers["x-initiator"]).toBe("agent")
})

test("forces X-Initiator to agent when state.forceAgent is true", async () => {
  state.forceAgent = true
  state.githubToken = "test-github-token"

  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, undefined, { initiator: "user" })

  // With smart agent mode, first call is usage API, second is messages API
  // Find the /v1/messages call
  const messagesCall = fetchMock.mock.calls.find((call) =>
    (call[0] as string).includes("/v1/messages"),
  )
  expect(messagesCall).toBeDefined()
  const headers = (messagesCall![1] as { headers: Record<string, string> })
    .headers
  expect(headers["x-initiator"]).toBe("agent")
})

test("forwards allowed anthropic-beta header when provided", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, "context-management-2025-06-27", {})
  const headers = getMessagesHeaders()
  expect(headers["anthropic-beta"]).toBe("context-management-2025-06-27")
})

test("filters unsupported anthropic-beta header when provided", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, "max-tokens-3-5-sonnet-2024-07-15", {})
  const headers = getMessagesHeaders()
  expect(headers["anthropic-beta"]).toBeUndefined()
})

test("does not include anthropic-beta header when not provided", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, undefined)
  const headers = getMessagesHeaders()
  expect(headers["anthropic-beta"]).toBeUndefined()
})

test("passes payload with forced temperature=1 to endpoint", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "how are you?" },
    ],
    system: "You are a helpful assistant.",
    temperature: 0.7, // This should be overridden to 1
  }
  await createMessages(payload, undefined)
  const body = getMessagesBody()
  const parsed = JSON.parse(body) as AnthropicMessagesPayload
  // temperature is forced to 1 for deep thinking
  expect(parsed.temperature).toBe(1)
  // Other fields remain unchanged
  expect(parsed.model).toBe(payload.model)
  expect(parsed.max_tokens).toBe(payload.max_tokens)
  expect(parsed.messages).toEqual(payload.messages)
  expect(parsed.system).toBe(payload.system)
})

test("does not enable adaptive thinking when tool_choice forces tool use", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        object: "model",
        vendor: "anthropic",
        version: "20250514",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          limits: {},
          object: "model_capabilities",
          supports: {
            adaptive_thinking: true,
          },
          tokenizer: "claude",
          type: "chat.completions",
        },
        supported_endpoints: ["/v1/messages"],
      },
    ],
  }

  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [{ role: "user", content: "use the tool" }],
    tools: [
      {
        name: "get_weather",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
      },
    ],
    tool_choice: {
      type: "tool",
      name: "get_weather",
    },
  }

  await createMessages(payload, undefined)
  const body = getMessagesBody()
  const parsed = JSON.parse(body) as AnthropicMessagesPayload

  expect(parsed.thinking).toBeUndefined()
  expect(parsed.output_config).toBeUndefined()
})

test("preserves request output_config effort when adaptive thinking enabled", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        object: "model",
        vendor: "anthropic",
        version: "20250514",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          limits: {},
          object: "model_capabilities",
          supports: {
            adaptive_thinking: true,
          },
          tokenizer: "claude",
          type: "chat.completions",
        },
        supported_endpoints: ["/v1/messages"],
      },
    ],
  }

  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    output_config: { effort: "medium" },
  }

  await createMessages(payload, undefined)

  const body = getMessagesBody()
  const parsed = JSON.parse(body) as AnthropicMessagesPayload

  expect(parsed.output_config?.effort).toBe("medium")
})

test("native log effort uses anthropic mapping for config fallback", () => {
  const effortSpy = spyOn(
    configModule,
    "getReasoningEffortForModel",
  ).mockReturnValue("xhigh")

  const result = configModule.resolveAnthropicEffortForLog(
    undefined,
    "claude-sonnet-4-20250514",
  )

  expect(result).toEqual({ value: "max", source: "config" })

  effortSpy.mockRestore()
})

test("returns raw Response object", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  const response = await createMessages(payload, undefined)
  // Should return the parsed AnthropicResponse (JSON branch)
  expect(response).toHaveProperty("id")
  expect(response).toHaveProperty("role")
  expect(response).toHaveProperty("content")
})

test("attaches premium info from response header", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }

  const response = await createMessages(payload, undefined)

  expect(getAttachedPremiumInfo(response)).toEqual({
    remaining: 106.5,
    total: 300,
  })
})

test("attaches upstream response headers from native messages response", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }

  const response = await createMessages(payload, undefined)

  expect(
    getAttachedResponseHeaders(response)?.get(
      "x-quota-snapshot-premium_interactions",
    ),
  ).toBe("ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z")
})

test("throws error when copilot token is missing", async () => {
  const originalToken = state.copilotToken
  state.copilotToken = undefined

  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }

  try {
    await createMessages(payload, undefined)
    expect.unreachable("Should have thrown")
  } catch (error) {
    expect((error as Error).message).toBe("Copilot token not found")
  } finally {
    // eslint-disable-next-line require-atomic-updates
    state.copilotToken = originalToken
  }
})

test("throws HTTPError when response is not ok", async () => {
  // Override fetch mock to return error response
  const mockResponse = {
    ok: false,
    status: 500,
    json: () => Promise.resolve({ error: "Internal Server Error" }),
    clone: () => mockResponse,
  }
  const errorFetchMock = mock(() => mockResponse)
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = errorFetchMock

  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }

  try {
    await createMessages(payload, undefined)
    expect.unreachable("Should have thrown")
  } catch (error) {
    expect((error as Error).message).toBe("Failed to create native messages")
  }
})

test("sets copilot-vision-request header when payload contains image block", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
          },
        ],
      },
    ],
  }
  await createMessages(payload, undefined)
  const headers = getMessagesHeaders()
  expect(headers["copilot-vision-request"]).toBe("true")
})

test("sets copilot-vision-request header when tool_result contains nested image", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Take a screenshot" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_123",
            name: "screenshot",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_123",
            content: [
              { type: "text", text: "Screenshot taken" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                },
              },
            ],
          },
        ],
      },
    ],
  }
  await createMessages(payload, undefined)
  const headers = getMessagesHeaders()
  expect(headers["copilot-vision-request"]).toBe("true")
})

test("does not set copilot-vision-request header for text-only messages", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello, how are you?" }],
  }
  await createMessages(payload, undefined)
  const headers = getMessagesHeaders()
  expect(headers["copilot-vision-request"]).toBeUndefined()
})

test("includes X-Interaction-Id from state.interactionId (Wave 1/2)", async () => {
  const originalInteractionId = state.interactionId
  state.interactionId = "test-interaction-id"
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, undefined)
  const headers = getMessagesHeaders()
  expect(headers["x-interaction-id"]).toBe("test-interaction-id")
  // eslint-disable-next-line require-atomic-updates
  state.interactionId = originalInteractionId
})

test("X-Agent-Task-Id equals x-request-id (Wave 1/2)", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, undefined)
  const headers = getMessagesHeaders()
  expect(headers["x-agent-task-id"]).toBe(headers["x-request-id"])
})

test("passes non-empty modelCallId to telemetry (Wave 1/2)", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, undefined)
  expect(capturedModelCallId).toBeDefined()
  expect(typeof capturedModelCallId).toBe("string")
  expect(capturedModelCallId!.length).toBeGreaterThan(0)
})

test("X-Interaction-Type equals openai-intent (Wave 1/2)", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, undefined)
  const headers = getMessagesHeaders()
  expect(headers["x-interaction-type"]).toBe(headers["openai-intent"])
})
