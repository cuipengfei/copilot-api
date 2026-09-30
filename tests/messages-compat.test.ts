import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Server } from "bun"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type { Model } from "~/lib/types/models"
import {
  buildAnthropicBetaHeader,
  buildEnhancedPayload,
  hasImageContent,
  isInvalidReasoningEffortError,
  isThinkingBlockError,
  parseSupportedEfforts,
  prepareMessagesRequest,
  reorderAssistantBlocks,
  sendWithSignatureRetry,
  shouldDisableThinkingForToolChoice,
  stripThinkingBlocks,
  type EnhancedMessagesPayload,
} from "~/services/copilot/messages-compat"

const basePayload = (): AnthropicMessagesPayload => ({
  model: "claude-test",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
})

const makeModel = (id: string, adaptiveThinking: boolean): Model => ({
  id,
  capabilities: {
    family: "test",
    limits: {},
    object: "capabilities",
    supports: { adaptive_thinking: adaptiveThinking },
    tokenizer: "test",
    type: "model",
  },
  model_picker_enabled: true,
  name: id,
  object: "model",
  preview: false,
  vendor: "test",
  version: "1",
})

const catchError = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected promise to reject")
}

test("buildAnthropicBetaHeader keeps whitelisted betas and dedupes", () => {
  const header = buildAnthropicBetaHeader({
    anthropicBetaHeader:
      "interleaved-thinking-2025-05-14, unknown-beta, interleaved-thinking-2025-05-14, advanced-tool-use-2025-11-20",
    adaptiveThinkingEnabled: false,
    thinking: undefined,
  })
  expect(header).toBe(
    "interleaved-thinking-2025-05-14,advanced-tool-use-2025-11-20",
  )
})

test("buildAnthropicBetaHeader drops interleaved beta when adaptive thinking enabled", () => {
  const header = buildAnthropicBetaHeader({
    anthropicBetaHeader:
      "interleaved-thinking-2025-05-14, advanced-tool-use-2025-11-20",
    adaptiveThinkingEnabled: true,
    thinking: undefined,
  })
  expect(header).toBe("advanced-tool-use-2025-11-20")
})

test("buildAnthropicBetaHeader returns undefined when filtering empties the header", () => {
  expect(
    buildAnthropicBetaHeader({
      anthropicBetaHeader: "unknown-beta",
      adaptiveThinkingEnabled: false,
      thinking: undefined,
    }),
  ).toBeUndefined()
})

test("buildAnthropicBetaHeader falls back to interleaved beta for budgeted non-adaptive thinking", () => {
  expect(
    buildAnthropicBetaHeader({
      anthropicBetaHeader: undefined,
      adaptiveThinkingEnabled: false,
      thinking: { type: "enabled", budget_tokens: 1024 },
    }),
  ).toBe("interleaved-thinking-2025-05-14")
})

test("buildAnthropicBetaHeader stays undefined without header and without budgeted thinking", () => {
  expect(
    buildAnthropicBetaHeader({
      anthropicBetaHeader: undefined,
      adaptiveThinkingEnabled: false,
      thinking: undefined,
    }),
  ).toBeUndefined()
  expect(
    buildAnthropicBetaHeader({
      anthropicBetaHeader: undefined,
      adaptiveThinkingEnabled: true,
      thinking: { type: "enabled", budget_tokens: 1 },
    }),
  ).toBeUndefined()
})

test("stripThinkingBlocks removes thinking blocks from assistant array content", () => {
  const payload: AnthropicMessagesPayload = {
    ...basePayload(),
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "abc", signature: "sig" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  }

  const stripped = stripThinkingBlocks(payload)

  expect(stripped.messages[0]).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
  })
  expect(payload.messages[0]).not.toEqual(stripped.messages[0])
})

test("stripThinkingBlocks keeps redacted_thinking and non-assistant messages", () => {
  const payload: AnthropicMessagesPayload = {
    ...basePayload(),
    messages: [
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "opaque" },
          { type: "thinking", thinking: "abc", signature: "sig" },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "keep me" }],
      },
      { role: "assistant", content: "plain string" },
    ],
  }

  const stripped = stripThinkingBlocks(payload)

  expect(stripped.messages[0].content).toEqual([
    { type: "redacted_thinking", data: "opaque" },
  ])
  expect(stripped.messages[1]).toEqual(payload.messages[1])
  expect(stripped.messages[2]).toEqual({
    role: "assistant",
    content: "plain string",
  })
})

