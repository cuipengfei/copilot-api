import type { Server } from "bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "bun:test"

import { invalidateConfigCache, reloadConfig } from "~/lib/config-store"
import { PATHS } from "~/lib/paths"
import {
  invalidateAutoSession,
  isModelAutoCovered,
  prewarmAutoSession,
  whenProbeSchedulerIdle,
} from "~/lib/auto-session"
import { state } from "~/lib/state"
import {
  applyCopilotTokenResponse,
  setupCopilotToken,
  stopCopilotRefreshLoop,
} from "~/lib/token"
import { applyCopilotTokenMetadata } from "~/lib/token-metadata"

const BUSINESS_API_URL = "https://api.business.githubcopilot.com"
const ENTERPRISE_API_URL = "https://api.enterprise.githubcopilot.com"
const INDIVIDUAL_API_URL = "https://api.individual.githubcopilot.com"

const SKU_TOKEN =
  "tid=tid-1;exp=1774015921;sku=copilot_for_business_seat_quota;proxy-ep=proxy.business.githubcopilot.com;st=dotcom"

const originalState = {
  githubToken: state.githubToken,
  copilotToken: state.copilotToken,
  copilotApiUrl: state.copilotApiUrl,
  copilotTrackingId: state.copilotTrackingId,
  copilotTelemetryEnabled: state.copilotTelemetryEnabled,
  sku: state.sku,
  organizationList: state.organizationList,
  enterpriseList: state.enterpriseList,
  accountType: state.accountType,
  showToken: state.showToken,
}

let server: Server<undefined>
let serverUrl: string
let originalOauthApp: string | undefined
const originalConfigPath = PATHS.CONFIG_PATH
let tempConfigDir: string

// 本地 /auto 请求计数；补采请求必须全部落在 127.0.0.1 本地服务
let autoRequestCount = 0
let originalFetch: typeof fetch
// 文件级网络边界：被拦截的非本地 /auto 请求数（afterEach 断言为零）
let blockedRequestCount = 0

const responseDefaults = {
  refresh_in: 3600,
  expires_at: 0,
}

beforeEach(() => {
  // 使用临时配置隔离用户目标清单，清理时恢复路径与配置缓存。
  tempConfigDir = mkdtempSync(join(tmpdir(), "token-metadata-apply-"))
  PATHS.CONFIG_PATH = join(tempConfigDir, "config.json")
  writeFileSync(PATHS.CONFIG_PATH, "{}")
  reloadConfig()
  originalOauthApp = process.env.COPILOT_API_OAUTH_APP
  delete process.env.COPILOT_API_OAUTH_APP

  autoRequestCount = 0
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url)
      if (url.pathname !== "/auto") {
        // 未知路径即时失败：本地替身必须暴露意外请求
        return new Response(`unexpected path: ${url.pathname}`, { status: 404 })
      }
      autoRequestCount += 1
      return Response.json({
        session_token: "session-1",
        selected_model: {
          id: "auto-model-1",
          supported_endpoints: ["/responses"],
        },
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      })
    },
  })
  serverUrl = `http://127.0.0.1:${server.port}`

  // 包裹全局 fetch：仅允许以本次本地 server 为 origin 且路径 /auto 的请求，
  // 其他 URL 同步抛明确的本地测试错误——静态模块残留的补采意图
  // 不可能触达真实 Copilot（含 BUSINESS/ENTERPRISE 元数据测试场景）
  originalFetch = globalThis.fetch
  blockedRequestCount = 0
  globalThis.fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw)
    if (url.origin !== serverUrl || url.pathname !== "/auto") {
      blockedRequestCount += 1
      throw new Error(
        `[token-metadata-apply] blocked non-local request: ${url.origin}${url.pathname} (only ${serverUrl}/auto is allowed in this test file)`,
      )
    }
    return originalFetch(input, init)
  }) as typeof fetch
  state.githubToken = "github-token"
  state.copilotToken = undefined
  state.copilotApiUrl = undefined
  state.copilotTrackingId = undefined
  state.copilotTelemetryEnabled = undefined
  state.sku = undefined
  state.organizationList = undefined
  state.enterpriseList = undefined
  state.accountType = "individual"
  state.showToken = false

  invalidateAutoSession()
})

afterEach(async () => {
  // 先等在途补采/探测全部结算，再恢复 state、关闭本地 server：
  // 否则在途 /auto 会失去本地服务并可能泄漏到真实上游
  try {
    await whenProbeSchedulerIdle()
    // 越界请求必须为零：任何非本地 /auto 请求都说明测试隔离失效。
    expect(blockedRequestCount).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
    Object.assign(state, originalState)
    stopCopilotRefreshLoop()
    try {
      await server.stop(true)
    } finally {
      invalidateAutoSession()
      if (originalOauthApp === undefined) {
        delete process.env.COPILOT_API_OAUTH_APP
      } else {
        process.env.COPILOT_API_OAUTH_APP = originalOauthApp
      }
      PATHS.CONFIG_PATH = originalConfigPath
      invalidateConfigCache()
      rmSync(tempConfigDir, { recursive: true, force: true })
    }
  }
})

const assertLocalEndpoint = (): void => {
  if (state.copilotApiUrl !== serverUrl) {
    throw new Error(
      `test requires the local 127.0.0.1 endpoint, got: ${state.copilotApiUrl}`,
    )
  }
}

