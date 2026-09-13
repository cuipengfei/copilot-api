import { afterEach, expect, test } from "bun:test"
import consola from "consola"

import { refreshCodexCredentials } from "~/lib/oauth/codex"
import { pollAccessToken } from "~/services/github/poll-access-token"

const originalDebug = consola.debug
const originalFetch = globalThis.fetch

afterEach(() => {
  consola.debug = originalDebug
  globalThis.fetch = originalFetch
})

test("does not log the GitHub OAuth token response", async () => {
  const debugCalls: Array<Array<unknown>> = []
  consola.debug = ((...args: Array<unknown>) => {
    debugCalls.push(args)
  }) as typeof consola.debug
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        access_token: "github-access-secret",
        refresh_token: "github-refresh-secret",
        scope: "read:user",
        token_type: "bearer",
      }),
    )) as unknown as typeof fetch

  const accessToken = await pollAccessToken({
    device_code: "device-code",
    expires_in: 900,
    interval: 0,
    user_code: "user-code",
    verification_uri: "https://github.com/login/device",
  })
  const logs = JSON.stringify(debugCalls)

  expect(accessToken).toBe("github-access-secret")
  expect(logs).not.toContain("github-access-secret")
  expect(logs).not.toContain("github-refresh-secret")
})

test("does not include Codex tokens in response validation errors", async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        access_token: "codex-access-secret",
        expires_in: "invalid",
        refresh_token: "codex-refresh-secret",
      }),
    )) as unknown as typeof fetch

  let caughtError: unknown
  try {
    await refreshCodexCredentials({
      accessToken: "old-access-token",
      accountId: "account-id",
      expiresAt: 0,
      refreshToken: "old-refresh-token",
    })
  } catch (error) {
    caughtError = error
  }

  expect(caughtError).toBeInstanceOf(TypeError)
  const message = (caughtError as Error).message
  expect(message).toBe("Codex token refresh response missing required fields")
  expect(message).not.toContain("codex-access-secret")
  expect(message).not.toContain("codex-refresh-secret")
})
