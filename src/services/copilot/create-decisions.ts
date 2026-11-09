import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { attachResponseHeaders } from "~/lib/response-headers"
import { state } from "~/lib/state"

export interface DecisionsRequest {
  model: string
  input: unknown
  questions: Array<unknown>
  [key: string]: unknown
}

export interface DecisionsUsage {
  input_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
    cache_write_tokens?: number
  }
  output_tokens?: number
  output_tokens_details?: {
    reasoning_tokens?: number
  }
  total_tokens?: number
}

export interface DecisionsResponse {
  answers: Array<unknown>
  model: string
  usage?: DecisionsUsage
  [key: string]: unknown
}

export const createDecisions = async (
  payload: DecisionsRequest,
): Promise<DecisionsResponse> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const response = await fetch(`${copilotBaseUrl(state)}/v1/decisions`, {
    method: "POST",
    headers: copilotHeaders(state),
    body: JSON.stringify(payload),
  })

  if (!response.ok) throw new HTTPError("Failed to create decisions", response)

  const result = (await response.json()) as DecisionsResponse
  return attachResponseHeaders(result, response.headers)
}
