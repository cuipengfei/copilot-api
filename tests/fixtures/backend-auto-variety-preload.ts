// Test-only preload for the spawned copilot-backend-tester CLI (backend-auto-variety
// tests). It replaces globalThis.fetch so the child process can never reach real
// endpoints: only the GitHub token exchange and the fake upstream /auto are
// answered, everything else throws. Every request and its response status are
// recorded to the JSON file named by BACKEND_AUTO_VARIETY_RECORD for the parent
// test to JSON.parse; the parent test owns the record file and its temp dir
// (finally cleanup there).
//
// Scenario control (env):
//   BACKEND_AUTO_VARIETY_SCENARIO=ok|http429|http401|http403|malformed|emptyId|badEndpointsNull|badEndpointsString|badEndpointsArray|noEndpoints|hang|auth403
//   BACKEND_AUTO_VARIETY_UPSTREAM_PORT=<port>  (fake upstream base port)
//
// Deadline checks: the real CLI arms one whole-run request deadline via setTimeout(60000).
// Only in the hang scenario, and only once the mock observes a hung /auto, the
// saved original deadline callback is fired through a real 10ms timer — the CLI
// budget itself is untouched and all other timers pass through unmodified.

import fs from "node:fs"

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

interface RecordedResponse {
  url: string
  status: number
}

// Bun test globals are mutable by design; one boundary cast validated by the
// mock behavior itself (anything not allowlisted throws).
interface MutableGlobals {
  setTimeout: (
    callback: (...args: Array<unknown>) => void,
    ms?: number,
    ...args: Array<unknown>
  ) => unknown
  fetch: (
    input: Request | string | URL,
    init?: RequestInit,
  ) => Promise<Response>
}

const recordPath = process.env.BACKEND_AUTO_VARIETY_RECORD
const scenario = process.env.BACKEND_AUTO_VARIETY_SCENARIO ?? "ok"
const upstreamBase = `http://127.0.0.1:${process.env.BACKEND_AUTO_VARIETY_UPSTREAM_PORT ?? ""}`
const exchangeUrl = "https://api.github.com/copilot_internal/v2/token"
const fixtureSessionToken = "fake-session-token-for-variety-tests"

const requests: Array<RecordedRequest> = []
const responses: Array<RecordedResponse> = []

const realSetTimeout = globalThis.setTimeout.bind(globalThis)

// hang 场景专用：CLI 用 setTimeout(60000) 装请求截止，这里仅保存原始回调；
// 真实计时器原样返回，CLI 的 clearTimeout 取消语义不受影响
let savedDeadlineCallback: (() => void) | null = null
const patchedSetTimeout = (
  callback: (...args: Array<unknown>) => void,
  ms?: number,
  ...args: Array<unknown>
) => {
  if (scenario === "hang" && ms === 60_000) {
    savedDeadlineCallback = () => callback(...args)
  }
  return realSetTimeout(callback, ms, ...args)
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const autoIndex = { current: 0 }
const modelCycle = ["gpt-5.1-codex", "claude-sonnet-5", "unknown-exp-model-9"]

const handleAuto = async (init?: RequestInit): Promise<Response> => {
  const index = autoIndex.current++
  if (
    scenario === "http429"
    || scenario === "http401"
    || scenario === "http403"
  ) {
    return jsonResponse(
      { error: `simulated ${scenario}` },
      Number(scenario.slice(4)),
    )
  }
  if (scenario === "malformed") {
    return jsonResponse({ selected_model: {} })
  }
  if (scenario === "emptyId") {
    return jsonResponse({
      selected_model: {
        id: "",
        vendor: "test",
        supported_endpoints: ["/chat/completions"],
      },
      session_token: fixtureSessionToken,
      expires_at: Math.floor(Date.now() / 1000) + 3_600,
    })
  }
  if (
    scenario === "badEndpointsNull"
    || scenario === "badEndpointsString"
    || scenario === "badEndpointsArray"
  ) {
    // 上游字段存在但类型错误：null、非数组、数组含非 string，CLI 必须拒绝且不泄露
    const supportedEndpoints: unknown =
      scenario === "badEndpointsNull" ? null
      : scenario === "badEndpointsString" ? "/chat/completions"
      : ["/chat/completions", 7]
    return jsonResponse({
      selected_model: {
        id: "gpt-5.1-codex",
        vendor: "test",
        supported_endpoints: supportedEndpoints,
      },
      session_token: fixtureSessionToken,
      expires_at: Math.floor(Date.now() / 1000) + 3_600,
    })
  }
  if (scenario === "hang") {
    // 挂起直到 CLI 中止 signal；10ms 后触发 CLI 自己的 deadline 回调；
    // 无 signal 时 5s 兜底且随中止清除，测试永不永久等待
    return await new Promise<Response>((_, reject) => {
      const fallback = realSetTimeout(() => {
        reject(new Error("hang scenario finished without an abort signal"))
      }, 5_000)
      const onAbort = (): void => {
        clearTimeout(fallback)
        const error = new Error("This operation was aborted")
        error.name = "AbortError"
        reject(error)
      }
      const signal = init?.signal
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      realSetTimeout(() => {
        const fire = savedDeadlineCallback
        savedDeadlineCallback = null
        fire?.()
      }, 10)
    })
  }
  const id = modelCycle[index % modelCycle.length] ?? "unknown-exp-model-9"
  // noEndpoints：上游合法模型省略 supported_endpoints，CLI 必须原样继续观测
  const selectedModel: {
    id: string
    vendor: string
    supported_endpoints?: Array<string>
  } = { id, vendor: "test" }
  if (scenario !== "noEndpoints") {
    selectedModel.supported_endpoints = [
      "/chat/completions",
      "ws:/chat/completions",
    ]
  }
  return jsonResponse({
    selected_model: selectedModel,
    session_token: fixtureSessionToken,
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
  })
}

const mockedFetch = async (
  input: Request | string | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url =
    input instanceof Request ? input.url
    : input instanceof URL ? input.href
    : input
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET")
  const rawBody = init?.body ?? (input instanceof Request ? input.body : null)
  let body: unknown = null
  if (typeof rawBody === "string") {
    try {
      body = JSON.parse(rawBody)
    } catch {
      body = rawBody
    }
  }
  const headers: Record<string, string> = {}
  new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  ).forEach((value, name) => {
    headers[name] = value
  })
  requests.push({ method, url, headers, body })

  if (url === exchangeUrl) {
    if (scenario === "auth403") {
      const response = jsonResponse({ error: "simulated auth403" }, 403)
      responses.push({ url, status: response.status })
      return response
    }
    const response = jsonResponse({
      token: fixtureSessionToken,
      expires_at: Math.floor(Date.now() / 1000) + 3_600,
      endpoints: { api: upstreamBase },
    })
    responses.push({ url, status: response.status })
    return response
  }
  if (url === `${upstreamBase}/auto`) {
    const response = await handleAuto(init)
    responses.push({ url, status: response.status })
    return response
  }
  throw new Error(
    `[backend-auto-variety-preload] unexpected request: ${method} ${url}`,
  )
}

const mutableGlobals = globalThis as unknown as MutableGlobals
mutableGlobals.setTimeout = patchedSetTimeout
mutableGlobals.fetch = mockedFetch

process.on("exit", () => {
  if (!recordPath) {
    return
  }
  // 写失败直接抛出：退出钩子异常使子进程非零退出且无记录，父测试即失败
  fs.writeFileSync(
    recordPath,
    JSON.stringify({ scenario, requests, responses }),
  )
})
