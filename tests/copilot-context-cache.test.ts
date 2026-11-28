import { describe, expect, test } from "bun:test"

import type {
  ChatCompletionsPayload,
  CopilotCacheControl,
  Message,
} from "~/lib/types/chat-completions"
import { applyCopilotContextCache } from "~/services/copilot/context-cache"

const cacheControl = { type: "ephemeral" } as const

describe("applyCopilotContextCache legacy strategy", () => {
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

    applyCopilotContextCache(payload, "legacy")

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

    applyCopilotContextCache(payload, "legacy")

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

    applyCopilotContextCache(payload, "legacy")

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

    applyCopilotContextCache(payload, "legacy")

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

    applyCopilotContextCache(payload, "legacy")

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

    applyCopilotContextCache(payload, "legacy")

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

    applyCopilotContextCache(payload, "legacy")
    const snapshot = structuredClone(payload)
    const markers = payload.messages.map(
      (message) => message.copilot_cache_control,
    )

    applyCopilotContextCache(payload, "legacy")

    expect(payload).toEqual(snapshot)
    expect(
      payload.messages.map((message) => message.copilot_cache_control),
    ).toEqual(markers)
    payload.messages.forEach((message, index) => {
      expect(message.copilot_cache_control).toBe(markers[index])
    })
  })
})

const markedMessageIndexes = (payload: ChatCompletionsPayload) =>
  payload.messages.flatMap((message, index) =>
    message.copilot_cache_control === undefined ? [] : [index],
  )

