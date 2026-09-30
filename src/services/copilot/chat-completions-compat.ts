import consola from "consola"

import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"

import { getUpstreamTransportConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { sendCopilotHttpRequest } from "~/services/copilot/request"
import { trackResponseError } from "~/services/telemetry/telemetry"

/** 错误重试策略入参：首个响应由入口传入，其余为请求上下文。 */
export interface EnsureChatCompletionOkResponseOptions {
  url: string
  response: Response
  payload: ChatCompletionsPayload
  headers: Record<string, string>
  start: number
  requestId?: string
  modelCallId: string
  clientSignal?: AbortSignal
}

/** 匹配可重试的 thinking block 错误：签名无效或 thinking 被修改。 */
export const isThinkingBlockError = (errorBody: unknown): boolean => {
  if (errorBody === null || errorBody === undefined) return false
  const text =
    typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody)
  const lower = text.toLowerCase()
  return lower.includes("signature") || lower.includes("cannot be modified")
}

/** 剥离 assistant 消息的 reasoning 字段，避免签名校验失败。 */
export const stripReasoningFields = (
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload => ({
  ...payload,
  messages: payload.messages.map((msg) => {
    if (msg.role !== "assistant") return msg

    const { reasoning_opaque: _sig, reasoning_text: _text, ...rest } = msg
    return rest
  }),
})

/**
 * 本地错误策略：ok 直通；400 且命中 thinking block 错误时剥离 reasoning
 * 字段后重发一次（TLS-only 重试，headers/signal/timeouts 不变，payload 在
 * 发送时重新序列化，成功则返回重试响应交给入口的正常成功流程）；其余
 * 失败按上游原文记录并抛 HTTPError。
 */
export const ensureChatCompletionOkResponse = async ({
  url,
  response,
  payload,
  headers,
  start,
  requestId,
  modelCallId,
  clientSignal,
}: EnsureChatCompletionOkResponseOptions): Promise<Response> => {
  if (response.ok) return response

  const errorBody = await response
    .clone()
    .json()
    .catch(() => null)

  if (response.status === 400 && isThinkingBlockError(errorBody)) {
    consola.warn(
      "Thinking block error detected, retrying with reasoning fields stripped",
    )
    const retryResponse = await sendCopilotHttpRequest(url, {
      headers,
      payload: stripReasoningFields(payload),
      clientSignal,
      transportConfig: getUpstreamTransportConfig(),
    })
    if (!retryResponse.ok) {
      consola.error("Retry also failed", retryResponse.status)
      trackResponseError({
        model: payload.model,
        durationMs: Date.now() - start,
        statusCode: retryResponse.status,
        requestId,
        modelCallId,
      })
      throw new HTTPError(
        "Failed to create chat completions (after retry)",
        retryResponse,
      )
    }
    return retryResponse
  }

  consola.error("Failed to create chat completions", response.status)
  trackResponseError({
    model: payload.model,
    durationMs: Date.now() - start,
    statusCode: response.status,
    requestId,
    modelCallId,
  })
  throw new HTTPError("Failed to create chat completions", response)
}
