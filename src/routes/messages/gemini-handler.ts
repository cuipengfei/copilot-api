import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"
import { promises as fs } from "node:fs"
import path from "node:path"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

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

// Helper function to extract model from URL path
function extractModelFromUrl(url: string): string | undefined {
  const path = new URL(url).pathname
  const match = path.match(/^\/v1beta\/models\/([^:]+):/)
  return match?.[1]
}

// Debug logging interface
interface GeminiDebugLog {
  timestamp: string
  type:
    | "request"
    | "response"
    | "translation"
    | "error"
    | "stream_chunk"
    | "stream_translation"
  endpoint: string
  data: unknown
  copilotRequest?: unknown
  copilotResponse?: unknown
  finalResponse?: unknown
}

// File logging functions
async function writeLogToFile(logEntry: GeminiDebugLog) {
  const logsDir = path.join(process.cwd(), "logs")

  try {
    // Ensure logs directory exists
    await fs.mkdir(logsDir, { recursive: true })

    // Truncate large data before logging
    const truncatedEntry = {
      ...logEntry,
      data: truncateData(logEntry.data),
      copilotRequest: truncateData(logEntry.copilotRequest),
      copilotResponse: truncateData(logEntry.copilotResponse),
      finalResponse: truncateData(logEntry.finalResponse),
    }

    const logLine = JSON.stringify(truncatedEntry) + "\n"

    // Write to main debug log
    await fs.appendFile(path.join(logsDir, "gemini-debug.log"), logLine)

    // Write to specific logs based on type
    if (logEntry.type === "error") {
      await fs.appendFile(path.join(logsDir, "gemini-errors.log"), logLine)
    } else if (
      logEntry.type === "translation"
      || logEntry.type === "stream_translation"
    ) {
      await fs.appendFile(path.join(logsDir, "gemini-translation.log"), logLine)
    }
  } catch (error) {
    consola.error("Failed to write log file:", error)
  }
}

// NEW: Write incoming request logs to separate file for detailed analysis
async function writeIncomingRequestLogToFile(logEntry: GeminiDebugLog) {
  const logsDir = path.join(process.cwd(), "logs")

  try {
    // Ensure logs directory exists
    await fs.mkdir(logsDir, { recursive: true })

    // For incoming requests, we want more detail but still truncate huge payloads
    const truncatedEntry = {
      ...logEntry,
      data: truncateData(logEntry.data, 500), // Allow more detail for incoming requests
    }

    const logLine = JSON.stringify(truncatedEntry) + "\n"

    // Write to dedicated incoming requests log
    await fs.appendFile(
      path.join(logsDir, "gemini-incoming-requests.log"),
      logLine,
    )
  } catch (error) {
    consola.error("Failed to write incoming request log file:", error)
  }
}

// Helper function to truncate data for logging
function truncateData(data: unknown, maxLength = 100): unknown {
  if (typeof data === "string") {
    return data.length > maxLength ? `${data.slice(0, maxLength)}...` : data
  }

  if (Array.isArray(data)) {
    return data.map((item) => truncateData(item, maxLength))
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    const result: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(obj)) {
      if (key === "messages" && Array.isArray(value)) {
        result[key] = value.map((msg: { role: string; content: unknown }) => ({
          role: msg.role,
          content: getContentDisplay(msg.content),
        }))
      } else if (key === "contents" && Array.isArray(value)) {
        result[key] = value.map(
          (content: { role: string; parts?: Array<unknown> }) => ({
            role: content.role,
            parts:
              Array.isArray(content.parts) && content.parts.length > 0 ?
                `[${content.parts.length} parts]`
              : content.parts,
          }),
        )
      } else {
        result[key] = truncateData(value, maxLength)
      }
    }
    return result
  }

  return data
}

// Helper function to display content for logging
function getContentDisplay(content: unknown): unknown {
  if (typeof content === "string") {
    return truncateData(content, 100)
  }
  if (Array.isArray(content) && content.length > 0) {
    return `[content array: ${content.length} items]`
  }
  return content
}

