import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { CodexCredentials } from "~/lib/oauth/codex"
import {
  getRefreshDeadlineMs,
  getRefreshPollDelayMs,
  refreshCodexCredentialsOnce,
  type CodexRefreshDependencies,
} from "~/lib/token"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

const expiredCredentials: CodexCredentials = {
  accessToken: "expired-access-token",
  accountId: "acct_old",
  expiresAt: 0,
  refreshToken: "old-refresh-token",
}

const rotatedCredentials: CodexCredentials = {
  accessToken: "rotated-access-token",
  accountId: "acct_new",
  expiresAt: Date.now() + 60 * 60 * 1000,
  refreshToken: "rotated-refresh-token",
}

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-refresh-"))
  tempDirs.push(tempDir)
  return tempDir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop()
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test("builds refresh deadline from refresh_in and local time", () => {
  const nowMs = 1_000_000

  expect(getRefreshDeadlineMs(1_800, nowMs)).toBe(nowMs + 1_740_000)
})

test("clamps refresh deadline to avoid a hot loop", () => {
  const nowMs = 1_000_000

  expect(getRefreshDeadlineMs(30, nowMs)).toBe(nowMs + 1_000)
})

test("caps poll delay at 15 seconds while waiting", () => {
  const nowMs = 1_000_000

  expect(getRefreshPollDelayMs(nowMs + 120_000, nowMs)).toBe(15_000)
})

test("uses remaining delay when refresh is close", () => {
  const nowMs = 1_000_000

  expect(getRefreshPollDelayMs(nowMs + 8_000, nowMs)).toBe(8_000)
})

test("returns zero when refresh is already due", () => {
  const nowMs = 1_000_000

  expect(getRefreshPollDelayMs(nowMs - 1, nowMs)).toBe(0)
})

test("shares one in-flight Codex refresh between concurrent callers", async () => {
  let completeRefresh: ((credentials: CodexCredentials) => void) | undefined
  const refreshCalls: Array<CodexCredentials> = []
  const persisted: Array<CodexCredentials> = []
  const dependencies: CodexRefreshDependencies = {
    getCurrentCredentials: () => null,
    persistCodexCredentials: (credentials) => {
      persisted.push(credentials)
      return Promise.resolve()
    },
    refreshCodexCredentials: (credentials) => {
      refreshCalls.push(credentials)
      return new Promise<CodexCredentials>((resolve) => {
        completeRefresh = resolve
      })
    },
  }

  const first = refreshCodexCredentialsOnce(expiredCredentials, dependencies)
  const second = refreshCodexCredentialsOnce(expiredCredentials, dependencies)

  expect(second).toBe(first)
  expect(refreshCalls).toEqual([expiredCredentials])

  completeRefresh?.(rotatedCredentials)

  expect(await first).toBe(rotatedCredentials)
  expect(await second).toBe(rotatedCredentials)
  expect(refreshCalls).toHaveLength(1)
  expect(persisted).toEqual([rotatedCredentials])
})

test("reuses credentials rotated by another refresh instead of the stale token", async () => {
  let refreshCalls = 0

  const credentials = await refreshCodexCredentialsOnce(expiredCredentials, {
    getCurrentCredentials: () => rotatedCredentials,
    persistCodexCredentials: () => Promise.resolve(),
    refreshCodexCredentials: () => {
      refreshCalls += 1
      return Promise.resolve(rotatedCredentials)
    },
  })

  expect(credentials).toBe(rotatedCredentials)
  expect(refreshCalls).toBe(0)
})

test("refreshes when the caller's snapshot is still the current credentials", async () => {
  const snapshot: CodexCredentials = {
    ...expiredCredentials,
    expiresAt: Date.now() + 60 * 60 * 1000,
  }
  let refreshCalls = 0

  const credentials = await refreshCodexCredentialsOnce(snapshot, {
    getCurrentCredentials: () => snapshot,
    persistCodexCredentials: () => Promise.resolve(),
    refreshCodexCredentials: () => {
      refreshCalls += 1
      return Promise.resolve(rotatedCredentials)
    },
  })

  expect(credentials).toBe(rotatedCredentials)
  expect(refreshCalls).toBe(1)
})