test("上游设置 token 和 endpoint 后补充本地元数据", () => {
  state.copilotToken = "previous-token"
  state.copilotApiUrl = INDIVIDUAL_API_URL
  const previousToken = state.copilotToken

  const response = {
    ...responseDefaults,
    token: SKU_TOKEN,
    tracking_id: "tid-1",
    telemetry: "enabled",
    endpoints: {
      api: BUSINESS_API_URL,
      telemetry: "https://telemetry.business.githubcopilot.com",
    },
    organization_list: ["org-1"],
    enterprise_list: [143351],
  }

  // 使用 setupCopilotToken 与 runCopilotRefreshLoop 的相同调用顺序。
  applyCopilotTokenResponse(response)
  applyCopilotTokenMetadata(response, previousToken)

  expect(state.copilotToken).toBe(SKU_TOKEN)
  expect(state.copilotApiUrl).toBe(BUSINESS_API_URL)

  expect(state.copilotTrackingId).toBe("tid-1")
  expect(state.copilotTelemetryEnabled).toBe(true)
  expect(state.sku).toBe("copilot_for_business_seat_quota")
  expect(state.organizationList).toEqual(["org-1"])
  expect(state.enterpriseList).toEqual([143351])
  expect(state.accountType).toBe("business")
})

test("本地元数据更新保持已有 token 和 endpoint", () => {
  state.copilotToken = "sentinel-token"
  state.copilotApiUrl = INDIVIDUAL_API_URL

  applyCopilotTokenMetadata(
    {
      ...responseDefaults,
      token: "other-token",
      endpoints: { api: ENTERPRISE_API_URL },
    },
    "prev-token",
  )

  expect(state.copilotToken).toBe("sentinel-token")
  expect(state.copilotApiUrl).toBe(INDIVIDUAL_API_URL)
})

test("Telemetry 开关和账户类型使用 token 响应中的数据", () => {
  applyCopilotTokenMetadata(
    {
      ...responseDefaults,
      token: "t-enterprise",
      telemetry: "disabled",
      endpoints: { api: ENTERPRISE_API_URL },
    },
    undefined,
  )
  expect(state.copilotTelemetryEnabled).toBe(false)
  expect(state.accountType).toBe("enterprise")

  applyCopilotTokenMetadata(
    {
      ...responseDefaults,
      token: "t-individual",
      telemetry: "disabled",
      endpoints: { api: INDIVIDUAL_API_URL },
    },
    "t-enterprise",
  )
  expect(state.copilotTelemetryEnabled).toBe(false)
  expect(state.accountType).toBe("individual")

  state.accountType = "business"
  applyCopilotTokenMetadata(
    { ...responseDefaults, token: "t-no-endpoints" },
    "t-individual",
  )
  expect(state.accountType).toBe("business")
})

test("仅 token 发生变化时使 Auto-session 失效并按新凭据后台补采", async () => {
  state.copilotApiUrl = serverUrl
  state.copilotToken = "same-token"
  assertLocalEndpoint()

  await prewarmAutoSession()
  expect(isModelAutoCovered("auto-model-1")).toBe(true)
  const callsAfterPrewarm = autoRequestCount

  const previousToken = state.copilotToken
  const sameResponse = {
    ...responseDefaults,
    token: "same-token",
    endpoints: { api: serverUrl },
  }
  applyCopilotTokenResponse(sameResponse)
  applyCopilotTokenMetadata(sameResponse, previousToken)
  // 同 token：无新增 /auto，配对保持
  await whenProbeSchedulerIdle()
  expect(autoRequestCount).toBe(callsAfterPrewarm)
  expect(isModelAutoCovered("auto-model-1")).toBe(true)

  const changedPreviousToken = state.copilotToken
  const changedResponse = {
    ...responseDefaults,
    token: "rotated-token",
    endpoints: { api: serverUrl },
  }
  applyCopilotTokenResponse(changedResponse)
  applyCopilotTokenMetadata(changedResponse, changedPreviousToken)
  // 旧配对立即失效（不等补采完成）
  expect(isModelAutoCovered("auto-model-1")).toBe(false)

  // 后台补采全部指向本地 127.0.0.1：await idle 后新凭据配对可用
  await whenProbeSchedulerIdle()
  expect(autoRequestCount).toBeGreaterThan(callsAfterPrewarm)
  expect(isModelAutoCovered("auto-model-1")).toBe(true)
})

test("OpenCode 直接使用 token 时保留未提供的元数据", async () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  state.copilotToken = "previous-token"
  state.copilotApiUrl = serverUrl
  assertLocalEndpoint()
  state.copilotTrackingId = "keep-me"
  state.copilotTelemetryEnabled = true
  state.sku = "keep-sku"
  state.organizationList = ["keep-org"]
  state.enterpriseList = [7]
  state.accountType = "business"

  await prewarmAutoSession()
  expect(isModelAutoCovered("auto-model-1")).toBe(true)
  const callsAfterPrewarm = autoRequestCount

  state.githubToken = "gho-direct-token"
  await setupCopilotToken()

  expect(state.copilotToken).toBe("gho-direct-token")
  expect(state.copilotApiUrl).toBe(serverUrl)
  expect(state.copilotTrackingId).toBe("keep-me")
  expect(state.copilotTelemetryEnabled).toBe(true)
  expect(state.sku).toBe("keep-sku")
  expect(state.organizationList).toEqual(["keep-org"])
  expect(state.enterpriseList).toEqual([7])
  expect(state.accountType).toBe("business")

  // 旧配对立即失效；后台补采经本地 127.0.0.1 完成后新凭据配对可用
  expect(isModelAutoCovered("auto-model-1")).toBe(false)
  await whenProbeSchedulerIdle()
  expect(autoRequestCount).toBeGreaterThan(callsAfterPrewarm)
  expect(isModelAutoCovered("auto-model-1")).toBe(true)
})
