import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import type { ChatCompletionsPayload } from "~/services/copilot/chat-completions/types"
import type { ChatCompletionChunk } from "~/services/copilot/chat-completions/types-streaming"

import { isNullish } from "~/lib/is-nullish"
import { logger } from "~/lib/logger"
import { modelsCache } from "~/lib/models"
import { chatCompletions } from "~/services/copilot/chat-completions/service"
import { chatCompletionsStream } from "~/services/copilot/chat-completions/service-streaming"

function createCondensedStreamingResponse(
  finalChunk: ChatCompletionChunk,
  collectedContent: string,
) {
  return {
    id: finalChunk.id,
    model: finalChunk.model,
    created: finalChunk.created,
    object: "chat.completion",
    system_fingerprint: finalChunk.system_fingerprint,
    usage: finalChunk.usage,
    choices: [
      {
        index: 0,
        finish_reason: finalChunk.choices[0].finish_reason,
        message: {
          role: "assistant",
          content: collectedContent,
        },
        content_filter_results: finalChunk.choices[0].content_filter_results,
      },
    ],
  }
}

function handleStreaming(c: Context, payload: ChatCompletionsPayload) {
  return streamSSE(c, async (stream) => {
    const response = await chatCompletionsStream(payload)

    // For collecting the complete streaming response
    let collectedContent = ""
    let finalChunk: ChatCompletionChunk | null = null

    for await (const chunk of response) {
      await stream.writeSSE(chunk as SSEMessage)

      if (!logger.options.enabled) continue

      // Check if chunk data is "DONE" or not a valid JSON string
      if (!chunk.data || chunk.data === "[DONE]") {
        continue // Skip processing this chunk for logging
      }

      try {
        const data = JSON.parse(chunk.data) as ChatCompletionChunk

        // Keep track of the latest chunk for metadata
        finalChunk = data

        // Accumulate content from each delta
        if (typeof data.choices[0].delta.content === "string") {
          collectedContent += data.choices[0].delta.content
        }
      } catch (error) {
        // Handle JSON parsing errors gracefully
        consola.error(`Error parsing SSE chunk data`, error)
        // Continue processing other chunks
      }
    }

    // After streaming completes, log the condensed response
    if (finalChunk) {
      const condensedResponse = createCondensedStreamingResponse(
        finalChunk,
        collectedContent,
      )

      await logger.logResponse("/chat/completions", condensedResponse, {})
    }
  })
}

async function handleNonStreaming(c: Context, payload: ChatCompletionsPayload) {
  const response = await chatCompletions(payload)

  // Get response headers if any
  const responseHeaders = {} // Empty placeholder for response headers

  // Log the non-streaming response with headers
  await logger.logResponse("/chat/completions", response, responseHeaders)

  return c.json(response)
}

export async function handleCompletion(c: Context) {
  const models = modelsCache.getModels()
  let payload = await c.req.json<ChatCompletionsPayload>()

  if (isNullish(payload.max_tokens)) {
    const selectedModel = models?.data.find(
      (model) => model.id === payload.model,
    )

    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
  }

  // Convert request headers to a regular object from Headers
  const requestHeaders = c.req.header()

  // Log the request at the beginning for both streaming and non-streaming cases
  await logger.logRequest("/chat/completions", "POST", payload, requestHeaders)

  if (payload.stream) {
    return handleStreaming(c, payload)
  }

  return handleNonStreaming(c, payload)
}
