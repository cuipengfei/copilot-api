import { describe, expect, test } from "bun:test"

import type {
  ChatCompletionsPayload,
  CopilotCacheControl,
} from "~/lib/types/chat-completions"
import { applyCopilotContextCache } from "~/services/copilot/context-cache"

const cacheControl = { type: "ephemeral" } as const

describe("applyCopilotContextCache", () => {
  test("marks the first two non-empty system messages and last non-empty non-system message", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-test",
      messages: [
        { role: "system", content: "system one" },
        { role: "system", content: "system two" },
        { role: "system", content: "system three" },
        { role: "user", content: "older user" },
        { role: "assistant", content: "older assistant" },
        { role: "user", content: "latest user" },
        { role: "assistant", content: "latest assistant" },
      ],
    }

    applyCopilotContextCache(payload)

    expect(payload.messages).toEqual([
      {
        role: "system",
        content: "system one",
        copilot_cache_control: cacheControl,
      },
      {
        role: "system",
        content: "system two",
        copilot_cache_control: cacheControl,
      },
      { role: "system", content: "system three" },
      { role: "user", content: "older user" },
      { role: "assistant", content: "older assistant" },
      { role: "user", content: "latest user" },
      {
        role: "assistant",
        content: "latest assistant",
        copilot_cache_control: cacheControl,
      },
    ])
  })

  test("preserves existing marker, content, and tool identities", () => {
    const existingMarker: CopilotCacheControl = { type: "ephemeral" }
    const content: ChatCompletionsPayload["messages"][number]["content"] = [
      { type: "text", text: "latest" },
    ]
    const tools: NonNullable<ChatCompletionsPayload["tools"]> = [
      {
        type: "function",
        function: { name: "lookup", parameters: { type: "object" } },
      },
    ]
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        {
          role: "system",
          content: "system",
          copilot_cache_control: existingMarker,
        },
        { role: "user", content },
      ],
      tools,
    }

    applyCopilotContextCache(payload)

    expect(payload.messages[0].copilot_cache_control).toBe(existingMarker)
    expect(payload.messages[1].content).toBe(content)
    expect(payload.tools).toBe(tools)
  })

  test("skips empty strings, null content, and empty content arrays when selecting messages", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        { role: "system", content: "" },
        { role: "system", content: "system" },
        { role: "user", content: "older" },
        { role: "assistant", content: "last non-empty" },
        { role: "tool", content: [] },
        { role: "user", content: null },
      ],
    }

    applyCopilotContextCache(payload)

    expect(
      payload.messages.map((message) => message.copilot_cache_control),
    ).toEqual([
      undefined,
      cacheControl,
      undefined,
      cacheControl,
      undefined,
      undefined,
    ])
  })

  test("does not treat a null-content tool call as the latest non-empty message", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        { role: "user", content: "latest non-empty" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
      ],
    }

    applyCopilotContextCache(payload)

    expect(payload.messages[0].copilot_cache_control).toEqual(cacheControl)
    expect(payload.messages[1].copilot_cache_control).toBeUndefined()
    expect(payload.messages[1].tool_calls).toHaveLength(1)
  })

  test("marks a non-empty tool result", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        { role: "assistant", content: "older" },
        { role: "tool", content: "tool result", tool_call_id: "call-1" },
      ],
    }

    applyCopilotContextCache(payload)

    expect(payload.messages[1].copilot_cache_control).toEqual(cacheControl)
  })

  test("marks non-empty array content", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "array content" }],
        },
      ],
    }

    applyCopilotContextCache(payload)

    expect(payload.messages[0].copilot_cache_control).toEqual(cacheControl)
  })

  test("repeated application is idempotent and retains marker identities", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "latest" },
      ],
    }

    applyCopilotContextCache(payload)
    const snapshot = structuredClone(payload)
    const markers = payload.messages.map(
      (message) => message.copilot_cache_control,
    )

    applyCopilotContextCache(payload)

    expect(payload).toEqual(snapshot)
    expect(
      payload.messages.map((message) => message.copilot_cache_control),
    ).toEqual(markers)
    payload.messages.forEach((message, index) => {
      expect(message.copilot_cache_control).toBe(markers[index])
    })
  })
})
