import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"

import * as autoSession from "../src/lib/auto-session"
import * as config from "../src/lib/config"
import * as modelCache from "../src/services/copilot/models-cache"
import * as vscodeEnv from "../src/services/vscode-env"

const callOrder: Array<string> = []

describe("runServer auto-session prewarm order", () => {
  beforeEach(async () => {
    callOrder.length = 0

    spyOn(modelCache, "cacheModels").mockImplementation(() => {
      callOrder.push("cacheModels")
      return Promise.resolve()
    })
    spyOn(vscodeEnv, "cacheVSCodeVersion").mockResolvedValue(undefined)
    spyOn(vscodeEnv, "cacheMacMachineId").mockImplementation(() => undefined)
    spyOn(vscodeEnv, "cacheVsCodeSessionId").mockImplementation(() => undefined)
    spyOn(vscodeEnv, "cacheVsCodeDeviceId").mockResolvedValue(undefined)
    spyOn(autoSession, "prewarmAutoSession").mockImplementation(() => {
      callOrder.push("prewarmAutoSession")
      return Promise.resolve()
    })
    spyOn(config, "mergeConfigWithDefaults").mockImplementation(() => ({}))

    await mock.module("../src/lib/opencode", () => ({
      getCachedOpencodeVersion: () => undefined,
      initOpencodeVersion: async () => {},
    }))

    await mock.module("../src/lib/paths", () => ({
      PATHS: {
        APP_DIR: "/tmp/copilot-api-test",
        CONFIG_PATH: "/tmp/copilot-api-test/config.json",
      },
      ensurePaths: async () => {},
    }))

    await mock.module("../src/lib/token", () => ({
      setupGitHubToken: async () => {},
      setupCopilotToken: async () => {},
      logUser: async () => {},
      persistCodexCredentials: async () => {},
      getCodexAccounts: () => [],
      removeCodexAccount: async () => {},
      selectCodexAccount: async () => {},
    }))

    await mock.module("srvx", () => ({
      serve: () => {},
    }))

    await mock.module("../src/server", () => ({
      createServer: () => ({ fetch: () => new Response(null) }),
    }))
  })

  afterEach(() => {
    mock.restore()
  })

  test("runs prewarmAutoSession after cacheModels", async () => {
    const startModule = (await import(
      `../src/start?test=${Date.now()}-${Math.random()}`
    )) as typeof import("../src/start")

    await startModule.runServer({
      port: 4141,
      host: "127.0.0.1",
      verbose: false,
      githubToken: "provided-token",
      claudeCode: false,
      showToken: false,
      proxyEnv: false,
      forceAgent: false,
      nativeMessages: false,
    })

    expect(callOrder).toEqual(["cacheModels", "prewarmAutoSession"])
  })
})