describe("applyCopilotContextCache Gemini strategy", () => {
  test("uses reverse order across the latest user and all no-tool assistant replies", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        { role: "system", content: "system one" },
        { role: "system", content: "system two" },
        { role: "system", content: "system three" },
        { role: "user", content: "first user" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second user" },
        { role: "assistant", content: "second answer", tool_calls: [] },
        { role: "user", content: "latest user" },
        { role: "assistant", content: "latest answer" },
      ],
    }

    applyCopilotContextCache(payload, "gemini")

    expect(markedMessageIndexes(payload)).toEqual([4, 6, 7, 8])
  })

  test.each([
    [0, [7, 9, 10, 11]],
    [1, [0, 9, 10, 11]],
    [2, [0, 1, 10, 11]],
    [3, [0, 1, 2, 11]],
    [4, [0, 1, 2, 3]],
    [5, [0, 1, 2, 3, 4]],
    [6, [0, 1, 2, 3, 4, 5]],
  ] satisfies Array<[number, Array<number>]>)(
    "counts %i existing markers before choosing candidates",
    (existingCount, expectedIndexes) => {
      const existingMarkers = Array.from({ length: existingCount }, () => ({
        type: "ephemeral" as const,
      }))
      const payload: ChatCompletionsPayload = {
        model: "gemini-test",
        messages: [
          ...Array.from({ length: 6 }, (_, index): Message => ({
            role: "developer",
            content: null,
            ...(index < existingCount ?
              { copilot_cache_control: existingMarkers[index] }
            : {}),
          })),
          { role: "user", content: "first user" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "second user" },
          { role: "assistant", content: "second answer" },
          { role: "user", content: "latest user" },
          { role: "assistant", content: "latest answer" },
        ],
      }
      const snapshot = structuredClone(payload)

      applyCopilotContextCache(payload, "gemini")

      expect(markedMessageIndexes(payload)).toEqual(expectedIndexes)
      existingMarkers.forEach((marker, index) => {
        expect(payload.messages[index].copilot_cache_control).toBe(marker)
      })
      if (existingCount >= 4) expect(payload).toEqual(snapshot)
      const processed = structuredClone(payload)
      applyCopilotContextCache(payload, "gemini")
      expect(payload).toEqual(processed)
      const replay = JSON.parse(
        JSON.stringify(payload),
      ) as ChatCompletionsPayload
      applyCopilotContextCache(replay, "gemini")
      expect(replay).toEqual(processed)
    },
  )

  test("marks the last tool result of each current round from newest to oldest", () => {
    const toolCall = {
      id: "call-1",
      type: "function" as const,
      function: { name: "lookup", arguments: "{}" },
    }
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "latest user" },
        { role: "assistant", content: "calling", tool_calls: [toolCall] },
        { role: "tool", content: "round one first", tool_call_id: "call-1" },
        { role: "tool", content: "round one last", tool_call_id: "call-2" },
        { role: "assistant", content: "calling", tool_calls: [toolCall] },
        { role: "tool", content: "round two first", tool_call_id: "call-3" },
        { role: "tool", content: "round two last", tool_call_id: "call-4" },
        { role: "assistant", content: "calling", tool_calls: [toolCall] },
        { role: "tool", content: "round three first", tool_call_id: "call-5" },
        { role: "tool", content: "round three last", tool_call_id: "call-6" },
      ],
    }
    const expected = structuredClone(payload)
    for (const index of [1, 4, 7, 10]) {
      expected.messages[index].copilot_cache_control = cacheControl
    }

    applyCopilotContextCache(payload, "gemini")

    expect(payload).toEqual(expected)
  })

  test("does not move a tool batch marker to an earlier result when its last result is empty", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        { role: "user", content: "latest user" },
        { role: "tool", content: "first result", tool_call_id: "call-1" },
        { role: "tool", content: [], tool_call_id: "call-2" },
      ],
    }

    applyCopilotContextCache(payload, "gemini")

    expect(markedMessageIndexes(payload)).toEqual([0])
  })

  test.each([
    { content: "" },
    { content: null },
    { content: [] },
  ] satisfies Array<{ content: Message["content"] }>)(
    "an empty current user still excludes historical users and tool results (%j)",
    ({ content }) => {
      const payload: ChatCompletionsPayload = {
        model: "gemini-test",
        messages: [
          {
            role: "assistant",
            content: "calling",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            content: "historical result",
            tool_call_id: "call-1",
          },
          { role: "user", content: "historical user" },
          { role: "assistant", content: "historical answer" },
          { role: "user", content },
        ],
      }

      applyCopilotContextCache(payload, "gemini")

      expect(markedMessageIndexes(payload)).toEqual([3])
    },
  )

  test("an already marked current user still excludes historical users and tool results on replay", () => {
    const existingMarker: CopilotCacheControl = { type: "ephemeral" }
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        {
          role: "assistant",
          content: "calling",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "historical result", tool_call_id: "call-1" },
        { role: "user", content: "historical user" },
        { role: "assistant", content: "historical answer" },
        {
          role: "user",
          content: "latest user",
          copilot_cache_control: existingMarker,
        },
        { role: "assistant", content: "latest answer" },
      ],
    }

    applyCopilotContextCache(payload, "gemini")

    expect(markedMessageIndexes(payload)).toEqual([3, 4, 5])
    expect(payload.messages[4].copilot_cache_control).toBe(existingMarker)
    const snapshot = structuredClone(payload)
    const markers = payload.messages.map(
      (message) => message.copilot_cache_control,
    )
    applyCopilotContextCache(payload, "gemini")
    expect(payload).toEqual(snapshot)
    payload.messages.forEach((message, index) => {
      expect(message.copilot_cache_control).toBe(markers[index])
    })
    const replay = JSON.parse(JSON.stringify(payload)) as ChatCompletionsPayload
    applyCopilotContextCache(replay, "gemini")
    expect(replay).toEqual(snapshot)
  })

  test("without a user, marks tool batch ends and assistant replies before filling the prefix", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        { role: "system", content: "system" },
        {
          role: "assistant",
          content: "calling",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "first result", tool_call_id: "call-1" },
        { role: "tool", content: "last result", tool_call_id: "call-2" },
        { role: "assistant", content: "answer" },
        { role: "tool", content: "second first", tool_call_id: "call-3" },
        { role: "tool", content: "second last", tool_call_id: "call-4" },
      ],
    }

    applyCopilotContextCache(payload, "gemini")

    expect(markedMessageIndexes(payload)).toEqual([0, 3, 4, 6])
  })

  test("recognizes the final tool batch even when the message array starts with tools", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        { role: "tool", content: "first" },
        { role: "tool", content: "last" },
        {
          role: "assistant",
          content: "calling",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "second first" },
        { role: "tool", content: "second last" },
      ],
    }

    applyCopilotContextCache(payload, "gemini")

    expect(markedMessageIndexes(payload)).toEqual([1, 4])
  })

  test("prefix filling skips marked and empty messages and stops at the first other role", () => {
    const existingMarker: CopilotCacheControl = { type: "ephemeral" }
    const content: Message["content"] = [
      { type: "text", text: "context", cache_control: cacheControl },
    ]
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        { role: "system", content: "" },
        {
          role: "system",
          content: "context",
          copilot_cache_control: existingMarker,
        },
        { role: "user", content: null },
        { role: "user", content },
        { role: "developer", content: "stop prefix" },
        {
          role: "assistant",
          content: "calling",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { role: "system", content: "outside prefix" },
        { role: "user", content: "" },
      ],
    }

    applyCopilotContextCache(payload, "gemini")

    expect(markedMessageIndexes(payload)).toEqual([1, 3])
    expect(payload.messages[1].copilot_cache_control).toBe(existingMarker)
    expect(payload.messages[3].content).toBe(content)
  })

  test("leaves messages unchanged when no content can receive a marker", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        { role: "system", content: "" },
        { role: "system", content: null },
        { role: "system", content: [] },
        { role: "assistant", content: "" },
        { role: "assistant", content: null },
        { role: "assistant", content: [] },
        { role: "user", content: "" },
      ],
    }
    const snapshot = structuredClone(payload)

    applyCopilotContextCache(payload, "gemini")

    expect(payload).toEqual(snapshot)
  })

  test("preserves all payload fields and message identities except newly added markers", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "first user", name: "person" },
        {
          role: "assistant",
          content: "answer",
          tool_calls: [],
          reasoning_content: "thinking",
          reasoning_text: "reasoning",
          reasoning_opaque: "opaque",
          reasoning: "retained",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "latest", cache_control: cacheControl },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
      tool_choice: "auto",
      reasoning_effort: "high",
      temperature: 0.5,
      parallel_tool_calls: true,
    }
    const expected = structuredClone(payload)
    for (const index of [0, 1, 2, 3]) {
      expected.messages[index].copilot_cache_control = cacheControl
    }
    const messages = [...payload.messages]
    const content = payload.messages[3].content
    const tools = payload.tools

    applyCopilotContextCache(payload, "gemini")

    expect(payload).toEqual(expected)
    payload.messages.forEach((message, index) =>
      expect(message).toBe(messages[index]),
    )
    expect(payload.messages[3].content).toBe(content)
    expect(payload.tools).toBe(tools)
  })

  test("accepts an empty conversation without creating messages", () => {
    const payload: ChatCompletionsPayload = {
      model: "gemini-test",
      messages: [],
    }

    applyCopilotContextCache(payload, "gemini")

    expect(payload).toEqual({ model: "gemini-test", messages: [] })
  })
})
