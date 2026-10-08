import consola from "consola"

import { copilotBaseUrl, copilotModelsHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export type AutoSelectionTier =
  "efficiency" | "balance" | "intelligence" | "fast"

export interface AutoSelectedModel {
  id: string
  supported_endpoints?: Array<string>
}

export interface AutoSelectionResponse {
  selected_model: AutoSelectedModel
  session_token: string
  expires_at: number
  discounted_costs?: Record<string, number>
}

export const getAutoSelection = async (
  prompt: string,
  tier: AutoSelectionTier,
): Promise<AutoSelectionResponse> => {
  const headers = {
    ...copilotModelsHeaders(state),
    // copilotModelsHeaders 会删除 content-type，POST JSON 需手动补回
    "content-type": "application/json",
  }

  // 最小超时：探测/刷新在网络无响应时不得让启动永久挂起（完整退避留后续工单）
  const response = await fetch(`${copilotBaseUrl(state)}/auto`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt, tier }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    // 只记整数状态码：statusText 由上游控制，可能反射请求中的源码片段
    consola.error(`[auto] selection request failed: HTTP ${response.status}`)
    throw new HTTPError("Failed to get auto selection", response)
  }

  return (await response.json()) as AutoSelectionResponse
}