test("hasImageContent detects direct and nested tool_result images in user messages", () => {
  const direct: AnthropicMessagesPayload = {
    ...basePayload(),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "d" },
          },
        ],
      },
    ],
  }
  const nested: AnthropicMessagesPayload = {
    ...basePayload(),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "d" },
              },
            ],
          },
        ],
      },
    ],
  }
  const textOnly = basePayload()
  // Assistant messages cannot carry images per the Anthropic types, but the
  // runtime guard keys off role first; cast to exercise that path.
  const assistantImage = {
    ...basePayload(),
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "d" },
          },
        ],
      },
    ],
  } as unknown as AnthropicMessagesPayload

  expect(hasImageContent(direct)).toBe(true)
  expect(hasImageContent(nested)).toBe(true)
  expect(hasImageContent(textOnly)).toBe(false)
  expect(hasImageContent(assistantImage)).toBe(false)
})

test("reorderAssistantBlocks moves text before tool_use in place", () => {
  const payload: AnthropicMessagesPayload = {
    ...basePayload(),
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "tool", input: {} },
          { type: "text", text: "before" },
        ],
      },
    ],
  }

  reorderAssistantBlocks(payload)

  expect(payload.messages[0].content).toEqual([
    { type: "text", text: "before" },
    { type: "tool_use", id: "tu_1", name: "tool", input: {} },
  ])
})

test("reorderAssistantBlocks preserves thinking and redacted_thinking positions", () => {
  const payload: AnthropicMessagesPayload = {
    ...basePayload(),
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t", signature: "s" },
          { type: "tool_use", id: "tu_1", name: "tool", input: {} },
          { type: "text", text: "after" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "tool_use", id: "tu_2", name: "tool", input: {} },
        ],
      },
    ],
  }

  reorderAssistantBlocks(payload)

  expect(payload.messages[0].content).toEqual([
    { type: "thinking", thinking: "t", signature: "s" },
    { type: "text", text: "after" },
    { type: "tool_use", id: "tu_1", name: "tool", input: {} },
    { type: "redacted_thinking", data: "opaque" },
    { type: "tool_use", id: "tu_2", name: "tool", input: {} },
  ])
})

test("buildEnhancedPayload strips top_p, forces temperature=1, keeps other fields", () => {
  const payload: AnthropicMessagesPayload = {
    ...basePayload(),
    top_p: 0.9,
    top_k: 40,
    stream: true,
  }

  const enhanced = buildEnhancedPayload(payload, false)

  expect(enhanced).toEqual({
    model: "claude-test",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    top_k: 40,
    stream: true,
    temperature: 1,
  })
})

test("buildEnhancedPayload keeps request effort over config fallback when adaptive", () => {
  const payload: AnthropicMessagesPayload = {
    ...basePayload(),
    output_config: { effort: "high" },
  }

  const enhanced = buildEnhancedPayload(payload, true)

  expect(enhanced.thinking).toEqual({ type: "adaptive" })
  expect(enhanced.output_config).toEqual({ effort: "high" })
})

test("buildEnhancedPayload falls back to config-derived effort when adaptive and request effort unset", () => {
  const enhanced = buildEnhancedPayload(basePayload(), true)

  expect(enhanced.thinking).toEqual({ type: "adaptive" })
  expect(
    ["low", "medium", "high", "xhigh", "max"].includes(
      enhanced.output_config?.effort ?? "",
    ),
  ).toBe(true)
})

test("shouldDisableThinkingForToolChoice only triggers for any/tool choices", () => {
  const payloadWith = (
    toolChoice: AnthropicMessagesPayload["tool_choice"],
  ): AnthropicMessagesPayload => ({ ...basePayload(), tool_choice: toolChoice })

  expect(shouldDisableThinkingForToolChoice(payloadWith({ type: "any" }))).toBe(
    true,
  )
  expect(
    shouldDisableThinkingForToolChoice(
      payloadWith({ type: "tool", name: "n" }),
    ),
  ).toBe(true)
  expect(
    shouldDisableThinkingForToolChoice(payloadWith({ type: "auto" })),
  ).toBe(false)
  expect(
    shouldDisableThinkingForToolChoice(payloadWith({ type: "none" })),
  ).toBe(false)
  expect(shouldDisableThinkingForToolChoice(basePayload())).toBe(false)
})

test("error matchers classify backend error bodies", () => {
  expect(
    isInvalidReasoningEffortError({
      error: { code: "invalid_reasoning_effort" },
    }),
  ).toBe(true)
  expect(isInvalidReasoningEffortError(null)).toBe(false)
  expect(isInvalidReasoningEffortError({ error: { message: "boom" } })).toBe(
    false,
  )

  expect(
    isThinkingBlockError({ error: { message: "invalid signature" } }),
  ).toBe(true)
  expect(isThinkingBlockError("thinking blocks cannot be modified")).toBe(true)
  expect(isThinkingBlockError(null)).toBe(false)
  expect(isThinkingBlockError({})).toBe(false)
})

