import { afterEach, beforeEach, expect, test } from "bun:test"

import type { State } from "~/lib/state"

import {
  copilotHeaders,
  prepareForCompact,
  prepareMessageProxyHeaders,
} from "~/lib/api-config"
import { COMPACT_AUTO_CONTINUE, COMPACT_REQUEST } from "~/lib/compact"
import { requestContext } from "~/lib/request-context"
import { state } from "~/lib/state"

const originalOauthApp = process.env.COPILOT_API_OAUTH_APP
const originalEnterpriseUrl = process.env.COPILOT_API_ENTERPRISE_URL
const proxyState: State = {
  interactionId: "interaction-1",
  accountType: "individual",
  forceAgent: false,
  nativeMessages: false,
  copilotApiUrl: "https://api.individual.githubcopilot.com",
  githubToken: "test-github-token",
  copilotToken: "test-copilot-token",
  vsCodeVersion: "1.140.0",
  vsCodeDeviceId: "device-1",
  vsCodeSessionId: "session-1",
  macMachineId: "machine-1",
  showToken: false,
  verbose: false,
}

beforeEach(() => {
  delete process.env.COPILOT_API_OAUTH_APP
  delete process.env.COPILOT_API_ENTERPRISE_URL
})

afterEach(() => {
  if (originalEnterpriseUrl === undefined) {
    delete process.env.COPILOT_API_ENTERPRISE_URL
  } else {
    process.env.COPILOT_API_ENTERPRISE_URL = originalEnterpriseUrl
  }
  if (originalOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
    return
  }

  process.env.COPILOT_API_OAUTH_APP = originalOauthApp
})

test("prepareMessageProxyHeaders rebuilds proxy headers with GitHub auth and fresh identity", () => {
  const headers: Record<string, string> = {
    ...copilotHeaders(proxyState, "original-request-id", true),
    "anthropic-version": "client-version",
    "anthropic-beta": "context-management-2025-06-27",
    "x-initiator": "user",
    "x-interaction-id": "interaction-1",
  }

  prepareMessageProxyHeaders(headers, proxyState)

  // Core authentication derives from the GitHub token carried in state.
  expect(headers.Authorization).toBe(`Bearer ${proxyState.githubToken}`)

  // Proxy intent metadata is applied regardless of client input.
  expect(headers["OpenAI-Intent"]).toBe("messages-proxy")
  expect(headers["X-Interaction-Type"]).toBe("messages-proxy")

  // Client body metadata is forwarded verbatim.
  expect(headers["anthropic-version"]).toBe("client-version")
  expect(headers["anthropic-beta"]).toBe("context-management-2025-06-27")

  // Identity propagates from the captured session/machine/device inputs.
  expect(headers["VScode-SessionId"]).toBe(proxyState.vsCodeSessionId!)
  expect(headers["VScode-MachineId"]).toBe(proxyState.macMachineId!)
  expect(headers["Editor-Device-Id"]).toBe(proxyState.vsCodeDeviceId)

  // Editor version headers derive from the VS Code version input, not a pinned constant.
  expect(headers["Editor-Version"]).toBe(`vscode/${proxyState.vsCodeVersion}`)
  expect(headers["Editor-Plugin-Version"]).toBe(
    `copilot-chat/${proxyState.vsCodeVersion}`,
  )

  // Every upstream request gets a fresh UUID request id, never the client's.
  expect(headers["X-Request-Id"]).toMatch(
    /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u,
  )
  expect(headers["X-Request-Id"]).not.toBe("original-request-id")

  // The stale client interaction id is dropped during the rebuild.
  expect(headers["x-interaction-id"]).toBeUndefined()
})

test("prepareMessageProxyHeaders leaves opencode headers untouched", () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const headers: Record<string, string> = {
    "Openai-Intent": "conversation-edits",
    "User-Agent": "opencode/1.0.0",
  }

  prepareMessageProxyHeaders(headers, proxyState)

  expect(headers).toEqual({
    "Openai-Intent": "conversation-edits",
    "User-Agent": "opencode/1.0.0",
  })
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
