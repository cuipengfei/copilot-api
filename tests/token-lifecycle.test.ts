import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { CodexCredentials } from "~/lib/oauth/codex"
import type { GetCopilotTokenResponse } from "~/services/github/get-copilot-token"
import type { DeviceCodeResponse } from "~/services/github/get-device-code"

// This suite drives the real token.ts code in-process (counted by coverage),
// unlike the Bun.spawnSync suites. Only token.ts's I/O/network collaborators are
// faked: disk goes to a temp dir via PATHS, OAuth/network leaves are mocked, and
// node:timers/promises is replaced by a virtual clock so the background refresh
// loops are deterministic. token.ts itself is never mocked.

// --- virtual clock shared with the node:timers/promises mock ---
interface FakeTimer {
  fireAt: number
  resolve: () => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}
let virtualNow = 0
let timers: Array<FakeTimer> = []
const realDateNow = Date.now

function makeAbortError(): Error {
  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  return error
}

function fakeDelay(
  ms: number = 0,
  _value?: unknown,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const signal = options?.signal
  if (signal?.aborted) return Promise.reject(makeAbortError())
  const deferred = Promise.withResolvers<void>()
  const { resolve, reject } = deferred
  const timer: FakeTimer = {
    fireAt: virtualNow + Math.max(0, ms),
    resolve,
    reject,
  }
  if (signal) {
    timer.signal = signal
    timer.onAbort = () => {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
      reject(makeAbortError())
    }
    signal.addEventListener("abort", timer.onAbort, { once: true })
  }
  timers.push(timer)
  return deferred.promise
}

// Fire scheduled virtual timers in due order, advancing the clock, until `done`
// settles or the fire budget is exhausted. The budget guards against a loop that
// never stops rescheduling.
async function flushUntil(
  done: Promise<unknown>,
  maxFires = 5000,
): Promise<void> {
  let settled = false
  const guard = done.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  for (let fired = 0; fired < maxFires && !settled; fired++) {
    if (timers.length === 0) {
      await Promise.resolve()
      continue
    }
    timers.sort((a, b) => a.fireAt - b.fireAt)
    const timer = timers.shift()
    if (!timer) continue
    if (timer.onAbort && timer.signal) {
      timer.signal.removeEventListener("abort", timer.onAbort)
    }
    virtualNow = Math.max(virtualNow, timer.fireAt)
    timer.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  await guard
}

// Flush pending microtasks and one real macrotask (global setTimeout is NOT the
// mocked node:timers/promises one), letting background loop continuations run.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function rejection(pending: Promise<unknown>): Promise<Error> {
  const error = await pending.then(
    () => undefined,
    (failure: unknown) => failure,
  )
  expect(error).toBeInstanceOf(Error)
  return error as Error
}

function useVirtualClock(): void {
  virtualNow = realDateNow()
  Date.now = () => virtualNow
}

// --- mutable fakes for mocked network/OAuth leaves ---
let refreshCodexImpl: (
  credentials: CodexCredentials,
) => Promise<CodexCredentials>
let getDeviceCodeImpl: () => Promise<DeviceCodeResponse>
let pollAccessTokenImpl: (deviceCode: DeviceCodeResponse) => Promise<string>
let getCopilotUsageImpl: () => Promise<{
  endpoints: { api: string }
  login: string
  token_based_billing?: boolean
} | null>

const notStubbed = (name: string) => () =>
  Promise.reject(new Error(`${name} not stubbed`))

const realTimers = await import("node:timers/promises")
const actualCodex = await import("~/lib/oauth/codex")

await mock.module("node:timers/promises", () => ({
  ...realTimers,
  setTimeout: fakeDelay,
}))
await mock.module("~/lib/oauth/codex", () => ({
  ...actualCodex,
  refreshCodexCredentials: (credentials: CodexCredentials) =>
    refreshCodexImpl(credentials),
}))
await mock.module("~/services/github/get-device-code", () => ({
  getDeviceCode: () => getDeviceCodeImpl(),
}))
await mock.module("~/services/github/poll-access-token", () => ({
  pollAccessToken: (deviceCode: DeviceCodeResponse) =>
    pollAccessTokenImpl(deviceCode),
}))
await mock.module("~/services/github/get-copilot-usage", () => ({
  getCopilotUsage: () => getCopilotUsageImpl(),
}))

