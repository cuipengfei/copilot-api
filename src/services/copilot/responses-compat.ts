import { createHash } from "node:crypto"

import consola from "consola"

import type { ResponsesPayload } from "~/lib/types/responses"

import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { state } from "~/lib/state"
import {
  isReasoningItem,
  normalizeResponsesInputForReplay,
} from "~/routes/responses/utils"

import { getResponseErrorMessage } from "~/services/copilot/auto-session-retry"
import {
  sendCopilotHttpRequest,
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
  // 内层 auto-session 重试可能换掉令牌，学习时必须按发送后的当前 headers 重算
  const getReplayCacheKey = (): string | undefined =>
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
  const replayCacheKey = getReplayCacheKey()
  const replayLearned =
    replayCacheKey !== undefined
    && state.responsesReplayLearned.has(replayCacheKey)

  if (replayLearned && hasStrippableReasoningItem(payload)) {
    normalizeResponsesInputForReplay(payload)
  }

  let response = await sendCopilotRequest(url, {
    headers,
    payload,
    clientSignal,
    transportConfig,
  })

  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    const errorMessage = await getResponseErrorMessage(response)
    const shouldStripReasoningAndRetry =
      response.status >= 400
      && response.status < 500
      && errorMessage?.toLowerCase().includes("belong") === true
      && hasStrippableReasoningItem(payload)

    if (shouldStripReasoningAndRetry) {
      consola.warn(
        `drop thinking block, reason: upstream ${response.status} response mentions "belong" (instance-bound item ID); stripping reasoning.encrypted_content and retrying once`,
      )
      normalizeResponsesInputForReplay(payload)
      const learnedKey = getReplayCacheKey()
      if (learnedKey !== undefined) {
        const learned = state.responsesReplayLearned
        learned.add(learnedKey)
        if (learned.size > REPLAY_CACHE_LIMIT) {
          const oldest = learned.values().next().value
          if (oldest !== undefined) learned.delete(oldest)
        }
      }
      response = await sendCopilotHttpRequest(url, {
        headers,
        payload,
        clientSignal,
        transportConfig,
      })
      logCopilotRateLimits(response.headers)
    }
  }

  return response
}
