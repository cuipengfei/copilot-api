import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/lib/types/models"

export interface State {
  githubToken?: string
  githubTokenSource?: "cli" | "env" | "file"
  userName?: string
  copilotToken?: string
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

  copilotApiUrl?: string
  tokenBasedBilling?: boolean
}

export const state: State = {
  accountType: "individual",
  showToken: false,
  verbose: false,
  vsCodeDeviceId: randomUUID(),
}
