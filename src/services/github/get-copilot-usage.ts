import consola from "consola"

import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface ShouldUseAgentModeParams {
  entitlement: number
  remaining: number
  dayOfMonth: number
  daysInMonth: number
}

/**
 * Determines whether to use agent mode based on quota usage progress.
 *
 * Algorithm:
 *   ideal_daily = entitlement / days_in_month
 *   expected_remaining = entitlement - (day_of_month × ideal_daily)
 *   if remaining <= expected_remaining → use agent (at or over budget)
 *
 * Uses <= to trigger at exact threshold (stops at expected, not below).
 * Math.max(5, ...) ensures minimum 5 quota reserve even at month end.
 */
export function shouldUseAgentMode(params: ShouldUseAgentModeParams): boolean {
  const { entitlement, remaining, dayOfMonth, daysInMonth } = params
  const idealDaily = entitlement / daysInMonth
  const expectedRemaining = Math.max(5, entitlement - dayOfMonth * idealDaily)
  return remaining <= expectedRemaining
}

export type SmartAgentReason = "over_budget" | "hysteresis" | "error"

export interface SmartAgentDecision {
  forceAgent: boolean
  remaining?: number
  expected?: number
  idealDaily?: number
  error?: string
  reason?: SmartAgentReason
}

/**
 * Get days in month from the current date (UTC).
 *
 * Aligned with GitHub Copilot premium quota reset which occurs at UTC 00:00.
 */
function getDaysInMonth(now: Date): number {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate()
}

/**
 * Fetches usage and determines whether to force agent mode.
 *
 * - forceAgent: true → over budget, force agent mode
 * - forceAgent: false → on budget, use existing logic (check tool/assistant)
 *
 * Returns forceAgent: true on API failure (protect user quota).
 */
export async function getSmartAgentDecision(
  now: Date = new Date(),
): Promise<SmartAgentDecision> {
  try {
    const usage = await getCopilotUsage()
    const quota = usage?.quota_snapshots?.premium_interactions
    if (!quota) {
      return {
        forceAgent: true,
        remaining: 0,
        expected: 0,
        idealDaily: 0,
        reason: "error",
      }
    }
    const daysInMonth = getDaysInMonth(now)
    const dayOfMonth = now.getUTCDate()
    const expectedRemaining = Math.max(
      5,
      quota.entitlement - dayOfMonth * (quota.entitlement / daysInMonth),
    )

    const forceAgent = shouldUseAgentMode({
      entitlement: quota.entitlement,
      remaining: quota.remaining,
      dayOfMonth,
      daysInMonth,
    })

    return {
      forceAgent,
      remaining: quota.remaining,
      expected: Math.round(expectedRemaining),
      idealDaily: quota.entitlement / daysInMonth,
      reason: forceAgent ? "over_budget" : undefined,
    }
  } catch (error) {
    consola.warn("[quota] Failed to fetch usage, defaulting to agent mode")
    return {
      forceAgent: true,
      error: error instanceof Error ? error.message : String(error),
      reason: "error" as const,
    }
  }
}

export type CopilotAccountType = "individual" | "business" | "enterprise"

export const getCopilotUsage = async (
  githubToken?: string,
  signal?: AbortSignal,
): Promise<CopilotUsageResponse | null> => {
  const resolvedGithubToken = githubToken ?? state.githubToken
  if (!resolvedGithubToken) {
    return null
  }

  const authState = { ...state, githubToken: resolvedGithubToken }
  const response = await fetch(
    `${getGitHubApiBaseUrl()}/copilot_internal/user`,
    {
      headers: githubHeaders(authState),
      signal,
    },
  )

  if (!response.ok) {
    const errorText = await response.clone().text()
    consola.error("Failed to get Copilot user response body", errorText)

    throw new HTTPError("Failed to get Copilot usage", response)
  }

  return (await response.json()) as CopilotUsageResponse
}

export const getCopilotAccountType = async (
  githubToken?: string,
): Promise<CopilotAccountType> => {
  const usage = await getCopilotUsage(githubToken)
  if (!usage) {
    throw new Error("GitHub token not found")
  }

  const plan = (usage.copilot_plan ?? "").toLowerCase()

  if (plan.includes("enterprise")) return "enterprise"
  if (plan.includes("business")) return "business"
  return "individual"
}

export interface QuotaDetail {
  entitlement: number
  overage_count: number
  overage_permitted: boolean
  percent_remaining: number
  quota_id: string
  quota_remaining: number
  remaining: number
  unlimited: boolean
}

interface QuotaSnapshots {
  chat: QuotaDetail
  completions: QuotaDetail
  premium_interactions: QuotaDetail
}

interface CopilotUsageResponse {
  login: string
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan?: string
  organization_login_list: Array<unknown>
  organization_list: Array<unknown>
  quota_reset_date: string
  quota_snapshots: QuotaSnapshots
  endpoints: {
    api: string
    telemetry: string
  }
  token_based_billing?: boolean
}
