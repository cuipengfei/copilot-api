import { describe, expect, test } from "bun:test"
import consola from "consola"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"

import {
  createDroppedThinkingLog,
  THINKING_TEXT,
  translateToOpenAI,
} from "~/routes/messages/non-stream-translation"
import {
  countReasoningTextOpaqueDrops,
  describeReasoningTextOpaqueDrops,
} from "~/routes/provider/messages/handler"

// Observes consola output through consola's public reporter API. No mocks, no
// spies, no dependency replacement: the code under test calls the real
// consola instance and this reporter only records what passes through.
const captureConsolaInfo = async (
  run: () => void | Promise<void>,
): Promise<Array<string>> => {
  const messages: Array<string> = []
  const reporter = {
    log: (logObj: { type: string; args: Array<unknown> }) => {
      if (logObj.type === "info") {
        messages.push(logObj.args.map(String).join(" "))
      }
    },
  }
  const previousLevel = consola.level
  consola.level = 3
  consola.addReporter(reporter)
  try {
    await run()
  } finally {
    consola.removeReporter(reporter)
    consola.level = previousLevel
  }
  return messages
}

describe("countReasoningTextOpaqueDrops", () => {
  test("returns 0 when no assistant message carries reasoning fields", () => {
    expect(countReasoningTextOpaqueDrops([])).toBe(0)
    expect(
      countReasoningTextOpaqueDrops([
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
        { role: "assistant", content: "b", reasoning_text: undefined },
      ] as unknown as ChatCompletionsPayload["messages"]),
    ).toBe(0)
  })

  test("counts each assistant message carrying reasoning_text or reasoning_opaque exactly once", () => {
    const messages = [
      { role: "user", content: "u" },
      { role: "assistant", content: "a", reasoning_text: "thought" },
      { role: "assistant", content: "b", reasoning_opaque: "sig" },
      {
        role: "assistant",
        content: "c",
        reasoning_text: "thought",
        reasoning_opaque: "sig",
      },
      { role: "assistant", content: "d", reasoning_text: undefined },
      { role: "assistant", content: "e" },
    ] as unknown as ChatCompletionsPayload["messages"]

    expect(countReasoningTextOpaqueDrops(messages)).toBe(3)
  })
})

describe("describeReasoningTextOpaqueDrops", () => {
  test("matches the historical drop-thinking log line for openai-compatible providers", () => {
    expect(describeReasoningTextOpaqueDrops("reasoning_content", 2)).toBe(
      "drop thinking block, reason: openai-compatible provider does not recognize reasoning_text/reasoning_opaque; deleted after mapping to reasoning_content in 2 message(s)",
    )
    expect(describeReasoningTextOpaqueDrops("reasoning", 1)).toBe(
      "drop thinking block, reason: openai-compatible provider does not recognize reasoning_text/reasoning_opaque; deleted after mapping to reasoning in 1 message(s)",
    )
  })
})

describe("createDroppedThinkingLog", () => {
  test("matches the historical drop-thinking log line for the claude translation filter", () => {
    expect(createDroppedThinkingLog("claude-opus-4.6", 2)).toBe(
      "drop thinking block, reason: claude translation filter for claude-opus-4.6; dropped 2 block(s)",
    )
  })
})

describe("translateToOpenAI dropped-thinking observation", () => {
  const buildPayload = (model: string): AnthropicMessagesPayload => ({
    model,
    max_tokens: 100,
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: THINKING_TEXT,
            signature: "sig-placeholder",
          },
          { type: "thinking", thinking: "real thought", signature: "sig-real" },
          { type: "thinking", thinking: "gpt style", signature: "sig@openai" },
        ],
      },
      { role: "user", content: "again" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "keep me", signature: "sig-keep" },
        ],
      },
    ],
  })

  test("drops placeholder and cross-vendor thinking blocks from claude output and logs the exact count once", async () => {
    const logs = await captureConsolaInfo(() => {
      const result = translateToOpenAI(buildPayload("claude-opus-4.6"))
      const firstAssistant = result.messages[1]
      expect(firstAssistant).toMatchObject({
        reasoning_text: "real thought",
        reasoning_opaque: "sig-real",
      })
    })

    expect(logs).toEqual([createDroppedThinkingLog("claude-opus-4.6", 2)])
  })

  test("keeps per-request dropped counts isolated across translate calls", async () => {
    const logs = await captureConsolaInfo(() => {
      translateToOpenAI(buildPayload("claude-sonnet-4.6"))
      translateToOpenAI({
        model: "claude-sonnet-4.6",
        max_tokens: 100,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "clean", signature: "sig-clean" },
            ],
          },
        ],
      })
    })

    expect(logs).toEqual([createDroppedThinkingLog("claude-sonnet-4.6", 2)])
  })

  test("non-claude models keep every thinking block and log nothing", async () => {
    const logs = await captureConsolaInfo(() => {
      const result = translateToOpenAI(buildPayload("gpt-5"))
      const firstAssistant = result.messages[1]
      expect(firstAssistant).toMatchObject({
        reasoning_text: "real thought\n\ngpt style",
        reasoning_opaque: "sig-placeholder",
      })
    })

    expect(logs).toEqual([])
  })
})
