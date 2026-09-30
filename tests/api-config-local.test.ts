import { afterEach, describe, expect, test } from "bun:test"

import type { State } from "../src/lib/state"

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
} from "../src/lib/api-config"
import { COMPACT_REQUEST } from "../src/lib/compact"
import { state } from "../src/lib/state"

const baseState = (): State => ({
  interactionId: "test-interaction-id",
  accountType: "individual",
  showToken: false,
  verbose: false,
  forceAgent: false,
  nativeMessages: false,
  vsCodeDeviceId: "test-device-id",
})

describe("copilotBaseUrl", () => {
  const originalEnterpriseUrl = process.env.COPILOT_API_ENTERPRISE_URL

  afterEach(() => {
    if (originalEnterpriseUrl === undefined) {
      delete process.env.COPILOT_API_ENTERPRISE_URL
    } else {
      process.env.COPILOT_API_ENTERPRISE_URL = originalEnterpriseUrl
    }
  })

  test("uses token-provided endpoint without rerouting or Host override", () => {
    const state = {
      ...baseState(),
      accountType: "enterprise",
      copilotApiUrl: "https://api.individual.githubcopilot.com",
    }

    expect(copilotBaseUrl(state)).toBe(
      "https://api.individual.githubcopilot.com",
    )
    expect(copilotHeaders(state)).not.toHaveProperty("host")
  })

  test("uses account type endpoint without rerouting or Host override", () => {
    const state = {
      ...baseState(),
      accountType: "enterprise",
    }

    expect(copilotBaseUrl(state)).toBe(
      "https://api.enterprise.githubcopilot.com",
    )
    expect(copilotHeaders(state)).not.toHaveProperty("host")
  })

  test("uses enterprise domain override when token endpoint is unavailable", () => {
    process.env.COPILOT_API_ENTERPRISE_URL = "company.ghe.com"
    const state = {
      ...baseState(),
      accountType: "individual",
    }

    expect(copilotBaseUrl(state)).toBe("https://copilot-api.company.ghe.com")
    expect(copilotHeaders(state)).not.toHaveProperty("host")
  })

  test("does not forward an explicit Host header to WebSocket requests", () => {
    const headers = copilotWebSocketHeaders({
      authorization: "Bearer test-token",
      host: "api.githubcopilot.com",
    })

    expect(headers).not.toHaveProperty("host")
  })
})

test("prepareForCompact respects forceAgent (-F) priority", () => {
  const original = state.forceAgent
  state.forceAgent = true
  try {
    const headers: Record<string, string> = { "x-initiator": "user" }
    prepareForCompact(headers, COMPACT_REQUEST)
    // -F priority: compact must NOT override smart-agent's decision
    expect(headers["x-initiator"]).toBe("user")
    expect(headers["x-interaction-type"]).toBeUndefined()
    expect(headers["openai-intent"]).toBeUndefined()
  } finally {
    state.forceAgent = original
  }
})
