import type { Server } from "bun"
import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  getAutoSessionTokenForModel,
  invalidateAutoSession,
  isModelAutoCovered,
} from "~/lib/auto-session"
import { state } from "~/lib/state"
import {
  applyCopilotTokenResponse,
  setupCopilotToken,
  stopCopilotRefreshLoop,
} from "~/lib/token"
import { applyCopilotTokenMetadata } from "~/lib/token-metadata"

const BUSINESS_API_URL = "https://api.business.githubcopilot.com"
const ENTERPRISE_API_URL = "https://api.enterprise.githubcopilot.com"
const INDIVIDUAL_API_URL = "https://api.individual.githubcopilot.com"

const SKU_TOKEN =
  "tid=tid-1;exp=1774015921;sku=copilot_for_business_seat_quota;proxy-ep=proxy.business.githubcopilot.com;st=dotcom"

const originalState = {
  githubToken: state.githubToken,
  copilotToken: state.copilotToken,
  copilotApiUrl: state.copilotApiUrl,
  copilotTrackingId: state.copilotTrackingId,
  copilotTelemetryEnabled: state.copilotTelemetryEnabled,
  sku: state.sku,
  organizationList: state.organizationList,
  enterpriseList: state.enterpriseList,
  accountType: state.accountType,
  showToken: state.showToken,
}

let server: Server<undefined>
let serverUrl: string
let originalOauthApp: string | undefined

const responseDefaults = {
  refresh_in: 3600,
  expires_at: 0,
}

beforeEach(() => {
  originalOauthApp = process.env.COPILOT_API_OAUTH_APP
  delete process.env.COPILOT_API_OAUTH_APP

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        session_token: "session-1",
        available_models: ["auto-model-1", "auto-model-2"],
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
  })
  serverUrl = `http://127.0.0.1:${server.port}`

  state.githubToken = "github-token"
  state.copilotToken = undefined
  state.copilotApiUrl = undefined
  state.copilotTrackingId = undefined
  state.copilotTelemetryEnabled = undefined
  state.sku = undefined
  state.organizationList = undefined
  state.enterpriseList = undefined
  state.accountType = "individual"
  state.showToken = false

  invalidateAutoSession()
})

afterEach(async () => {
  Object.assign(state, originalState)
  stopCopilotRefreshLoop()
  await server.stop(true)
  invalidateAutoSession()
  if (originalOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
  } else {
    process.env.COPILOT_API_OAUTH_APP = originalOauthApp
  }
})

test("上游设置 token 和 endpoint 后补充本地元数据", () => {
  state.copilotToken = "previous-token"
  state.copilotApiUrl = INDIVIDUAL_API_URL
  const previousToken = state.copilotToken

  const response = {
    ...responseDefaults,
    token: SKU_TOKEN,
    tracking_id: "tid-1",
    telemetry: "enabled",
    endpoints: {
      api: BUSINESS_API_URL,
      telemetry: "https://telemetry.business.githubcopilot.com",
    },
    organization_list: ["org-1"],
    enterprise_list: [143351],
  }

  // 使用 setupCopilotToken 与 runCopilotRefreshLoop 的相同调用顺序。
  applyCopilotTokenResponse(response)
  applyCopilotTokenMetadata(response, previousToken)

  expect(state.copilotToken).toBe(SKU_TOKEN)
  expect(state.copilotApiUrl).toBe(BUSINESS_API_URL)

  expect(state.copilotTrackingId).toBe("tid-1")
  expect(state.copilotTelemetryEnabled).toBe(true)
  expect(state.sku).toBe("copilot_for_business_seat_quota")
  expect(state.organizationList).toEqual(["org-1"])
  expect(state.enterpriseList).toEqual([143351])
  expect(state.accountType).toBe("business")
})

test("本地元数据更新保持已有 token 和 endpoint", () => {
  state.copilotToken = "sentinel-token"
  state.copilotApiUrl = INDIVIDUAL_API_URL

  applyCopilotTokenMetadata(
    {
      ...responseDefaults,
      token: "other-token",
      endpoints: { api: ENTERPRISE_API_URL },
    },
    "prev-token",
  )

  expect(state.copilotToken).toBe("sentinel-token")
  expect(state.copilotApiUrl).toBe(INDIVIDUAL_API_URL)
})

test("Telemetry 开关和账户类型使用 token 响应中的数据", () => {
  applyCopilotTokenMetadata(
    {
      ...responseDefaults,
      token: "t-enterprise",
      telemetry: "disabled",
      endpoints: { api: ENTERPRISE_API_URL },
    },
    undefined,
  )
  expect(state.copilotTelemetryEnabled).toBe(false)
  expect(state.accountType).toBe("enterprise")

  applyCopilotTokenMetadata(
    {
      ...responseDefaults,
      token: "t-individual",
      endpoints: { api: INDIVIDUAL_API_URL },
    },
    "t-enterprise",
  )
  expect(state.copilotTelemetryEnabled).toBe(false)
  expect(state.accountType).toBe("individual")

  state.accountType = "business"
  applyCopilotTokenMetadata(
    { ...responseDefaults, token: "t-no-endpoints" },
    "t-individual",
  )
  expect(state.accountType).toBe("business")
})

test("仅 token 发生变化时使 Auto-session 失效", async () => {
  state.copilotApiUrl = serverUrl
  state.copilotToken = "same-token"

  await getAutoSessionTokenForModel("auto-model-1")
  expect(isModelAutoCovered("auto-model-1")).toBe(true)

  const previousToken = state.copilotToken
  const sameResponse = {
    ...responseDefaults,
    token: "same-token",
    endpoints: { api: serverUrl },
  }
  applyCopilotTokenResponse(sameResponse)
  applyCopilotTokenMetadata(sameResponse, previousToken)
  expect(isModelAutoCovered("auto-model-1")).toBe(true)

  const changedPreviousToken = state.copilotToken
  const changedResponse = {
    ...responseDefaults,
    token: "rotated-token",
    endpoints: { api: serverUrl },
  }
  applyCopilotTokenResponse(changedResponse)
  applyCopilotTokenMetadata(changedResponse, changedPreviousToken)
  expect(isModelAutoCovered("auto-model-1")).toBe(false)
})

test("OpenCode 直接使用 token 时保留未提供的元数据", async () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  state.copilotToken = "previous-token"
  state.copilotApiUrl = serverUrl
  state.copilotTrackingId = "keep-me"
  state.copilotTelemetryEnabled = true
  state.sku = "keep-sku"
  state.organizationList = ["keep-org"]
  state.enterpriseList = [7]
  state.accountType = "business"

  await getAutoSessionTokenForModel("auto-model-1")
  expect(isModelAutoCovered("auto-model-1")).toBe(true)

  state.githubToken = "gho-direct-token"
  await setupCopilotToken()

  expect(state.copilotToken).toBe("gho-direct-token")
  expect(state.copilotApiUrl).toBe(serverUrl)
  expect(state.copilotTrackingId).toBe("keep-me")
  expect(state.copilotTelemetryEnabled).toBe(true)
  expect(state.sku).toBe("keep-sku")
  expect(state.organizationList).toEqual(["keep-org"])
  expect(state.enterpriseList).toEqual([7])
  expect(state.accountType).toBe("business")

  expect(isModelAutoCovered("auto-model-1")).toBe(false)
})
