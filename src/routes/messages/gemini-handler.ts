import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

// Helper function to extract model from URL path
function extractModelFromUrl(url: string): string {
  const match = url.match(/\/v1beta\/models\/([^:]+):/)
  if (!match) {
    throw new Error("Model name is required in URL path")
  }
  return match[1]
}

// Helper function to safely get array length
function getArrayLength(arr: unknown): number {
  return Array.isArray(arr) ? arr.length : 0
}

// Helper function to safely get model string
function getModelString(data: unknown): string {
  return (data as { model?: string }).model || "unknown"
}

// Helper function to create summary object
function createDataSummary(data: unknown) {
  const dataObj = data as Record<string, unknown>
  return {
    hasContents: Boolean(dataObj.contents),
    contentsLength: getArrayLength(dataObj.contents),
    hasGenerationConfig: Boolean(dataObj.generationConfig),
    hasTools: Boolean(dataObj.tools),
    toolsLength: getArrayLength(dataObj.tools),
    hasCandidates: Boolean(dataObj.candidates),
    candidatesLength: getArrayLength(dataObj.candidates),
    hasUsageMetadata: Boolean(dataObj.usageMetadata),
    hasChoices: Boolean(dataObj.choices),
    choicesLength: getArrayLength(dataObj.choices),
    model: getModelString(data),
  }
}

// Helper function to log request/response structure without content details
function logStructure(data: unknown, label: string) {
  const summary = createDataSummary(data)
  console.info(`[GEMINI_${label}]`, summary)
}
import {
  translateGeminiToOpenAINonStream,
  translateGeminiToOpenAIStream,
  translateOpenAIToGemini,
  translateGeminiCountTokensToOpenAI,
  translateTokenCountToGemini,
  translateOpenAIChunkToGemini,
} from "./gemini-translation"
import {
  type GeminiRequest,
  type GeminiCountTokensRequest,
  type GeminiStreamResponse,
  type GeminiResponse,
} from "./gemini-types"

// Standard generation endpoint
export async function handleGeminiGeneration(c: Context) {
  const model = extractModelFromUrl(c.req.url)

  if (!model) {
    throw new Error("Model name is required in URL path")
  }

  await checkRateLimit(state)

  const geminiPayload = await c.req.json<GeminiRequest>()
  logStructure(geminiPayload, "INCOMING_REQUEST")

  const openAIPayload = translateGeminiToOpenAINonStream(geminiPayload, model)
  logStructure(openAIPayload, "TRANSLATED_TO_OPENAI")

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)
  logStructure(response, "COPILOT_RESPONSE")

  if (isNonStreaming(response)) {
    const geminiResponse = translateOpenAIToGemini(response)
    logStructure(geminiResponse, "FINAL_TO_CLIENT")

    return c.json(geminiResponse)
  }

  // This shouldn't happen for non-streaming endpoint
  throw new Error("Unexpected streaming response for non-streaming endpoint")
}

// Helper function to handle non-streaming response conversion
function handleNonStreamingToStreaming(
  c: Context,
  geminiResponse: GeminiResponse,
) {
  return streamSSE(c, async (stream) => {
    try {
      const firstPart = geminiResponse.candidates[0]?.content?.parts?.[0]
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const hasTextContent = firstPart && "text" in firstPart

      // eslint-disable-next-line unicorn/prefer-ternary
      if (hasTextContent) {
        await sendTextInChunks(stream, firstPart.text, geminiResponse)
      } else {
        await sendFallbackResponse(stream, geminiResponse)
      }

      // Add a small delay to ensure all data is flushed
      await new Promise((resolve) => setTimeout(resolve, 50))
    } catch (error) {
      console.error("[GEMINI_STREAM] Error in non-streaming conversion", error)
    } finally {
      try {
        await stream.close()
        console.info(
          "[GEMINI_STREAM] Non-streaming conversion stream closed successfully",
        )
      } catch (closeError) {
        console.error(
          "[GEMINI_STREAM] Error closing non-streaming conversion stream",
          closeError,
        )
      }
    }
  })
}

// Helper function to send text in chunks with configuration object
async function sendTextInChunks(
  stream: SSEStreamingApi,
  text: string,
  geminiResponse: GeminiResponse,
) {
  const chunkSize = Math.max(1, Math.min(50, text.length))
  let lastWritePromise: Promise<void> = Promise.resolve()

  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize)
    const isLast = i + chunkSize >= text.length
    const streamResponse: GeminiStreamResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: chunk }],
            role: "model",
          },
          finishReason:
            isLast ? geminiResponse.candidates[0]?.finishReason : undefined,
          index: 0,
        },
      ],
      ...(isLast && geminiResponse.usageMetadata ?
        { usageMetadata: geminiResponse.usageMetadata }
      : {}),
    }

    // Wait for previous write to complete before writing new chunk
    await lastWritePromise
    lastWritePromise = stream.writeSSE({
      data: JSON.stringify(streamResponse),
    })
  }

  // Wait for final write to complete
  await lastWritePromise
}

// Helper function to send fallback response
async function sendFallbackResponse(
  stream: SSEStreamingApi,
  geminiResponse: GeminiResponse,
) {
  const streamResponse: GeminiStreamResponse = {
    candidates: geminiResponse.candidates,
    usageMetadata: geminiResponse.usageMetadata,
  }

  await stream.writeSSE({ data: JSON.stringify(streamResponse) })
}