test("does not cache a failed Codex refresh", async () => {
  let refreshCalls = 0
  const dependencies: CodexRefreshDependencies = {
    getCurrentCredentials: () => null,
    persistCodexCredentials: () => Promise.resolve(),
    refreshCodexCredentials: () => {
      refreshCalls += 1
      return refreshCalls === 1 ?
          Promise.reject(new Error("temporary failure"))
        : Promise.resolve(rotatedCredentials)
    },
  }

  const failure = await refreshCodexCredentialsOnce(
    expiredCredentials,
    dependencies,
  ).then(
    () => null,
    (error: unknown) => error,
  )

  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe("temporary failure")

  const retry = await refreshCodexCredentialsOnce(
    expiredCredentials,
    dependencies,
  )

  expect(retry).toBe(rotatedCredentials)
  expect(refreshCalls).toBe(2)
})

test("retries persistence without refreshing rotated credentials again", async () => {
  let persistCalls = 0
  let refreshCalls = 0
  const dependencies: CodexRefreshDependencies = {
    getCurrentCredentials: () => expiredCredentials,
    persistCodexCredentials: () => {
      persistCalls += 1
      return persistCalls === 1 ?
          Promise.reject(new Error("temporary persistence failure"))
        : Promise.resolve()
    },
    refreshCodexCredentials: () => {
      refreshCalls += 1
      return Promise.resolve(rotatedCredentials)
    },
  }

  const failure = await refreshCodexCredentialsOnce(
    expiredCredentials,
    dependencies,
  ).then(
    () => null,
    (error: unknown) => error,
  )

  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe("temporary persistence failure")

  const retry = await refreshCodexCredentialsOnce(
    expiredCredentials,
    dependencies,
  )

  expect(retry).toBe(rotatedCredentials)
  expect(refreshCalls).toBe(1)
  expect(persistCalls).toBe(2)
})

test("refreshes expired Codex credentials once for concurrent Codex requests", () => {
  const tempDir = createTempDir()
  fs.writeFileSync(path.join(tempDir, "config.json"), "{}\n", "utf8")
  fs.writeFileSync(
    path.join(tempDir, "codex_credentials.json"),
    `${JSON.stringify(expiredCredentials, null, 2)}\n`,
    "utf8",
  )

  const script = `
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_refreshed" },
      }),
    ).toString("base64url")
    const accessToken = "header." + payload + ".signature"

    let refreshCalls = 0
    globalThis.fetch = () => {
      refreshCalls += 1
      return Promise.resolve(
        Response.json({
          access_token: accessToken,
          refresh_token: "rotated-refresh-token",
          expires_in: 3600,
        }),
      )
    }

    const { resolveProviderConfig } = await import("./src/lib/provider-resolver")
    const resolved = await Promise.all(
      [0, 1, 2].map(() => resolveProviderConfig("codex")),
    )
    const { stopCodexRefreshLoop } = await import("./src/lib/token")

    console.log(
      JSON.stringify({
        apiKeys: resolved.map((config) => config?.apiKey),
        refreshCalls,
      }),
    )
    stopCodexRefreshLoop()
  `

  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd: repoRoot,
    env: {
      ...process.env,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })

  if (result.exitCode !== 0) {
    throw new Error(
      `Refresh script failed with exit code ${result.exitCode}\nstderr:\n${decoder.decode(result.stderr)}`,
    )
  }

  const output = JSON.parse(decoder.decode(result.stdout).trim()) as {
    apiKeys: Array<string>
    refreshCalls: number
  }
  const [firstApiKey, ...otherApiKeys] = output.apiKeys

  expect(output.refreshCalls).toBe(1)
  expect(firstApiKey).toStartWith("header.")
  expect(firstApiKey).not.toBe(expiredCredentials.accessToken)
  expect(otherApiKeys).toEqual([firstApiKey, firstApiKey])
})