// Debug logging functions
function logGeminiDebug(
  type: string,
  endpoint: string,
  options: { data: unknown; extra?: Record<string, unknown> },
) {
  const { data, extra } = options
  const truncatedData = truncateData(data)
  const truncatedExtra = extra ? truncateData(extra) : undefined

  const logEntry: GeminiDebugLog = {
    timestamp: new Date().toISOString(),
    type: type as GeminiDebugLog["type"],
    endpoint,
    data: truncatedData,
    ...(truncatedExtra as Record<string, unknown>),
  }

  // Console logging - more concise
  const endpointPath = new URL(endpoint).pathname
  consola.debug(`[GEMINI-${type.toUpperCase()}] ${endpointPath}`)

  // File logging (async, don't wait) - now always write but with truncated data
  writeLogToFile(logEntry).catch((error: unknown) =>
    consola.error("Log file write error:", error),
  )
}

// NEW: Enhanced logging function for incoming Gemini requests
function logGeminiIncomingRequest({
  type,
  endpoint,
  rawPayload,
  translatedPayload,
}: {
  type: string
  endpoint: string
  rawPayload: unknown
  translatedPayload?: unknown
}) {
  const logEntry: GeminiDebugLog = {
    timestamp: new Date().toISOString(),
    type: type as GeminiDebugLog["type"],
    endpoint,
    data: {
      incomingRequest: rawPayload, // Full incoming request from Gemini CLI
      translatedRequest: translatedPayload, // Our translation to OpenAI format
    },
  }

  const endpointPath = new URL(endpoint).pathname
  consola.debug(`[GEMINI-INCOMING-${type.toUpperCase()}] ${endpointPath}`)

  // Write to special incoming requests log file
  writeIncomingRequestLogToFile(logEntry).catch((error: unknown) =>
    consola.error("Incoming request log file write error:", error),
  )
}

function logGeminiError(endpoint: string, error: unknown, data?: unknown) {
  const truncatedData = data ? truncateData(data) : undefined

  // Extract HTTP error details if it's an HTTPError
  let httpErrorDetails: Record<string, unknown> | undefined
  if (error instanceof HTTPError) {
    httpErrorDetails = {
      status: error.response.status,
      statusText: error.response.statusText,
      url: error.response.url,
      headers: Object.fromEntries(error.response.headers.entries()),
    }
  }

  const logEntry: GeminiDebugLog = {
    timestamp: new Date().toISOString(),
    type: "error",
    endpoint,
    data: {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      httpDetails: httpErrorDetails,
      data: truncatedData,
    },
  }

  // Console logging - more concise
  const endpointPath = new URL(endpoint).pathname
  consola.error(
    `[GEMINI-ERROR] ${endpointPath}: ${error instanceof Error ? error.message : String(error)}`,
  )

  // File logging (async, don't wait)
  writeLogToFile(logEntry).catch((logError: unknown) =>
    consola.error("Log file write error:", logError),
  )
}

// Error handling helper
function getErrorStatusAndMessage(error: unknown): {
  status: number
  message: string
} {
  if (!(error instanceof Error)) {
    return { status: 500, message: "Internal server error" }
  }

  const errorMappings = [
    {
      condition: (err: Error) =>
        err.name === "RateLimitError" || err.message.includes("rate limit"),
      status: 429,
      message: "Rate limit exceeded",
    },
    {
      condition: (err: Error) =>
        err.name === "ValidationError" || err.message.includes("validation"),
      status: 400,
      message: "Invalid request",
    },
    {
      condition: (err: Error) =>
        err.name === "AuthenticationError" || err.message.includes("auth"),
      status: 401,
      message: "Authentication failed",
    },
    {
      condition: (err: Error) =>
        err.name === "NotFoundError" || err.message.includes("not found"),
      status: 404,
      message: "Resource not found",
    },
  ]

  for (const mapping of errorMappings) {
    if (mapping.condition(error)) {
      return { status: mapping.status, message: mapping.message }
    }
  }

  return { status: 500, message: "Internal server error" }
}

