import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/lib/types/models"
import type { SmartAgentDecision } from "~/services/github/get-copilot-usage"

export interface State {
  interactionId: string
  githubToken?: string
  githubTokenSource?: "cli" | "env" | "file"
  userName?: string
  copilotToken?: string
  copilotApiUrl?: string
  copilotTrackingId?: string
  copilotTelemetryEnabled?: boolean
  sku?: string
  organizationList?: Array<string>
  enterpriseList?: Array<number>
  codexAccessToken?: string
  codexRefreshToken?: string
  codexExpiresAt?: number
  codexAccountId?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  macMachineId?: string
  vsCodeSessionId?: string
  vsCodeDeviceId: string

  showToken: boolean

  verbose: boolean
  forceAgent: boolean
  nativeMessages: boolean

  // Smart agent cache (TTL: 3 minutes)
  smartAgentDecision?: SmartAgentDecision | null
  smartAgentCacheTimestamp?: number

  tokenBasedBilling?: boolean
}

export const state: State = {
  interactionId: randomUUID(),
  accountType: "individual",
  showToken: false,
  verbose: false,
  forceAgent: false,
  nativeMessages: false,
  vsCodeDeviceId: randomUUID(),
}
