export type CopilotRateLimitType = "session" | "weekly"

export interface CopilotRateLimitUsage {
  type: CopilotRateLimitType
  remaining: string
  resetAt: string
}

export interface CopilotQuotaSnapshot {
  entitlement: string
  percent_remaining: number
  overage_permitted: boolean
  overage_count: number
  reset_date: string
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
