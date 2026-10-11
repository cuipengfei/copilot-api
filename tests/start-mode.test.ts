import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import consola from "consola"

import * as config from "~/lib/config"
import { getConfig } from "~/lib/config-store"
import * as copilotProvider from "~/lib/github-copilot-provider"
import { state } from "~/lib/state"

const originalState = { ...state }
const originalAuth = getConfig().auth
const originalLogLevel = consola.level
let environmentToken: string | null = null
let fileToken: string | null = null
let enabledProviders: Array<string> = []
let copilotEnabled = true
let setupAction: () => Promise<void> = () => Promise.resolve()
let authenticatedToken: string | undefined
let exposed = false

await mock.module("~/lib/credential-store", () => ({
  GITHUB_TOKEN_ENV: "GITHUB_TOKEN",
  readGitHubTokenFromEnv: () => environmentToken,
  readGitHubToken: () => Promise.resolve(fileToken),
}))
await mock.module("~/auth", () => ({ runProviderSetup: () => setupAction() }))
await mock.module("~/lib/copilot-runtime", () => ({
  setupCopilotRuntime: (token: string) => {
    authenticatedToken = token
    state.githubToken = token
    return Promise.resolve()
  },
}))
await mock.module("~/lib/auto-session", () => ({
  STARTUP_PROBE_BUDGET_MS: 3_000,
  prewarmAutoSession: () => Promise.resolve(),
}))
await mock.module("~/lib/opencode", () => ({
  initOpencodeVersion: () => Promise.resolve(),
}))
await mock.module("~/lib/paths", () => ({
  ensurePaths: () => Promise.resolve(),
}))
await mock.module("~/lib/models-dev-cache", () => ({
  startModelsDevCache: () => Promise.resolve(),
}))
await mock.module("~/lib/proxy", () => ({ initProxyFromEnv: () => {} }))
await mock.module("~/lib/tls", () => ({ enableSystemCACompat: () => {} }))
await mock.module("~/server", () => ({
  createServer: () => ({ fetch: () => new Response(null) }),
}))
await mock.module("srvx", () => ({
  serve: () => {
    exposed = true
  },
}))

const { runServer } = await import("~/start")
const options = {
  host: "127.0.0.1",
  port: 4141,
  verbose: false,
  showToken: false,
  proxyEnv: false,
  forceAgent: false,
  nativeMessages: false,
}

beforeEach(() => {
  Object.assign(state, originalState, {
    githubToken: undefined,
    models: undefined,
  })
  getConfig().auth = { apiKeys: [] }
  environmentToken = null
  fileToken = null
  enabledProviders = []
  copilotEnabled = true
  authenticatedToken = undefined
  exposed = false
  setupAction = () => Promise.resolve()
  spyOn(config, "mergeConfigWithDefaults").mockReturnValue({})
  spyOn(config, "listEnabledProviders").mockImplementation(
    () => enabledProviders,
  )
  spyOn(copilotProvider, "isGitHubCopilotEnabled").mockImplementation(
    () => copilotEnabled,
  )
})

afterEach(() => {
  Object.assign(state, originalState)
  getConfig().auth = originalAuth
  consola.level = originalLogLevel
  mock.restore()
})

test.each([
  {
    source: "cli",
    cli: "cli-token",
    env: "env-token",
    file: "file-token",
    expected: "cli-token",
  },
  {
    source: "env",
    cli: undefined,
    env: "env-token",
    file: "file-token",
    expected: "env-token",
  },
  {
    source: "file",
    cli: undefined,
    env: null,
    file: "file-token",
    expected: "file-token",
  },
])(
  "selects $source credentials when multiple token sources are available",
  async ({ source, cli, env, file, expected }) => {
    environmentToken = env
    fileToken = file
    await runServer({ ...options, githubToken: cli })
    expect(authenticatedToken).toBe(expected)
    expect(state.githubTokenSource).toBe(source)
    expect(exposed).toBe(true)
  },
)

test("starts provider-only mode without using disabled Copilot credentials", async () => {
  copilotEnabled = false
  enabledProviders = ["local-provider"]
  environmentToken = "copilot-env-token"
  await runServer({
    ...options,
    githubToken: "copilot-cli-token",
    proxyEnv: true,
    verbose: true,
  })
  expect(authenticatedToken).toBeUndefined()
  expect(state.githubToken).toBeUndefined()
  expect(exposed).toBe(true)
})

test("rejects startup with every provider disabled before opening a server", async () => {
  copilotEnabled = false
  const error = await runServer(options).then(
    () => undefined,
    (failure: unknown) => failure,
  )
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain("No enabled providers found")
  expect(exposed).toBe(false)
})

test("starts Copilot mode after interactive setup supplies credentials", async () => {
  setupAction = () => {
    state.githubToken = "new-login-token"
    return Promise.resolve()
  }
  await runServer(options)
  expect(authenticatedToken).toBe("new-login-token")
  expect(state.githubTokenSource).toBe("file")
  expect(exposed).toBe(true)
})

test("starts a newly configured provider without Copilot credentials", async () => {
  setupAction = () => {
    enabledProviders = ["new-provider"]
    return Promise.resolve()
  }
  await runServer(options)
  expect(authenticatedToken).toBeUndefined()
  expect(exposed).toBe(true)
})

test("rejects unsuccessful interactive setup before exposing a server", async () => {
  const error = await runServer(options).then(
    () => undefined,
    (failure: unknown) => failure,
  )
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain("Failed to configure any provider")
  expect(exposed).toBe(false)
})