const {
  invalidateCodexRuntime,
  logUser,
  persistCodexCredentials,
  refreshCodexCredentialsOnce,
  setupCodexToken,
  setupCopilotToken,
  setupGitHubToken,
  stopCodexRefreshLoop,
  stopCopilotRefreshLoop,
} = await import("~/lib/token")
const { PATHS } = await import("~/lib/paths")
const { state } = await import("~/lib/state")
const { invalidateConfigCache } = await import("~/lib/config")
const { HTTPError } = await import("~/lib/error")

const originalPaths = { ...PATHS }

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(
    PATHS.CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
  invalidateConfigCache()
}

function writeCodexStore(
  accounts: Array<CodexCredentials & { alias?: string }>,
): void {
  fs.writeFileSync(
    PATHS.CODEX_CREDENTIAL_PATH,
    `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`,
    "utf8",
  )
}

function copilotResponse(
  token: string,
  refreshIn: number,
): GetCopilotTokenResponse {
  return {
    token,
    refresh_in: refreshIn,
    expires_at: Math.floor(Date.now() / 1000) + refreshIn,
    endpoints: { api: "https://api.githubcopilot.com" },
  }
}

function deviceCode(): DeviceCodeResponse {
  return {
    device_code: "device-code",
    user_code: "WXYZ-1234",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  }
}

beforeEach(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-lifecycle-"))
  PATHS.APP_DIR = tempDir
  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
  PATHS.CODEX_CREDENTIAL_PATH = path.join(tempDir, "codex_credentials.json")
  PATHS.GITHUB_TOKEN_PATH = path.join(tempDir, "github_token")
  PATHS.XAI_CREDENTIAL_PATH = path.join(tempDir, "xai_credentials.json")
  invalidateConfigCache()

  virtualNow = 0
  Date.now = realDateNow
  timers = []

  refreshCodexImpl = notStubbed("refreshCodexCredentials")
  getDeviceCodeImpl = notStubbed("getDeviceCode")
  pollAccessTokenImpl = () =>
    Promise.reject(new Error("pollAccessToken not stubbed"))
  getCopilotUsageImpl = () => Promise.resolve(null)

  state.githubToken = undefined
  state.copilotToken = undefined
  state.copilotApiUrl = undefined
  state.userName = undefined
  state.tokenBasedBilling = undefined
  state.organizationList = undefined
  state.enterpriseList = undefined
  state.sku = undefined
  state.accountType = "individual"
  state.showToken = false
  invalidateCodexRuntime()
})

