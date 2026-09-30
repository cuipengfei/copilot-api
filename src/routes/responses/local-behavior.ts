import type { streamSSE } from "hono/streaming"

import consola from "consola"

import { resolveEffortForLog } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import {
  colorizeModel,
  createHandlerLogger,
  resolvePremiumInfo,
  shouldUseColor,
  writeStreamLog,
} from "~/lib/logger"
import { writeSSEIfConnected } from "~/lib/sse"
import type {
  Reasoning,
  ResponsesPayload,
  ResponsesTransport,
} from "~/lib/types/responses"
import { isCodexUserAgent } from "~/routes/models/codex-models"

import { sanitizeAllInputImages } from "./utils"
export {
  applyForwardableResponseHeaders,
  getAttachedResponseHeaders,
  jsonWithForwardedHeaders,
} from "~/lib/response-headers"

const logger = createHandlerLogger("responses-handler")

export const shouldUseChatFallback = ({
  userAgent,
  selectedModel,
  responsesTransport,
}: {
  userAgent: string | undefined
  selectedModel: { supported_endpoints?: Array<string> } | undefined
  responsesTransport: ResponsesTransport | null
}): boolean => {
  if (isCodexUserAgent(userAgent) || responsesTransport) return false

  const supportedEndpoints = selectedModel?.supported_endpoints ?? []
  return (
    !supportedEndpoints.includes("/v1/messages")
    && (supportedEndpoints.includes("/chat/completions")
      || supportedEndpoints.includes("/v1/chat/completions"))
  )
}

export const prepareNativeResponsesRequest = (
  payload: ResponsesPayload,
): void => {
  const effortForLog = resolveEffortForLog(
    payload.reasoning?.effort ?? undefined,
    payload.model,
  )
  if (!payload.reasoning?.effort) {
    payload.reasoning = {
      ...payload.reasoning,
      effort: effortForLog.value as NonNullable<Reasoning>["effort"],
    }
  }
  const model = shouldUseColor() ? colorizeModel(payload.model) : payload.model
  consola.info(
    `IN ${model} [effort=${effortForLog.value} (${effortForLog.source})]`,
  )
}

export const retryResponsesWithoutImages = async <T>({
  error,
  payload,
  retry,
}: {
  error: unknown
  payload: ResponsesPayload
  retry: () => Promise<T>
}): Promise<T> => {
  if (!(error instanceof HTTPError) || error.response.status !== 413) {
    throw error
  }

  const count = sanitizeAllInputImages(payload)
  if (count === 0) throw error

  logger.warn(
    `Omitted ${count} input image(s) after Copilot Responses rejected the payload as too large`,
  )
  return await retry()
}

export const logResponsesCompletion = async ({
  model,
  response,
  chunks,
  streaming,
}: {
  model: string
  response: unknown
  chunks: number
  streaming: boolean
}): Promise<void> => {
  const premium = await resolvePremiumInfo(
    response,
    streaming ? "responses/stream" : "responses/non-stream",
  )
  writeStreamLog({ model, chunks, done: true, premium }, true)
}

export const createResponsesStreamErrorEvent = (
  model: string,
  err: unknown,
) => {
  const message = err instanceof Error ? err.message : "Stream error"
  return {
    type: "response.failed",
    sequence_number: 0,
    response: {
      id: "resp_stream_error",
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model,
      output: [],
      output_text: "",
      status: "failed",
      error: { message },
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      usage: null,
    },
  }
}

export const writeResponsesStreamError = async (
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  errorEvent: ReturnType<typeof createResponsesStreamErrorEvent>,
) => {
  await writeSSEIfConnected(stream, {
    event: errorEvent.type,
    data: JSON.stringify(errorEvent),
  }).catch(() => {
    // 连接已关闭时无法继续写入错误事件。
  })
}