test("parseSupportedEfforts extracts supported values from backend messages", () => {
  expect(
    parseSupportedEfforts({
      error: { message: "invalid effort, supported values: [low, medium]" },
    }),
  ).toEqual(["low", "medium"])
  expect(parseSupportedEfforts('supported values: ["high", "max"]')).toEqual([
    "high",
    "max",
  ])
  expect(parseSupportedEfforts({ error: { message: "boom" } })).toEqual([])
  expect(parseSupportedEfforts(null)).toEqual([])
})

describe("prepareMessagesRequest", () => {
  const originalModels = state.models

  beforeEach(() => {
    state.models = {
      object: "list",
      data: [
        makeModel("claude-adaptive", true),
        makeModel("claude-plain", false),
      ],
    }
  })

  afterEach(() => {
    state.models = originalModels
  })

  test("enables adaptive thinking for capable models and builds adaptive payload", () => {
    const payload: AnthropicMessagesPayload = {
      ...basePayload(),
      model: "claude-adaptive",
      output_config: { effort: "medium" },
    }

    const prepared = prepareMessagesRequest(payload, undefined)

    expect(prepared.adaptiveThinkingEnabled).toBe(true)
    expect(prepared.betaHeader).toBeUndefined()
    expect(prepared.enhancedPayload.thinking).toEqual({ type: "adaptive" })
    expect(prepared.enhancedPayload.output_config).toEqual({ effort: "medium" })
  })

  test("disables adaptive thinking for capable models when tool_choice forces tool use", () => {
    const payload: AnthropicMessagesPayload = {
      ...basePayload(),
      model: "claude-adaptive",
      tool_choice: { type: "any" },
    }

    const prepared = prepareMessagesRequest(payload, undefined)

    expect(prepared.adaptiveThinkingEnabled).toBe(false)
    expect(prepared.enhancedPayload.thinking).toBeUndefined()
    expect(prepared.enhancedPayload.output_config).toBeUndefined()
  })

  test("disables adaptive thinking for models without adaptive capability", () => {
    const payload: AnthropicMessagesPayload = {
      ...basePayload(),
      model: "claude-plain",
    }

    const prepared = prepareMessagesRequest(payload, undefined)

    expect(prepared.adaptiveThinkingEnabled).toBe(false)
    expect(prepared.enhancedPayload.thinking).toBeUndefined()
  })

  test("strips interleaved beta from provided header when adaptive thinking enabled", () => {
    const payload: AnthropicMessagesPayload = {
      ...basePayload(),
      model: "claude-adaptive",
    }

    const prepared = prepareMessagesRequest(
      payload,
      "interleaved-thinking-2025-05-14, advanced-tool-use-2025-11-20",
    )

    expect(prepared.betaHeader).toBe("advanced-tool-use-2025-11-20")
  })

  test("reorders assistant blocks in place while preparing", () => {
    const payload: AnthropicMessagesPayload = {
      ...basePayload(),
      model: "claude-plain",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "tool", input: {} },
            { type: "text", text: "after" },
          ],
        },
      ],
    }

    prepareMessagesRequest(payload, undefined)

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "after" },
      { type: "tool_use", id: "tu_1", name: "tool", input: {} },
    ])
  })
})