afterEach(async () => {
  stopCopilotRefreshLoop()
  stopCodexRefreshLoop()
  invalidateCodexRuntime()
  await settle()
  // Resolve any orphaned virtual timers so no promise is left dangling.
  for (const timer of timers.splice(0)) {
    if (timer.onAbort && timer.signal) {
      timer.signal.removeEventListener("abort", timer.onAbort)
    }
    timer.resolve()
  }
  Date.now = realDateNow
  const tempDir = PATHS.APP_DIR
  Object.assign(PATHS, originalPaths)
  invalidateConfigCache()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

// --- logUser ---

test("logUser records the identity and routing endpoint from the usage call", async () => {
  await logUser({
    getCopilotUsage: () =>
      Promise.resolve({
        login: "octocat",
        endpoints: { api: "https://api.business.githubcopilot.com" },
        token_based_billing: true,
      }),
  })

  expect(state.userName).toBe("octocat")
  expect(state.copilotApiUrl).toBe("https://api.business.githubcopilot.com")
  expect(state.tokenBasedBilling).toBe(true)
})

test("logUser throws when the usage endpoint returns no user", async () => {
  const error = await rejection(
    logUser({ getCopilotUsage: () => Promise.resolve(null) }),
  )
  expect(error.message).toBe("GitHub token not found")
  expect(state.userName).toBeUndefined()
})

// --- setupCopilotToken ---

test("setupCopilotToken applies the exchanged token and starts the refresh loop", async () => {
  const response = copilotResponse("copilot-token-A", 100_000)

  await setupCopilotToken({
    getCopilotToken: () => Promise.resolve(response),
    getCopilotUsage: () => Promise.resolve(null),
  })

  expect(state.copilotToken).toBe("copilot-token-A")
  expect(state.copilotApiUrl).toBe("https://api.githubcopilot.com")
  // The loop is live: it registered its first (parked) wait.
  expect(timers.length).toBeGreaterThan(0)
})

test("setupCopilotToken reuses the opencode auth token without a refresh loop", async () => {
  const previous = process.env.COPILOT_API_OAUTH_APP
  process.env.COPILOT_API_OAUTH_APP = "opencode"
  state.githubToken = "gho_opencode_token"
  try {
    await setupCopilotToken()
    expect(state.copilotToken).toBe("gho_opencode_token")
    expect(timers.length).toBe(0)
  } finally {
    if (previous === undefined) delete process.env.COPILOT_API_OAUTH_APP
    else process.env.COPILOT_API_OAUTH_APP = previous
  }
})

test("setupCopilotToken rejects opencode mode without a GitHub token", async () => {
  const previous = process.env.COPILOT_API_OAUTH_APP
  process.env.COPILOT_API_OAUTH_APP = "opencode"
  state.githubToken = undefined
  try {
    const error = await rejection(setupCopilotToken())
    expect(error.message).toBe("opencode token not found")
  } finally {
    if (previous === undefined) delete process.env.COPILOT_API_OAUTH_APP
    else process.env.COPILOT_API_OAUTH_APP = previous
  }
})

test("setupCopilotToken refuses to run when the Copilot provider is disabled", async () => {
  writeConfig({ providers: { "github-copilot": { enabled: false } } })

  const error = await rejection(
    setupCopilotToken({
      getCopilotToken: () => Promise.reject(new Error("should not be called")),
      getCopilotUsage: () => Promise.resolve(null),
    }),
  )
  expect(error).toBeInstanceOf(HTTPError)
  expect(state.copilotToken).toBeUndefined()
})

test("the Copilot refresh loop applies a renewed token when the deadline passes", async () => {
  useVirtualClock()
  const refreshed = Promise.withResolvers<void>()
  let calls = 0

  await setupCopilotToken({
    getCopilotToken: () => {
      calls += 1
      if (calls === 1) return Promise.resolve(copilotResponse("copilot-1", 1))
      refreshed.resolve()
      return Promise.resolve(copilotResponse("copilot-2", 100_000))
    },
    getCopilotUsage: () => Promise.resolve(null),
  })

  expect(state.copilotToken).toBe("copilot-1")
  await flushUntil(refreshed.promise)
  await settle()

  expect(calls).toBe(2)
  expect(state.copilotToken).toBe("copilot-2")
})

test("the Copilot refresh loop keeps the old token and retries after a failed refresh", async () => {
  useVirtualClock()
  const attempted = Promise.withResolvers<void>()
  let calls = 0

  await setupCopilotToken({
    getCopilotToken: () => {
      calls += 1
      if (calls === 1) return Promise.resolve(copilotResponse("copilot-1", 1))
      attempted.resolve()
      return Promise.reject(new Error("refresh exchange failed"))
    },
    getCopilotUsage: () => Promise.resolve(null),
  })

  await flushUntil(attempted.promise)
  await settle()

  expect(calls).toBe(2)
  // A failed refresh must not clobber the working token, and the loop lives on.
  expect(state.copilotToken).toBe("copilot-1")
  expect(timers.length).toBeGreaterThan(0)
})

// --- setupGitHubToken ---

test("setupGitHubToken loads a cached token and logs the user in", async () => {
  fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, "gho_cached_token\n", "utf8")
  getCopilotUsageImpl = () =>
    Promise.resolve({
      login: "cached-user",
      endpoints: { api: "https://api.githubcopilot.com" },
    })

  await setupGitHubToken()

  expect(state.githubToken).toBe("gho_cached_token")
  expect(state.userName).toBe("cached-user")
})

test("setupGitHubToken runs the device flow and persists a new token", async () => {
  getDeviceCodeImpl = () => Promise.resolve(deviceCode())
  pollAccessTokenImpl = () => Promise.resolve("gho_new_token")
  getCopilotUsageImpl = () =>
    Promise.resolve({
      login: "new-user",
      endpoints: { api: "https://api.githubcopilot.com" },
    })

  await setupGitHubToken()

  expect(state.githubToken).toBe("gho_new_token")
  expect(state.userName).toBe("new-user")
  expect(fs.readFileSync(PATHS.GITHUB_TOKEN_PATH, "utf8")).toBe("gho_new_token")
})

test("setupGitHubToken forces a new login even when a token is cached", async () => {
  fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, "gho_old_token\n", "utf8")
  getDeviceCodeImpl = () => Promise.resolve(deviceCode())
  pollAccessTokenImpl = () => Promise.resolve("gho_forced_token")
  getCopilotUsageImpl = () =>
    Promise.resolve({
      login: "forced-user",
      endpoints: { api: "https://api.githubcopilot.com" },
    })

  await setupGitHubToken({ force: true })

  expect(state.githubToken).toBe("gho_forced_token")
  expect(fs.readFileSync(PATHS.GITHUB_TOKEN_PATH, "utf8")).toBe(
    "gho_forced_token",
  )
})

