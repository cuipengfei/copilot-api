import { afterEach, describe, expect, test } from "bun:test"

import type { State } from "../src/lib/state"
import { requestContext } from "../src/lib/request-context"

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareMessageProxyHeaders,
} from "../src/lib/api-config"
import { COMPACT_AUTO_CONTINUE, COMPACT_REQUEST } from "../src/lib/compact"
import { isAlphaSearchCodexPriorityEnabled } from "../src/lib/config"
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

describe("prepareMessageProxyHeaders", () => {
  const originalOauthApp = process.env.COPILOT_API_OAUTH_APP

  afterEach(() => {
    if (originalOauthApp === undefined) {
      delete process.env.COPILOT_API_OAUTH_APP
      return
    }

    process.env.COPILOT_API_OAUTH_APP = originalOauthApp
  })

  test("applies message proxy headers by default", () => {
    delete process.env.COPILOT_API_OAUTH_APP

    const headers: Record<string, string> = {
      "user-agent": "GitHubCopilotChat/0.42.3",
    }

    prepareMessageProxyHeaders(headers)

    expect(headers["x-interaction-type"]).toBe("messages-proxy")
    expect(headers["openai-intent"]).toBe("messages-proxy")
    expect(headers["user-agent"]).toBe(
      "vscode_claude_code/2.1.258 (external, sdk-ts, agent-sdk/0.3.258)",
    )
    expect(headers["x-request-id"]).toBeDefined()
    expect(headers["x-agent-task-id"]).toBe(headers["x-request-id"])
  })

  test("leaves opencode headers untouched", () => {
    process.env.COPILOT_API_OAUTH_APP = "opencode"

    const headers: Record<string, string> = {
      "Openai-Intent": "conversation-edits",
      "User-Agent": "opencode/1.0.0",
    }

    prepareMessageProxyHeaders(headers)

    expect(headers).toEqual({
      "Openai-Intent": "conversation-edits",
      "User-Agent": "opencode/1.0.0",
    })
  })
})

test("reads the alpha search Codex priority setting", () => {
  expect(typeof isAlphaSearchCodexPriorityEnabled()).toBe("boolean")
})

test.each([
  ["opencode/latest/2.0.18/cli", "opencode/latest/2.0.18/cli"],
  ["  opencode/latest/2.0.18/cli  ", "opencode/latest/2.0.18/cli"],
  ["opencode/latest/2.0.18/desktop", "opencode/latest/2.0.18/desktop"],
  ["opencode/latest", "opencode/latest"],
  ["opencode/1.18.32", "opencode/1.18.32, opencode/1.18.32"],
  ["opencode/1.18.32, opencode/1.18.32", "opencode/1.18.32, opencode/1.18.32"],
])("copilotHeaders normalizes UA %s to %s", (userAgent, expected) => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const headers = requestContext.run(
    {
      traceId: "test-trace",
      startTime: Date.now(),
      userAgent,
      sessionAffinity: "child-session",
      parentSessionId: "parent-session",
    },
    () => copilotHeaders(state),
  )

  expect(headers["User-Agent"]).toBe(expected)
  expect(headers["x-session-affinity"]).toBe("child-session")
  expect(headers["x-parent-session-id"]).toBe("parent-session")
})
test("prepareForCompact marks compact traffic as agent initiated", () => {
  const compactHeaders: Record<string, string> = { "x-initiator": "user" }
  const autoContinueHeaders: Record<string, string> = { "x-initiator": "user" }
  const normalHeaders: Record<string, string> = { "x-initiator": "user" }

  prepareForCompact(compactHeaders, COMPACT_REQUEST)
  prepareForCompact(autoContinueHeaders, COMPACT_AUTO_CONTINUE)
  prepareForCompact(normalHeaders, 0)

  expect(compactHeaders["x-initiator"]).toBe("agent")
  expect(autoContinueHeaders["x-initiator"]).toBe("agent")
  expect(normalHeaders["x-initiator"]).toBe("user")
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
