import consola from "consola"

import type { ResponsesPayload } from "~/lib/types/responses"

import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import {
  isReasoningItem,
  normalizeResponsesInputForReplay,
} from "~/routes/responses/utils"

import {
  sendCopilotHttpRequest,
  sendCopilotRequest,
  type CopilotHttpRequestOptions,
} from "~/services/copilot/request"

export interface ResponsesHttpSendOptions extends CopilotHttpRequestOptions {
  payload: ResponsesPayload
}

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

export const getResponseErrorMessage = async (
  response: Response,
): Promise<string | undefined> => {
  try {
    const parsed = JSON.parse(await response.clone().text()) as {
      error?: { message?: unknown }
    }
    return typeof parsed.error?.message === "string" ?
        parsed.error.message
      : undefined
  } catch {
    return undefined
  }
}

export const sendResponsesRequestWithReasoningReplay = async (
  url: string,
  { payload, headers, clientSignal, transportConfig }: ResponsesHttpSendOptions,
): Promise<Response> => {
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
      && errorMessage?.includes("belong") === true
      && hasStrippableReasoningItem(payload)

    if (shouldStripReasoningAndRetry) {
      consola.warn(
        `drop thinking block, reason: upstream ${response.status} response mentions "belong" (instance-bound item ID); stripping reasoning.encrypted_content and retrying once`,
      )
      normalizeResponsesInputForReplay(payload)
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