test("setupGitHubToken surfaces an HTTPError from the device code request", async () => {
  const httpError = new HTTPError(
    "boom",
    Response.json({ error: "bad" }, { status: 400 }),
  )
  getDeviceCodeImpl = () => Promise.reject(httpError)

  expect(await rejection(setupGitHubToken())).toBe(httpError)
})

// --- setupCodexToken: selection branches ---

test("setupCodexToken reports missing credentials when no account exists", async () => {
  writeConfig({})
  writeCodexStore([])

  expect((await rejection(setupCodexToken())).message).toContain(
    "Codex credentials not found",
  )
})

test("setupCodexToken requires a selection when multiple accounts exist", async () => {
  writeConfig({})
  const future = Date.now() + 60 * 60 * 1000
  writeCodexStore([
    {
      accountId: "acct_a",
      accessToken: "a",
      refreshToken: "ra",
      expiresAt: future,
    },
    {
      accountId: "acct_b",
      accessToken: "b",
      refreshToken: "rb",
      expiresAt: future,
    },
  ])

  expect((await rejection(setupCodexToken())).message).toContain(
    "Multiple Codex accounts found",
  )
})

test("setupCodexToken fails when the selected account is absent from the store", async () => {
  writeConfig({ providers: { codex: { accountId: "ghost", enabled: true } } })
  writeCodexStore([
    {
      accountId: "present",
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  ])

  expect((await rejection(setupCodexToken())).message).toContain(
    "Selected Codex account 'ghost' was not found",
  )
})

test("setupCodexToken loads a valid selected account and starts the refresh loop", async () => {
  const future = Date.now() + 2 * 60 * 60 * 1000
  writeConfig({
    providers: { codex: { accountId: "acct_live", enabled: true } },
  })
  writeCodexStore([
    {
      accountId: "acct_live",
      accessToken: "live-access",
      refreshToken: "live-refresh",
      expiresAt: future,
    },
  ])

  await setupCodexToken()

  expect(state.codexAccessToken).toBe("live-access")
  expect(state.codexAccountId).toBe("acct_live")
  expect(timers.length).toBeGreaterThan(0)
})

test("setupCodexToken refreshes an expired selected account before loading it", async () => {
  writeConfig({
    providers: { codex: { accountId: "acct_exp", enabled: true } },
  })
  writeCodexStore([
    {
      accountId: "acct_exp",
      accessToken: "stale-access",
      refreshToken: "stale-refresh",
      expiresAt: 0,
    },
  ])
  const fresh: CodexCredentials = {
    accountId: "acct_exp",
    accessToken: "fresh-access",
    refreshToken: "fresh-refresh",
    expiresAt: Date.now() + 60 * 60 * 1000,
  }
  refreshCodexImpl = () => Promise.resolve(fresh)

  await setupCodexToken()

  expect(state.codexAccessToken).toBe("fresh-access")
  const store = JSON.parse(
    fs.readFileSync(PATHS.CODEX_CREDENTIAL_PATH, "utf8"),
  ) as { accounts: Array<CodexCredentials> }
  expect(store.accounts[0]).toMatchObject({
    accountId: "acct_exp",
    accessToken: "fresh-access",
    refreshToken: "fresh-refresh",
  })
})

test("setupCodexToken propagates a refresh failure instead of swallowing it", async () => {
  writeConfig({
    providers: { codex: { accountId: "acct_exp", enabled: true } },
  })
  writeCodexStore([
    {
      accountId: "acct_exp",
      accessToken: "stale",
      refreshToken: "stale-refresh",
      expiresAt: 0,
    },
  ])
  refreshCodexImpl = () => Promise.reject(new Error("codex token endpoint 401"))

  expect((await rejection(setupCodexToken())).message).toBe(
    "codex token endpoint 401",
  )
})

test("setupCodexToken is a no-op when the Codex provider is disabled", async () => {
  writeConfig({ providers: { codex: { enabled: false } } })
  writeCodexStore([])

  await setupCodexToken()

  expect(state.codexAccessToken).toBeUndefined()
  expect(timers.length).toBe(0)
})

// --- Codex background refresh loop ---

test("the Codex refresh loop renews and persists credentials at the deadline", async () => {
  useVirtualClock()
  const near = virtualNow + 2 * 60 * 1000
  writeConfig({ providers: { codex: { accountId: "acct_bg", enabled: true } } })
  writeCodexStore([
    {
      accountId: "acct_bg",
      accessToken: "bg-access-0",
      refreshToken: "bg-refresh-0",
      expiresAt: near,
    },
  ])
  const refreshed = Promise.withResolvers<void>()
  const credentials = Promise.withResolvers<CodexCredentials>()
  let refreshCalls = 0
  refreshCodexImpl = () => {
    refreshCalls += 1
    refreshed.resolve()
    return credentials.promise
  }

  await setupCodexToken()
  expect(state.codexAccessToken).toBe("bg-access-0")

  await flushUntil(refreshed.promise)
  const completed = refreshCodexCredentialsOnce({
    accountId: "acct_bg",
    accessToken: "bg-access-0",
    refreshToken: "bg-refresh-0",
    expiresAt: near,
  })

  credentials.resolve({
    accountId: "acct_bg",
    accessToken: "bg-access-1",
    refreshToken: "bg-refresh-1",
    expiresAt: virtualNow + 2 * 60 * 60 * 1000,
  })
  await completed
  expect(state.codexAccessToken).toBe("bg-access-1")
  expect(refreshCalls).toBe(1)
  const store = JSON.parse(
    fs.readFileSync(PATHS.CODEX_CREDENTIAL_PATH, "utf8"),
  ) as { accounts: Array<CodexCredentials> }
  expect(store.accounts[0]).toMatchObject({
    accountId: "acct_bg",
    accessToken: "bg-access-1",
  })
})

test("the Codex refresh loop keeps the loaded token when a background refresh fails", async () => {
  useVirtualClock()
  const near = virtualNow + 2 * 60 * 1000
  writeConfig({ providers: { codex: { accountId: "acct_bg", enabled: true } } })
  writeCodexStore([
    {
      accountId: "acct_bg",
      accessToken: "bg-access-0",
      refreshToken: "bg-refresh-0",
      expiresAt: near,
    },
  ])
  const attempted = Promise.withResolvers<void>()
  refreshCodexImpl = () => {
    attempted.resolve()
    return Promise.reject(new Error("background refresh failed"))
  }

  await setupCodexToken()
  await flushUntil(attempted.promise)
  await settle()

  expect(state.codexAccessToken).toBe("bg-access-0")
})

// --- persistCodexCredentials ---

test("persistCodexCredentials writes, activates and loads a Codex account", async () => {
  writeConfig({})
  writeCodexStore([])
  const credentials: CodexCredentials = {
    accountId: "acct_persist",
    accessToken: "persist-access",
    refreshToken: "persist-refresh",
    expiresAt: Date.now() + 60 * 60 * 1000,
  }

  await persistCodexCredentials(credentials, {
    activateAccount: true,
    enableProvider: true,
    insertIfMissing: true,
  })

  expect(state.codexAccessToken).toBe("persist-access")
  expect(state.codexAccountId).toBe("acct_persist")
  const store = JSON.parse(
    fs.readFileSync(PATHS.CODEX_CREDENTIAL_PATH, "utf8"),
  ) as { accounts: Array<CodexCredentials> }
  expect(store.accounts[0]).toMatchObject({ accountId: "acct_persist" })
})

test("persistCodexCredentials does not load a result from a superseded runtime generation", async () => {
  writeConfig({})
  writeCodexStore([
    {
      accountId: "acct_stale",
      accessToken: "stale-access",
      refreshToken: "stale-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  ])
  const credentials: CodexCredentials = {
    accountId: "acct_stale",
    accessToken: "late-access",
    refreshToken: "late-refresh",
    expiresAt: Date.now() + 60 * 60 * 1000,
  }

  // A generation older than the current runtime must not revive runtime state.
  await persistCodexCredentials(credentials, {
    syncProvider: false,
    insertIfMissing: false,
    runtimeGeneration: -1,
  })

  expect(state.codexAccessToken).toBeUndefined()
  const store = JSON.parse(
    fs.readFileSync(PATHS.CODEX_CREDENTIAL_PATH, "utf8"),
  ) as { accounts: Array<CodexCredentials> }
  expect(store.accounts[0]).toMatchObject({ accessToken: "late-access" })
})

// --- stop / invalidate guards ---

test("invalidateCodexRuntime clears loaded Codex state and stops the loop", async () => {
  const future = Date.now() + 2 * 60 * 60 * 1000
  writeConfig({
    providers: { codex: { accountId: "acct_live", enabled: true } },
  })
  writeCodexStore([
    {
      accountId: "acct_live",
      accessToken: "live-access",
      refreshToken: "live-refresh",
      expiresAt: future,
    },
  ])
  await setupCodexToken()
  expect(state.codexAccessToken).toBe("live-access")

  invalidateCodexRuntime()

  expect(state.codexAccessToken).toBeUndefined()
  expect(state.codexAccountId).toBeUndefined()
})
