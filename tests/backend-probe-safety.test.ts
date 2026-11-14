import { describe, expect, test } from "bun:test"

import { copilotSelectionHeaders } from "../.agents/skills/copilot-backend-tester/scripts/copilot-auth.mjs"
import { sanitizeJson } from "../.agents/skills/copilot-backend-tester/scripts/probe-common.mjs"

const auth = {
  token: "test-only-copilot-token",
  base: "https://upstream.invalid",
  copilotVersion: "test-plugin-version",
  vscodeVersion: "test-editor-version",
  apiVersion: "2099-01-01",
  deviceId: "test-device-from-auth",
}

describe("backend probe JSON safety", () => {
  test("removes session credentials inside arrays while preserving model, token metadata and cost", () => {
    const body = [
      {
        model_id: "observed-model",
        session: {
          token: "test-only-session-token",
          expires_at: 4102444800,
          token_type: "Bearer",
          token_count: 7,
        },
        steps: [
          [
            {
              copilot_token: "test-only-step-token",
              token_type: "session",
              token_count: 3,
            },
          ],
        ],
        cost: { input: 0.25, output: 0.5 },
      },
      null,
    ]
    const original = structuredClone(body)

    const sanitized: unknown = sanitizeJson(body)

    expect(body).toEqual(original)
    expect(sanitized).toEqual([
      {
        model_id: "observed-model",
        session: {
          expires_at: 4102444800,
          token_type: "Bearer",
          token_count: 7,
        },
        steps: [[{ token_type: "session", token_count: 3 }]],
        cost: { input: 0.25, output: 0.5 },
      },
      null,
    ])
  })

  test("removes nested error credentials without mutating the source or removing diagnostics", () => {
    const body = {
      token: "test-only-top-level-token",
      request_id: "failed-probe-request",
      error: {
        code: "upstream_error",
        details: [
          {
            credentials: {
              token: "test-only-error-token",
              session_token: "test-only-error-session-token",
              copilot_token: "test-only-error-copilot-token",
              access_token: "test-only-error-access-token",
              refresh_token: "test-only-error-refresh-token",
              authorization: "Bearer test-only-error-authorization",
            },
            token_type: "Bearer",
            token_count: 12,
          },
        ],
        cost: { total: 0.75 },
      },
    }
    const original = structuredClone(body)

    const sanitized: unknown = sanitizeJson(body)

    expect(body).toEqual(original)
    expect(sanitized).toEqual({
      request_id: "failed-probe-request",
      error: {
        code: "upstream_error",
        details: [{ credentials: {}, token_type: "Bearer", token_count: 12 }],
        cost: { total: 0.75 },
      },
    })
  })
})

describe("backend probe selection headers", () => {
  test("exports the real selection helper and sends model-access identity with auth metadata", () => {
    expect(copilotSelectionHeaders).toBeFunction()
    const original = structuredClone(auth)
    const headers = new Headers(
      copilotSelectionHeaders(auth, "00000000-0000-4000-8000-000000000001"),
    )

    expect(Object.fromEntries(headers)).toMatchObject({
      authorization: "Bearer test-only-copilot-token",
      "content-type": "application/json",
      "copilot-integration-id": "vscode-chat",
      "editor-device-id": "test-device-from-auth",
      "editor-version": "vscode/test-editor-version",
      "editor-plugin-version": "copilot-chat/test-plugin-version",
      "user-agent": "GitHubCopilotChat/test-plugin-version",
      "x-vscode-user-agent-library-version": "electron-fetch",
      "x-github-api-version": "2099-01-01",
      "x-initiator": "agent",
      "openai-intent": "model-access",
      "x-interaction-type": "model-access",
    })
    expect(auth).toEqual(original)
  })

  test("keeps each request ID unique and pairs it with the matching agent task ID", () => {
    const firstId = "00000000-0000-4000-8000-000000000001"
    const secondId = "00000000-0000-4000-8000-000000000002"
    const first = new Headers(copilotSelectionHeaders(auth, firstId))
    const second = new Headers(copilotSelectionHeaders(auth, secondId))

    expect(first.get("x-request-id")).toBe(firstId)
    expect(first.get("x-agent-task-id")).toBe(firstId)
    expect(second.get("x-request-id")).toBe(secondId)
    expect(second.get("x-agent-task-id")).toBe(secondId)
  })

  test("retains authenticated device identity when environment identities differ", () => {
    const previous: Record<string, string | undefined> = {
      EDITOR_DEVICE_ID: process.env.EDITOR_DEVICE_ID,
      VSCODE_SESSION_ID: process.env.VSCODE_SESSION_ID,
      VSCODE_MACHINE_ID: process.env.VSCODE_MACHINE_ID,
    }
    Object.assign(process.env, {
      EDITOR_DEVICE_ID: "test-device-from-environment",
      VSCODE_SESSION_ID: "test-session-from-environment",
      VSCODE_MACHINE_ID: "test-machine-from-environment",
    })

    try {
      const headers = new Headers(
        copilotSelectionHeaders(auth, "00000000-0000-4000-8000-000000000003"),
      )

      expect(headers.get("editor-device-id")).toBe("test-device-from-auth")
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }
    }
  })
})