// Standard generation endpoint
export async function handleGeminiGeneration(c: Context) {
  const endpoint = c.req.url
  const model = extractModelFromUrl(endpoint)

  if (!model) {
    return c.json({ error: "Model name is required in URL path" }, 400)
  }

  // IMMEDIATE DEBUG: Log that we entered this handler
  logGeminiDebug("handler_entry_GENERATION", endpoint, {
    data: {
      endpoint: endpoint,
      model: model,
      context: "Entered handleGeminiGeneration handler (NON-STREAMING)",
    },
  })

  try {
    await checkRateLimit(state)

    const geminiPayload = await c.req.json<GeminiRequest>()
    logGeminiDebug("request", endpoint, { data: geminiPayload })

    const openAIPayload = translateGeminiToOpenAINonStream(geminiPayload, model)

    // NEW: Log detailed incoming request with full context
    logGeminiIncomingRequest({
      type: "generation_request",
      endpoint,
      rawPayload: geminiPayload,
      translatedPayload: openAIPayload,
    })

    logGeminiDebug("translation", endpoint, {
      data: openAIPayload,
      extra: { copilotRequest: openAIPayload },
    })

    if (state.manualApprove) {
      await awaitApproval()
    }

    const response = await createChatCompletions(openAIPayload)

    if (isNonStreaming(response)) {
      logGeminiDebug("response", endpoint, {
        data: response,
        extra: { copilotResponse: response },
      })

      const geminiResponse = translateOpenAIToGemini(response)
      logGeminiDebug("translation", endpoint, {
        data: geminiResponse,
        extra: { finalResponse: geminiResponse },
      })

      return c.json(geminiResponse)
    }

    // This shouldn't happen for non-streaming endpoint
    logGeminiError(
      endpoint,
      new Error("Unexpected streaming response for non-streaming endpoint"),
    )
    return c.json({ error: "Internal error" }, 500)
  } catch (error) {
    logGeminiError(endpoint, error)
    const { status, message } = getErrorStatusAndMessage(error)
    return c.json({ error: message }, status as 400 | 401 | 404 | 429 | 500)
  }
}

// Helper function to handle non-streaming response conversion
function handleNonStreamingToStreaming(
  c: Context,
  geminiResponse: GeminiResponse,
  endpoint: string,
) {
  return streamSSE(c, async (stream) => {
    logGeminiDebug("non_streaming_conversion", endpoint, {
      data: {
        geminiResponse: truncateData(geminiResponse),
        context: "Converting non-streaming response to streaming",
      },
    })

    const textContent = geminiResponse.candidates[0]?.content?.parts?.[0]

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    await (textContent && "text" in textContent ?
      sendTextInChunks(stream, textContent.text, {
        geminiResponse,
        endpoint,
      })
    : sendFallbackResponse(stream, geminiResponse, endpoint))

    logGeminiDebug("stream_closing", endpoint, {
      data: { context: "Closing non-streaming to streaming conversion" },
    })
    await stream.close()
  })
}

// Helper function to send text in chunks with configuration object
async function sendTextInChunks(
  stream: SSEStreamingApi,
  text: string,
  options: { geminiResponse: GeminiResponse; endpoint: string },
) {
  const { geminiResponse, endpoint } = options
  logGeminiDebug("text_chunking", endpoint, {
    data: {
      text: text,
      textLength: text.length,
      context: "Processing text for chunking",
    },
  })
  const chunkSize = Math.max(1, Math.min(50, text.length))

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

    logGeminiDebug("chunk_sending", endpoint, {
      data: {
        chunkNumber: Math.floor(i / chunkSize) + 1,
        chunk: chunk,
        isLast: isLast,
        streamResponse: truncateData(streamResponse),
      },
    })
    await stream.writeSSE({ data: JSON.stringify(streamResponse) })
  }
}

// Helper function to send fallback response
async function sendFallbackResponse(
  stream: SSEStreamingApi,
  geminiResponse: GeminiResponse,
  endpoint: string,
) {
  logGeminiDebug("fallback_processing", endpoint, {
    data: {
      candidates: truncateData(geminiResponse.candidates),
      context: "Using fallback for non-text or empty content",
    },
  })
  const streamResponse: GeminiStreamResponse = {
    candidates: geminiResponse.candidates,
    usageMetadata: geminiResponse.usageMetadata,
  }

  await stream.writeSSE({ data: JSON.stringify(streamResponse) })
}

