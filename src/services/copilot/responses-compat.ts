import { createHash } from "node:crypto"

import consola from "consola"

import type { ResponsesPayload } from "~/lib/types/responses"

import { logCopilotRateLimits } from "~/lib/providers/copilot-rate-limit"
import { state } from "~/lib/state"
import {
  isReasoningItem,
  normalizeResponsesInputForReplay,
} from "~/routes/responses/utils"

import { getResponseErrorMessage } from "~/services/copilot/auto-session-retry"
import {
  sendCopilotRequest,
  type CopilotHttpRequestOptions,
} from "~/services/copilot/request"

export interface ResponsesHttpSendOptions extends CopilotHttpRequestOptions {
  payload: ResponsesPayload
  reasoningReplayIdentity?: string
}

const REPLAY_CACHE_LIMIT = 1024

export const hasStrippableReasoningItem = (
  payload: ResponsesPayload,
): boolean => {
  return (
    Array.isArray(payload.input)
    && payload.input.some(
      (item) => isReasoningItem(item) && item.encrypted_content !== undefined,
    )
  )
}

const getReasoningReplayCacheKey = (
  url: string,
  { payload, headers }: CopilotHttpRequestOptions,
  reasoningReplayIdentity: string | undefined,
): string | undefined =>
  reasoningReplayIdentity === undefined ? undefined : (
    JSON.stringify([
      reasoningReplayIdentity,
      payload.model,
      url,
      createHash("sha256")
        .update(headers.Authorization ?? headers.authorization ?? "")
        .digest("hex"),
      createHash("sha256")
        .update(
          headers["Copilot-Session-Token"]
            ?? headers["copilot-session-token"]
            ?? "",
        )
        .digest("hex"),
    ])
  )

const prepareReasoningReplayRetry = async (
  url: string,
  response: Response,
  requestOptions: CopilotHttpRequestOptions,
  reasoningReplayIdentity: string | undefined,
): Promise<boolean> => {
  const { payload } = requestOptions
  const errorMessage = await getResponseErrorMessage(response)
  const shouldStripReasoningAndRetry =
    response.status >= 400
    && response.status < 500
    && errorMessage?.toLowerCase().includes("belong") === true
    && hasStrippableReasoningItem(payload)

  if (!shouldStripReasoningAndRetry) return false

  consola.warn(
    `drop thinking block, reason: upstream ${response.status} response mentions "belong" (instance-bound item ID); stripping reasoning.encrypted_content and retrying once`,
  )
  normalizeResponsesInputForReplay(payload)
  // 内层 auto-session 重试可能换掉令牌，学习时必须按发送后的当前 headers 重算
  const learnedKey = getReasoningReplayCacheKey(
    url,
    requestOptions,
    reasoningReplayIdentity,
  )
  if (learnedKey !== undefined) {
    const learned = state.responsesReplayLearned
    learned.add(learnedKey)
    if (learned.size > REPLAY_CACHE_LIMIT) {
      const oldest = learned.values().next().value
      if (oldest !== undefined) learned.delete(oldest)
    }
  }
  return true
}

export const sendResponsesRequestWithReasoningReplay = async (
  url: string,
  {
    payload,
    headers,
    clientSignal,
    transportConfig,
    reasoningReplayIdentity,
  }: ResponsesHttpSendOptions,
): Promise<Response> => {
  const requestOptions: CopilotHttpRequestOptions = {
    headers,
    payload,
    clientSignal,
    transportConfig,
  }
  const replayCacheKey = getReasoningReplayCacheKey(
    url,
    requestOptions,
    reasoningReplayIdentity,
  )
  const replayLearned =
    replayCacheKey !== undefined
    && state.responsesReplayLearned.has(replayCacheKey)

  if (replayLearned && hasStrippableReasoningItem(payload)) {
    normalizeResponsesInputForReplay(payload)
  }

  let response = await sendCopilotRequest(url, requestOptions)

  logCopilotRateLimits(response.headers)

  if (
    !response.ok
    && (await prepareReasoningReplayRetry(
      url,
      response,
      requestOptions,
      reasoningReplayIdentity,
    ))
  ) {
    response = await sendCopilotRequest(url, requestOptions)
    logCopilotRateLimits(response.headers)
  }

  return response
}
