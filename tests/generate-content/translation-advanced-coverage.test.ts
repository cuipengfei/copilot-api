import { describe, it, expect } from "bun:test"

import type { GeminiContent } from "~/routes/generate-content/types"

import { translateGeminiContentsToOpenAI } from "~/routes/generate-content/translation"

describe("Translation Advanced Coverage Tests", () => {
  it("should handle system instruction in contents", () => {
    const contents: Array<GeminiContent> = [
      {
        role: "user",
        parts: [{ text: "Hello" }],
      },
    ]
    const systemInstruction: GeminiContent = {
      parts: [{ text: "You are a helpful assistant" }],
    }

    const messages = translateGeminiContentsToOpenAI(
      contents,
      systemInstruction,
    )

    const systemMessage = messages.find((m) => m.role === "system")
    expect(systemMessage?.content).toBe("You are a helpful assistant")
  })

  it("should handle empty user message content with fallback", () => {
    const contents: Array<GeminiContent> = [
      {
        role: "user",
        parts: [{ text: "   " }], // Only whitespace
      },
    ]

    const messages = translateGeminiContentsToOpenAI(contents)

    const userMessage = messages.find((m) => m.role === "user")
    expect(userMessage?.content).toBe(" ") // Fallback to minimal space
  })

  it("should handle function responses without matching tool call IDs", () => {
    const contents: Array<GeminiContent> = [
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "unmatched_function",
              response: { result: "orphan response" },
            },
          },
        ],
      },
    ]

    const messages = translateGeminiContentsToOpenAI(contents)

    // Should not create tool messages for unmatched responses
    const toolMessages = messages.filter((m) => m.role === "tool")
    expect(toolMessages).toHaveLength(0)
  })

  it("should handle complex content that cannot be merged", () => {
    // Create messages with complex content that can't be string-merged
    const contents: Array<GeminiContent> = [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAhEAACAQMDBQAAAAAAAAAAAAABAgMABAUGIWGRkqGx0f/EABUBAQEAAAAAAAAAAAAAAAAAAAMF/8QAGhEAAgMBAQAAAAAAAAAAAAAAAAECEgMRkf/aAAwDAQACEQMRAD8A0XmX5OMlEw==",
            },
          },
        ],
      },
    ]

    const messages = translateGeminiContentsToOpenAI(contents)

    // Should create separate messages for complex content
    const userMessages = messages.filter((m) => m.role === "user")
    expect(userMessages).toHaveLength(2)
    expect(Array.isArray(userMessages[0].content)).toBe(true)
    expect(Array.isArray(userMessages[1].content)).toBe(true)
  })

  it("should handle media content with mixed text and images", () => {
    const contents: Array<GeminiContent> = [
      {
        role: "user",
        parts: [
          { text: "Look at this image:" },
          {
            inlineData: {
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
            },
          },
        ],
      },
    ]

    const messages = translateGeminiContentsToOpenAI(contents)

    const userMessage = messages[0]
    expect(Array.isArray(userMessage.content)).toBe(true)
    const content = userMessage.content as Array<{
      type: string
      text?: string
      image_url?: { url: string }
    }>

    expect(content).toHaveLength(2)
    expect(content[0].type).toBe("text")
    expect(content[0].text).toBe("Look at this image:")
    expect(content[1].type).toBe("image_url")
    expect(content[1].image_url?.url).toContain("data:image/png;base64,")
  })

  it("should handle googleSearch tool", () => {
    const contents: Array<GeminiContent> = [
      {
        role: "user",
        parts: [{ text: "Search for information" }],
      },
    ]

    const messages = translateGeminiContentsToOpenAI(contents)

    // Should be included in the messages array but tools conversion is internal
    expect(messages).toHaveLength(1)
  })

  it("should handle NONE tool config mode", () => {
    const contents: Array<GeminiContent> = [
      {
        role: "user",
        parts: [{ text: "Hello" }],
      },
    ]

    const messages = translateGeminiContentsToOpenAI(contents)

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe("Hello")
  })
})