// Helper function to handle streaming response processing
function handleStreamingResponse(
  c: Context,
  response: AsyncIterable<{ data?: string }>,
  endpoint: string,
) {
  return streamSSE(c, async (stream) => {
    try {
      for await (const rawEvent of response) {
        logGeminiDebug("stream_chunk", endpoint, { data: rawEvent })

        if (rawEvent.data === "[DONE]") {
          break
        }

        if (!rawEvent.data) {
          continue
        }

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        const geminiChunk = translateOpenAIChunkToGemini(chunk)

        if (geminiChunk) {
          logGeminiDebug("stream_translation", endpoint, { data: geminiChunk })
          await stream.writeSSE({
            data: JSON.stringify(geminiChunk),
          })
        }
      }
    } catch (streamError) {
      logGeminiError(endpoint, streamError, { context: "streaming_loop" })
    } finally {
      // Log that stream processing ended (either completed or cancelled)
      logGeminiDebug("stream_cleanup", endpoint, {
        data: { context: "Stream processing completed or cancelled" },
      })
    }
  })
}

// Streaming generation endpoint
export async function handleGeminiStreamGeneration(c: Context) {
  const endpoint = c.req.url
  const model = extractModelFromUrl(endpoint)

  if (!model) {
    return c.json({ error: "Model name is required in URL path" }, 400)
  }

  logGeminiDebug("handler_entry", endpoint, {
    data: {
      endpoint: endpoint,
      model: model,
      context: "Entered handleGeminiStreamGeneration handler",
    },
  })

  try {
    await checkRateLimit(state)

    const geminiPayload = await c.req.json<GeminiRequest>()
    logGeminiDebug("request", endpoint, { data: geminiPayload })

    const openAIPayload = translateGeminiToOpenAIStream(geminiPayload, model)

    // NEW: Log detailed incoming request with full context
    logGeminiIncomingRequest({
      type: "stream_request",
      endpoint,
      rawPayload: geminiPayload,
      translatedPayload: openAIPayload,
    })

    logGeminiDebug("translation", endpoint, {
      data: openAIPayload,
      extra: { copilotRequest: openAIPayload },
    })

    if (state.manualApprove) {
      await awaitApproval()
    }

    const response = await createChatCompletions(openAIPayload)

    if (isNonStreaming(response)) {
      const geminiResponse = translateOpenAIToGemini(response)
      logGeminiDebug("response", endpoint, {
        data: geminiResponse,
        extra: {
          copilotResponse: response,
          finalResponse: geminiResponse,
        },
      })

      return handleNonStreamingToStreaming(c, geminiResponse, endpoint)
    }

    logGeminiDebug("response", endpoint, {
      data: "streaming_response_started",
    })
    return handleStreamingResponse(c, response, endpoint)
  } catch (error) {
    logGeminiError(endpoint, error)
    const { status, message } = getErrorStatusAndMessage(error)
    return c.json({ error: message }, status as 400 | 401 | 404 | 429 | 500)
  }
}

// Token counting endpoint
export async function handleGeminiCountTokens(c: Context) {
  const endpoint = c.req.url
  const model = extractModelFromUrl(endpoint)

  if (!model) {
    return c.json({ error: "Model name is required in URL path" }, 400)
  }

  // IMMEDIATE DEBUG: Log that we entered this handler
  logGeminiDebug("handler_entry_TOKENS", endpoint, {
    data: {
      endpoint: endpoint,
      model: model,
      context: "Entered handleGeminiCountTokens handler",
    },
  })

  try {
    const geminiPayload = await c.req.json<GeminiCountTokensRequest>()
    logGeminiDebug("request", endpoint, { data: geminiPayload })

    const openAIPayload = translateGeminiCountTokensToOpenAI(
      geminiPayload,
      model,
    )
    logGeminiDebug("translation", endpoint, {
      data: openAIPayload,
      extra: { copilotRequest: openAIPayload },
    })

    const tokenCounts = getTokenCount(openAIPayload.messages)
    logGeminiDebug("token_count", endpoint, { data: tokenCounts })

    const geminiResponse = translateTokenCountToGemini(tokenCounts.input)
    logGeminiDebug("response", endpoint, {
      data: geminiResponse,
      extra: { finalResponse: geminiResponse },
    })

    return c.json(geminiResponse)
  } catch (error) {
    logGeminiError(endpoint, error)
    const { status, message } = getErrorStatusAndMessage(error)
    return c.json({ error: message }, status as 400 | 401 | 404 | 429 | 500)
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => "choices" in response
