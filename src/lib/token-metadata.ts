import { invalidateAutoSession } from "~/lib/auto-session"
import type { GetCopilotTokenResponse } from "~/services/github/get-copilot-token"
import { parseSku } from "~/services/telemetry/types"
import {
  initTelemetry,
  trackAuthNewToken,
} from "~/services/telemetry/telemetry"

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

export const applyCopilotTokenResponse = (
  response: GetCopilotTokenResponse,
): void => {
  state.copilotToken = response.token

  // 使用本次 token 响应中的 API 地址；账号资料中的地址可能与 token 不匹配。
  // 企业账号遇到地址不一致时，Copilot 可能返回 421 Misdirected Request。
  if (response.endpoints?.api) {
    state.copilotApiUrl = response.endpoints.api
  }
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

export function applyCopilotTokenExchange(
  response: GetCopilotTokenResponse,
): void {
  const previousToken = state.copilotToken
  applyCopilotTokenResponse(response)
  applyCopilotTokenMetadata(response, previousToken)
  initTelemetry(response.token, response.endpoints?.telemetry)
  trackAuthNewToken()
}
