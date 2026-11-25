import { copilotBaseUrl, copilotHeaders } from "~/lib/providers/api-config"
import { HTTPError } from "~/lib/http/error"
import { attachResponseHeaders } from "~/lib/response-headers"
import { state } from "~/lib/state"
import type { DecisionsUsage } from "~/services/copilot/create-decisions"

export interface SystemOneRequest {
  model: string
  state: unknown
  questions: Record<string, unknown>
  assets?: Record<string, unknown>
  [key: string]: unknown
}

export interface SystemOneResponse {
  answers: Record<string, unknown>
  model: string
  usage?: DecisionsUsage
  [key: string]: unknown
}

export const createSystemOne = async (
  payload: SystemOneRequest,
): Promise<SystemOneResponse> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const response = await fetch(`${copilotBaseUrl(state)}/v1/systemone`, {
    method: "POST",
    headers: copilotHeaders(state),
    body: JSON.stringify(payload),
  })

  if (!response.ok) throw new HTTPError("Failed to create systemone", response)

  const result = (await response.json()) as SystemOneResponse
  return attachResponseHeaders(result, response.headers)
}