// Helper function to process chunk and write to stream
async function processAndWriteChunk(
  rawEvent: { data?: string },
  stream: SSEStreamingApi,
  lastWritePromise: Promise<void>,
): Promise<{ newWritePromise: Promise<void>; hasFinishReason: boolean }> {
  if (!rawEvent.data) {
    console.info("[GEMINI_STREAM] Skipping empty chunk")
    return { newWritePromise: lastWritePromise, hasFinishReason: false }
  }

  try {
    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
    const geminiChunk = translateOpenAIChunkToGemini(chunk)

    if (geminiChunk) {
      // Check if this chunk contains a finish reason
      const chunkHasFinishReason = geminiChunk.candidates.some(
        (c) => c.finishReason && c.finishReason !== "FINISH_REASON_UNSPECIFIED",
      )

      if (chunkHasFinishReason) {
        console.info("[GEMINI_STREAM] Detected finish reason in chunk", {
          finishReason: geminiChunk.candidates[0].finishReason,
        })
      }

      console.info("[GEMINI_STREAM] Writing SSE chunk", {
        candidatesCount: geminiChunk.candidates.length || 0,
        hasUsageMetadata: Boolean(geminiChunk.usageMetadata),
        hasFinishReason: chunkHasFinishReason,
      })

      // Log structure of each chunk sent to client (but only once per chunk)
      logStructure(geminiChunk, "STREAM_CHUNK_TO_CLIENT")

      // Wait for previous write to complete before writing new chunk
      await lastWritePromise
      const newWritePromise = stream.writeSSE({
        data: JSON.stringify(geminiChunk),
      })

      return { newWritePromise, hasFinishReason: chunkHasFinishReason }
    } else {
      console.info("[GEMINI_STREAM] Skipping null gemini chunk")
      return { newWritePromise: lastWritePromise, hasFinishReason: false }
    }
  } catch (parseError) {
    console.error("[GEMINI_STREAM] Error parsing chunk", parseError)
    return { newWritePromise: lastWritePromise, hasFinishReason: false }
  }
}

// Helper function to handle streaming response processing
function handleStreamingResponse(
  c: Context,
  response: AsyncIterable<{ data?: string }>,
) {
  return streamSSE(c, async (stream) => {
    console.info("[GEMINI_STREAM] Starting streaming response processing")
    let chunkCount = 0
    let hasFinishReason = false
    let lastWritePromise: Promise<void> = Promise.resolve()

    try {
      for await (const rawEvent of response) {
        chunkCount++
        console.info(`[GEMINI_STREAM] Processing chunk ${chunkCount}`, {
          hasData: Boolean(rawEvent.data),
          isDone: rawEvent.data === "[DONE]",
        })

        if (rawEvent.data === "[DONE]") {
          console.info("[GEMINI_STREAM] Received [DONE] signal, breaking")
          break
        }

        const result = await processAndWriteChunk(
          rawEvent,
          stream,
          lastWritePromise,
        )
        lastWritePromise = result.newWritePromise
        if (result.hasFinishReason) {
          hasFinishReason = true
        }
      }

      // Wait for all writes to complete before closing
      await lastWritePromise

      // Add a small delay to ensure all data is flushed
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Ensure we properly signal completion - if we had a finish reason, we're done
      if (hasFinishReason) {
        console.info(
          "[GEMINI_STREAM] Stream completed with finish reason - proper termination",
        )
      } else {
        console.info(
          "[GEMINI_STREAM] Stream completed without finish reason - possible incomplete stream",
        )
      }

      console.info(
        `[GEMINI_STREAM] Streaming complete, processed ${chunkCount} chunks, closing stream`,
      )
    } catch (error) {
      console.error("[GEMINI_STREAM] Error in streaming processing", error)
      // Ensure we don't leave the stream hanging
    } finally {
      // Always close the stream, but with proper cleanup
      try {
        await stream.close()
        console.info("[GEMINI_STREAM] Stream closed successfully")
      } catch (closeError) {
        console.error("[GEMINI_STREAM] Error closing stream", closeError)
      }
    }
  })
}

// Streaming generation endpoint
export async function handleGeminiStreamGeneration(c: Context) {
  const model = extractModelFromUrl(c.req.url)

  if (!model) {
    throw new Error("Model name is required in URL path")
  }

  await checkRateLimit(state)

  const geminiPayload = await c.req.json<GeminiRequest>()
  logStructure(geminiPayload, "INCOMING_STREAM_REQUEST")

  const openAIPayload = translateGeminiToOpenAIStream(geminiPayload, model)
  logStructure(openAIPayload, "TRANSLATED_STREAM_TO_OPENAI")

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)
  console.info(
    "[GEMINI_COPILOT_STREAM_RESPONSE] Received streaming response from Copilot",
  )

  if (isNonStreaming(response)) {
    const geminiResponse = translateOpenAIToGemini(response)

    return handleNonStreamingToStreaming(c, geminiResponse)
  }

  return handleStreamingResponse(c, response)
}

// Token counting endpoint
export async function handleGeminiCountTokens(c: Context) {
  const model = extractModelFromUrl(c.req.url)

  if (!model) {
    throw new Error("Model name is required in URL path")
  }

  const geminiPayload = await c.req.json<GeminiCountTokensRequest>()

  const openAIPayload = translateGeminiCountTokensToOpenAI(geminiPayload, model)

  const tokenCounts = getTokenCount(openAIPayload.messages)

  const totalTokens = tokenCounts.input + tokenCounts.output
  const geminiResponse = translateTokenCountToGemini(totalTokens)

  return c.json(geminiResponse)
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => "choices" in response