describe("sendWithSignatureRetry against local HTTP server", () => {
  const runWithServer = async (
    respond: (count: number) => Response,
    run: (url: string, bodies: Array<unknown>) => Promise<void>,
  ): Promise<void> => {
    const bodies: Array<unknown> = []
    let count = 0
    const server: Server<undefined> = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        count += 1
        bodies.push(await request.json())
        return respond(count)
      },
    })
    try {
      await run(server.url.href, bodies)
    } finally {
      await server.stop(true)
    }
  }

  const enhancedWithEffort = (effort: string): EnhancedMessagesPayload =>
    buildEnhancedPayload(
      {
        ...basePayload(),
        output_config: { effort: effort as "high" },
      },
      false,
    )

  const send = (url: string, enhancedPayload: EnhancedMessagesPayload) =>
    sendWithSignatureRetry(url, { headers: {}, enhancedPayload })

  const effortError = () =>
    Response.json(
      {
        error: {
          code: "invalid_reasoning_effort",
          message: "unsupported effort, supported values: [low]",
        },
      },
      { status: 400 },
    )

  const thinkingError = () =>
    Response.json(
      {
        error: {
          message: "thinking or redacted_thinking blocks cannot be modified",
        },
      },
      { status: 400 },
    )

  test("returns ok response without retry", async () => {
    await runWithServer(
      () => Response.json({ ok: true }),
      async (url, bodies) => {
        const response = await send(
          url,
          buildEnhancedPayload(basePayload(), false),
        )
        expect(response.status).toBe(200)
        expect(bodies).toHaveLength(1)
      },
    )
  })

  test("throws HTTPError without retry when error matches no retry condition", async () => {
    await runWithServer(
      () =>
        Response.json({ error: { message: "rate limited" } }, { status: 429 }),
      async (url, bodies) => {
        const error = await catchError(
          send(url, buildEnhancedPayload(basePayload(), false)),
        )
        expect(error).toBeInstanceOf(HTTPError)
        expect((error as HTTPError).message).toBe(
          "Failed to create native messages",
        )
        expect(bodies).toHaveLength(1)
      },
    )
  })

  test("throws HTTPError without retry for non-400 responses", async () => {
    await runWithServer(
      () => Response.json({ error: { message: "boom" } }, { status: 500 }),
      async (url, bodies) => {
        const error = await catchError(
          send(url, buildEnhancedPayload(basePayload(), false)),
        )
        expect(error).toBeInstanceOf(HTTPError)
        expect((error as HTTPError).message).toBe(
          "Failed to create native messages",
        )
        expect(bodies).toHaveLength(1)
      },
    )
  })

  test("retries once with fallback effort on invalid_reasoning_effort", async () => {
    await runWithServer(
      (count) => (count === 1 ? effortError() : Response.json({ ok: true })),
      async (url, bodies) => {
        const response = await send(url, enhancedWithEffort("high"))
        expect(response.status).toBe(200)
        expect(bodies).toHaveLength(2)
        const retryBody = bodies[1] as { output_config?: { effort?: string } }
        expect(retryBody.output_config?.effort).toBe("low")
      },
    )
  })

  test("does not retry invalid_reasoning_effort when payload lacks output_config", async () => {
    await runWithServer(
      () => effortError(),
      async (url, bodies) => {
        const error = await catchError(
          send(url, buildEnhancedPayload(basePayload(), false)),
        )
        expect(error).toBeInstanceOf(HTTPError)
        expect((error as HTTPError).message).toBe(
          "Failed to create native messages",
        )
        expect(bodies).toHaveLength(1)
      },
    )
  })

  test("throws HTTPError mentioning effort retry when the retry attempt fails", async () => {
    await runWithServer(
      () => effortError(),
      async (url, bodies) => {
        const error = await catchError(send(url, enhancedWithEffort("high")))
        expect(error).toBeInstanceOf(HTTPError)
        expect((error as HTTPError).message).toBe(
          "Failed to create native messages (after effort retry)",
        )
        expect(bodies).toHaveLength(2)
      },
    )
  })

  test("retries once with thinking blocks stripped on thinking block error", async () => {
    const payload: AnthropicMessagesPayload = {
      ...basePayload(),
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "t", signature: "s" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    }

    await runWithServer(
      (count) => (count === 1 ? thinkingError() : Response.json({ ok: true })),
      async (url, bodies) => {
        const response = await send(url, buildEnhancedPayload(payload, false))
        expect(response.status).toBe(200)
        expect(bodies).toHaveLength(2)
        const retryBody = bodies[1] as {
          messages: Array<{ content: Array<{ type: string }> }>
        }
        expect(
          retryBody.messages[0].content.map((block) => block.type),
        ).toEqual(["text"])
      },
    )
  })

  test("throws HTTPError mentioning retry when stripped retry attempt fails", async () => {
    await runWithServer(
      () => thinkingError(),
      async (url, bodies) => {
        const error = await catchError(
          send(url, buildEnhancedPayload(basePayload(), false)),
        )
        expect(error).toBeInstanceOf(HTTPError)
        expect((error as HTTPError).message).toBe(
          "Failed to create native messages (after retry)",
        )
        expect(bodies).toHaveLength(2)
      },
    )
  })

  test("prefers effort retry over thinking retry when both error markers match", async () => {
    const payload: AnthropicMessagesPayload = {
      ...basePayload(),
      output_config: { effort: "high" },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "t", signature: "s" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    }

    await runWithServer(
      (count) =>
        count === 1 ?
          Response.json(
            {
              error: {
                code: "invalid_reasoning_effort",
                message:
                  "supported values: [low]; thinking blocks cannot be modified",
              },
            },
            { status: 400 },
          )
        : Response.json({ ok: true }),
      async (url, bodies) => {
        const response = await send(url, buildEnhancedPayload(payload, false))
        expect(response.status).toBe(200)
        expect(bodies).toHaveLength(2)
        const retryBody = bodies[1] as {
          output_config?: { effort?: string }
          messages: Array<{ content: Array<{ type: string }> }>
        }
        expect(retryBody.output_config?.effort).toBe("low")
        expect(
          retryBody.messages[0].content.map((block) => block.type),
        ).toEqual(["thinking", "text"])
      },
    )
  })
})
