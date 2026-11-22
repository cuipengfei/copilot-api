import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"

const stopCopilotRefreshLoop = () => {
  const controller = (
    globalThis as typeof globalThis & {
      __copilotRefreshLoopController__?: AbortController
    }
  ).__copilotRefreshLoopController__
  controller?.abort()
}

describe("setupCopilotToken metadata", () => {
  const originalOauthApp = process.env.COPILOT_API_OAUTH_APP

  beforeEach(() => {
    delete process.env.COPILOT_API_OAUTH_APP
    state.githubToken = "test-github-token"
    state.copilotToken = undefined
    state.copilotApiUrl = undefined
    state.copilotTrackingId = undefined
    state.copilotTelemetryEnabled = undefined
    state.organizationList = undefined
    state.enterpriseList = undefined
    state.accountType = "individual"
    state.showToken = false
  })

  afterEach(() => {
    stopCopilotRefreshLoop()
    mock.restore()
    state.copilotTelemetryEnabled = undefined
    if (originalOauthApp === undefined) {
      delete process.env.COPILOT_API_OAUTH_APP
    } else {
      process.env.COPILOT_API_OAUTH_APP = originalOauthApp
    }
  })

  test("stores api route and telemetry metadata from token response", async () => {
    await mock.module("~/services/github/get-copilot-token", () => ({
      getCopilotToken: () => ({
        token:
          "tid=test-tracking;exp=1774015921;sku=copilot_for_business_seat_quota;proxy-ep=proxy.business.githubcopilot.com;st=dotcom;agent_mode=1;agent_mode_auto_approval=1;mcp=0;editor_preview_features=0;ssc=1;sn=1;8kp=1",
        refresh_in: 3600,
        tracking_id: "test-tracking",
        telemetry: "disabled",
        endpoints: {
          api: "https://api.business.githubcopilot.com",
          telemetry: "https://telemetry.business.githubcopilot.com",
        },
        organization_list: ["org-1"],
        enterprise_list: [143351],
      }),
    }))

    const { setupCopilotToken, stopCopilotRefreshLoop: importedStop } =
      await import("../src/lib/auth/token")

    await setupCopilotToken()

    expect(state.copilotApiUrl).toBe("https://api.business.githubcopilot.com")
    expect(state.copilotTrackingId).toBe("test-tracking")
    expect(state.copilotTelemetryEnabled).toBe(false)
    expect(state.organizationList).toEqual(["org-1"])
    expect(state.enterpriseList).toEqual([143351])
    expect(state.accountType).toBe("business")

    importedStop()
  })
})
