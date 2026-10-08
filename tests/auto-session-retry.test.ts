import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  getAutoSessionTokenForModel,
  invalidateAutoSession,
  refreshAutoSession,
} from "../src/lib/auto-session"
import { state } from "../src/lib/state"
import {
  attachAutoSessionToken,
  retryAfterAutoSessionTokenRejection,
} from "../src/services/copilot/auto-session-retry"
import type { AutoSelectionResponse } from "../src/services/copilot/get-auto-selection"

const REQUEST_CAP = 16

let queue: Array<AutoSelectionResponse> = []
let autoCalls = 0

const sel = (id: string, sessionToken: string): AutoSelectionResponse => ({
  selected_model: {
    id,
    supported_endpoints: ["/responses", "/chat/completions", "/v1/messages"],
  },
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  session_token: sessionToken,
})

beforeEach(() => {
  queue = []
  autoCalls = 0
  state.copilotToken = "retry-auth-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.forceAgent = false
  state.models = undefined
  state.interactionId = "retry-interaction-id"
  invalidateAutoSession()

  const fetchMock = mock((url: string, _init?: RequestInit) => {
    if (url.includes("/auto")) {
      autoCalls += 1
      if (autoCalls > REQUEST_CAP) {
        return Promise.reject(new Error("request cap exceeded"))
      }
      const next = queue.shift()
      if (!next)
        return Promise.reject(new Error("missing queued /auto response"))
      return Promise.resolve(
        new Response(JSON.stringify(next), { status: 200 }),
      )
    }
    // 未知 URL 立即失败：本文件只允许 /auto 替身，绝不触达真实上游
    return Promise.reject(new Error(`unexpected request url: ${url}`))
  })
  ;(globalThis as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  invalidateAutoSession()
  mock.restore()
})

describe("shared auto-session token rejection retry", () => {
  test("401 with attached token invalidates only that pairing and retries once with re-acquired token", async () => {
    queue.push(sel("model-a", "session-old"))
    await refreshAutoSession()
    const headers: Record<string, string> = {}
    await attachAutoSessionToken(headers, "model-a", "/responses")
    expect(headers["Copilot-Session-Token"]).toBe("session-old")

    // 正文不含旧 "Invalid auto-mode selector" 字符串：仍须触发重试
    const rejected = new Response("some opaque upstream error", { status: 401 })
    const ok = new Response("{}", { status: 200 })
    const retry = mock(() => Promise.resolve(ok))

    queue.push(sel("model-a", "session-new"))
    const result = await retryAfterAutoSessionTokenRejection(
      rejected,
      headers,
      "model-a",
      "/responses",
      retry,
    )

    expect(retry).toHaveBeenCalledTimes(1)
    expect(result).toBe(ok)
    expect(headers["Copilot-Session-Token"]).toBe("session-new")
    expect(await getAutoSessionTokenForModel("model-a")).toBe("session-new")
    // 初始登记 1 次 + 重新取得 1 次
    expect(autoCalls).toBe(2)
  })

  test("400 with attached token triggers the same single retry", async () => {
    queue.push(sel("model-a", "session-old"))
    await refreshAutoSession()
    const headers: Record<string, string> = {}
    await attachAutoSessionToken(headers, "model-a", "/chat/completions")
    expect(headers["Copilot-Session-Token"]).toBe("session-old")

    const rejected = new Response("bad request", { status: 400 })
    const ok = new Response("{}", { status: 200 })
    const retry = mock(() => Promise.resolve(ok))

    queue.push(sel("model-a", "session-new"))
    const result = await retryAfterAutoSessionTokenRejection(
      rejected,
      headers,
      "model-a",
      "/chat/completions",
      retry,
    )

    expect(retry).toHaveBeenCalledTimes(1)
    expect(result).toBe(ok)
    expect(headers["Copilot-Session-Token"]).toBe("session-new")
    expect(autoCalls).toBe(2)
  })

  test("retry keeps pairings of other models intact", async () => {
    queue.push(sel("model-a", "tok-a"))
    await refreshAutoSession()
    queue.push(sel("model-b", "tok-b"))
    await refreshAutoSession()

    const headers: Record<string, string> = {}
    await attachAutoSessionToken(headers, "model-a", "/responses")
    expect(headers["Copilot-Session-Token"]).toBe("tok-a")

    const rejected = new Response("unauthorized", { status: 401 })
    const ok = new Response("{}", { status: 200 })
    const retry = mock(() => Promise.resolve(ok))

    queue.push(sel("model-a", "tok-a2"))
    await retryAfterAutoSessionTokenRejection(
      rejected,
      headers,
      "model-a",
      "/responses",
      retry,
    )

    expect(await getAutoSessionTokenForModel("model-a")).toBe("tok-a2")
    expect(await getAutoSessionTokenForModel("model-b")).toBe("tok-b")
    expect(autoCalls).toBe(3)
  })

  test("401 without attached token does not retry or invalidate anything", async () => {
    queue.push(sel("model-a", "tok-a"))
    await refreshAutoSession()

    const rejected = new Response("unauthorized", { status: 401 })
    const retry = mock(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    )

    const result = await retryAfterAutoSessionTokenRejection(
      rejected,
      {},
      "model-a",
      "/responses",
      retry,
    )

    expect(result).toBe(rejected)
    expect(retry).toHaveBeenCalledTimes(0)
    expect(await getAutoSessionTokenForModel("model-a")).toBe("tok-a")
    expect(autoCalls).toBe(1)
  })

  test("429 and 500 with attached token do not retry or invalidate", async () => {
    queue.push(sel("model-a", "tok-a"))
    await refreshAutoSession()
    const headers: Record<string, string> = {}
    await attachAutoSessionToken(headers, "model-a", "/responses")

    for (const status of [429, 500]) {
      const rejected = new Response("retry later or bust", { status })
      const retry = mock(() =>
        Promise.resolve(new Response("{}", { status: 200 })),
      )
      const result = await retryAfterAutoSessionTokenRejection(
        rejected,
        headers,
        "model-a",
        "/responses",
        retry,
      )
      expect(result).toBe(rejected)
      expect(retry).toHaveBeenCalledTimes(0)
    }

    expect(await getAutoSessionTokenForModel("model-a")).toBe("tok-a")
    expect(autoCalls).toBe(1)
  })

  test("late 401 with superseded token retries once with the current pairing token", async () => {
    queue.push(sel("model-a", "tok-old"))
    await refreshAutoSession()

    // 并发路径已先把 model-a 的配对推进到新 token
    queue.push(sel("model-a", "tok-new"))
    await refreshAutoSession()
    expect(await getAutoSessionTokenForModel("model-a")).toBe("tok-new")

    // 旧 token 的迟到 401：不得删除新映射、不得消耗 /auto，
    // 但验收要求仍为本模型重试一次，且改附当前有效配对 token
    const staleHeaders: Record<string, string> = {
      "Copilot-Session-Token": "tok-old",
    }
    const lateRejected = new Response("unauthorized", { status: 401 })
    const ok = new Response("{}", { status: 200 })
    const retry = mock(() => Promise.resolve(ok))

    const result = await retryAfterAutoSessionTokenRejection(
      lateRejected,
      staleHeaders,
      "model-a",
      "/responses",
      retry,
    )

    expect(retry).toHaveBeenCalledTimes(1)
    expect(result).toBe(ok)
    expect(staleHeaders["Copilot-Session-Token"]).toBe("tok-new")
    expect(await getAutoSessionTokenForModel("model-a")).toBe("tok-new")
    // 迟到响应不触发重新取得：/auto 次数不变
    expect(autoCalls).toBe(2)
  })

  test("retries once without auto token when pairing was already cleared by a concurrent request", async () => {
    queue.push(sel("model-a", "tok-old"))
    await refreshAutoSession()
    const headers: Record<string, string> = {}
    await attachAutoSessionToken(headers, "model-a", "/responses")
    expect(headers["Copilot-Session-Token"]).toBe("tok-old")

    // 另一请求/轮换路径已清空全部配对：定向失效不匹配，无 /auto 可重取
    invalidateAutoSession()

    const rejected = new Response("unauthorized", { status: 401 })
    const ok = new Response("{}", { status: 200 })
    const retry = mock(() => Promise.resolve(ok))

    const result = await retryAfterAutoSessionTokenRejection(
      rejected,
      headers,
      "model-a",
      "/responses",
      retry,
    )

    expect(retry).toHaveBeenCalledTimes(1)
    expect(result).toBe(ok)
    // 旧 token 必须摘除且无新配对可附：重试不得携带失效 token
    expect(headers["Copilot-Session-Token"]).toBeUndefined()
    expect(autoCalls).toBe(1)
  })

  test("second failure response is returned as-is to the existing error path", async () => {
    queue.push(sel("model-a", "session-old"))
    await refreshAutoSession()
    const headers: Record<string, string> = {}
    await attachAutoSessionToken(headers, "model-a", "/responses")

    const firstRejected = new Response("unauthorized", { status: 401 })
    const secondRejected = new Response("still unauthorized", { status: 401 })
    const retry = mock(() => Promise.resolve(secondRejected))

    queue.push(sel("model-a", "session-new"))
    const result = await retryAfterAutoSessionTokenRejection(
      firstRejected,
      headers,
      "model-a",
      "/responses",
      retry,
    )

    expect(result).toBe(secondRejected)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(autoCalls).toBe(2)
  })

  test("re-acquire failure after token rejection throws the original error", async () => {
    queue.push(sel("model-a", "session-old"))
    await refreshAutoSession()
    const headers: Record<string, string> = {}
    await attachAutoSessionToken(headers, "model-a", "/responses")
    expect(headers["Copilot-Session-Token"]).toBe("session-old")

    const rejected = new Response("unauthorized", { status: 401 })
    const retry = mock(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    )

    // 重新取得时 /auto 队列已空：refreshAutoSession 抛出替身原始错误，
    // 必须立即上抛——禁止捕获后以无令牌推理作为后备，也不准第二次推理
    let thrown: unknown
    try {
      await retryAfterAutoSessionTokenRejection(
        rejected,
        headers,
        "model-a",
        "/responses",
        retry,
      )
      expect.unreachable("Expected re-acquire failure to propagate")
    } catch (error) {
      thrown = error
    }

    expect((thrown as Error).message).toBe("missing queued /auto response")
    expect(retry).toHaveBeenCalledTimes(0)
    // 旧 header 已摘除、配对已删除，错误面不留旧令牌状态
    expect(headers["Copilot-Session-Token"]).toBeUndefined()
    expect(await getAutoSessionTokenForModel("model-a")).toBeUndefined()
    expect(autoCalls).toBe(2)
  })
})
