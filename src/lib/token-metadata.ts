import { invalidateAutoSession } from "~/lib/auto-session"
import type { GetCopilotTokenResponse } from "~/services/github/get-copilot-token"
import { parseSku } from "~/services/telemetry/types"

import { state } from "./state"

function inferAccountTypeFromApiUrl(
  apiUrl: string | undefined,
): string | undefined {
  if (!apiUrl) return undefined
  if (apiUrl.includes("api.business.githubcopilot.com")) return "business"
  if (apiUrl.includes("api.enterprise.githubcopilot.com")) return "enterprise"
  if (apiUrl.includes("api.individual.githubcopilot.com")) return "individual"
  if (apiUrl.includes("api.githubcopilot.com")) return "individual"
  return undefined
}

/** 在上游设置 token 与 endpoint 后补充元数据；previousToken 使用设置前的值。 */
export function applyCopilotTokenMetadata(
  metadata: GetCopilotTokenResponse,
  previousToken: string | undefined,
): void {
  const {
    token,
    endpoints,
    organization_list,
    enterprise_list,
    tracking_id,
    telemetry,
  } = metadata

  if (previousToken !== token) {
    invalidateAutoSession()
  }

  state.copilotTrackingId = tracking_id
  state.copilotTelemetryEnabled = telemetry === "enabled"
  state.sku = parseSku(token)
  state.organizationList = organization_list
  state.enterpriseList = enterprise_list

  const inferredAccountType = inferAccountTypeFromApiUrl(endpoints?.api)
  if (inferredAccountType) {
    state.accountType = inferredAccountType
  }
}
