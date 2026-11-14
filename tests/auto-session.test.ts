import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import * as timersPromises from "node:timers/promises"

import { createProbeCondition } from "../src/lib/auto-probe-prompts"

import { state } from "../src/lib/state"
import type { AutoSelectionResponse } from "../src/services/copilot/get-auto-selection"
import { getConfig } from "../src/lib/config-store"
import type { Model } from "../src/lib/types/models"
import type * as AutoSession from "../src/lib/auto-session"
import consola from "consola"

type AutoSessionModule = typeof AutoSession

type TestGlobal = typeof globalThis & {
  __AUTO_SESSION_QUEUE__?: Array<AutoSelectionResponse>
  fetch: typeof fetch
}

const selection = (
  modelId: string,
  sessionToken: string,
  options: {
    expiresAt?: number
    supportedEndpoints?: Array<string>
  } = {},
): AutoSelectionResponse => ({
  selected_model: {
    id: modelId,
    ...(options.supportedEndpoints !== undefined && {
      supported_endpoints: options.supportedEndpoints,
    }),
  },
  session_token: sessionToken,
  expires_at: options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
})

const createResponse = (payload: AutoSelectionResponse) =>
  new Response(JSON.stringify(payload), { status: 200 })

const getQueue = (): Array<AutoSelectionResponse> => {
  const queue = (globalThis as TestGlobal).__AUTO_SESSION_QUEUE__
  if (!queue) {
    throw new Error("missing auto session queue")
  }
  return queue
}

const setFetchMock = (mockedFetch: typeof fetch): void => {
  ;(globalThis as TestGlobal).fetch = ((input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith("/model/fusion")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "model_pool_not_eligible" } }),
          { status: 403 },
        ),
      )
    }
    return mockedFetch(input, init)
  }) as typeof fetch
}

const originalTimerPromises = { ...timersPromises }
const nextTurn = originalTimerPromises.setImmediate
const originalFetch = globalThis.fetch
const originalAutoDiscovery = getConfig().autoDiscovery
const originalToken = state.copilotToken
const originalModels = state.models
const originalForceAgent = state.forceAgent
const modules: Array<AutoSessionModule> = []

const installProbeClock = (initialNow: number) => {
  let now = initialNow
  const timers: Array<{
    at: number
    ms: number
    callback: () => void
    cancelled: boolean
    unref: () => void
  }> = []
  const schedule = (callback: () => void, ms: number) => {
    const timer = { at: now + ms, ms, callback, cancelled: false, unref() {} }
    timers.push(timer)
    return timer
  }
  const nextTimer = (until = Number.POSITIVE_INFINITY) => {
    let next: (typeof timers)[number] | undefined
    for (const timer of timers) {
      if (
        !timer.cancelled
        && timer.at <= until
        && (next === undefined || timer.at < next.at)
      )
        next = timer
    }
    return next
  }
  const advanceBy = async (ms: number): Promise<void> => {
    const until = now + ms
    await nextTurn()
    for (let fired = 0; ; fired++) {
      const timer = nextTimer(until)
      if (timer === undefined) break
      if (fired >= 128) throw new Error("unbounded probe timers")
      now = Math.max(now, timer.at)
      timer.cancelled = true
      timer.callback()
      await nextTurn()
    }
    now = until
    await nextTurn()
  }
  const finishCurrentRound = async (mod: AutoSessionModule): Promise<void> => {
    let idle = false
    const pending = mod.whenProbeSchedulerIdle().then(() => {
      idle = true
    })
    await nextTurn()
    for (let fired = 0; !idle; fired++) {
      if (fired >= 128) throw new Error("probe round did not become idle")
      const timer = nextTimer()
      if (timer === undefined || timer.at - now > 3_000) {
        await pending
        break
      }
      await advanceBy(Math.max(0, timer.at - now))
    }
    await pending
  }
  spyOn(Date, "now").mockImplementation(() => now)
  spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    ms = 0,
  ) => schedule(callback, ms)) as unknown as typeof setTimeout)
  spyOn(globalThis, "clearTimeout").mockImplementation((timer: unknown) => {
    const captured = timers.find((candidate) => candidate === timer)
    if (captured) captured.cancelled = true
  })
  void mock.module("node:timers/promises", () => ({
    ...originalTimerPromises,
    setTimeout: <T = void>(
      ms = 0,
      value?: T,
      { signal }: { signal?: AbortSignal } = {},
    ): Promise<T> => {
      const { promise, resolve, reject } = Promise.withResolvers<T>()
      const abort = () => {
        timer.cancelled = true
        reject(new DOMException("Timer aborted", "AbortError"))
      }
      const timer = schedule(() => {
        signal?.removeEventListener("abort", abort)
        resolve(value)
      }, ms)
      if (signal?.aborted) abort()
      else signal?.addEventListener("abort", abort, { once: true })
      return promise
    },
  }))
  return {
    timers,
    finishCurrentRound,
    advanceBy,
    get now() {
      return now
    },
    set now(value: number) {
      now = value
    },
  }
}

const loadAutoSessionModule = async (): Promise<AutoSessionModule> => {
  // Static imports cannot reset the module-owned pairing table and scheduler.
  const module = (await import(
    `../src/lib/auto-session?test=${Date.now()}-${Math.random()}`
  )) as AutoSessionModule
  modules.push(module)
  return module
}

let fetchMock: ReturnType<typeof mock>

describe("auto-session", () => {
  beforeEach(() => {
    const queue: Array<AutoSelectionResponse> = []
    ;(globalThis as TestGlobal).__AUTO_SESSION_QUEUE__ = queue
    state.copilotToken = "dummy-auth-token-a"
    getConfig().autoDiscovery = undefined

    fetchMock = mock(() => {
      const currentQueue = getQueue()
      if (currentQueue.length === 0) {
        throw new Error("missing queued /auto response")
      }
      const nextPayload = currentQueue.shift()
      if (!nextPayload) {
        throw new Error("missing queued /auto response")
      }
      return Promise.resolve(createResponse(nextPayload))
    })
    setFetchMock(fetchMock as unknown as typeof fetch)
  })

  afterEach(async () => {
    for (const module of modules.splice(0)) {
      module.stopProbeScheduler()
      await module.whenProbeSchedulerIdle()
    }
    state.copilotToken = originalToken
    state.models = originalModels
    state.forceAgent = originalForceAgent
    globalThis.fetch = originalFetch
    delete (globalThis as TestGlobal).__AUTO_SESSION_QUEUE__
    mock.restore()
    getConfig().autoDiscovery = originalAutoDiscovery
  })

  test("prewarm registers pairing by selected model id and caches token", async () => {
    const { getAutoSessionForModel, isModelAutoCovered, prewarmAutoSession } =
      await loadAutoSessionModule()

    getQueue().push(
      selection("gpt-5.3-codex", "token-initial", {
        supportedEndpoints: ["/responses", "ws:/responses"],
      }),
    )

    await prewarmAutoSession()

    expect(isModelAutoCovered("gpt-5.3-codex")).toBe(true)
    expect(isModelAutoCovered("not-covered")).toBe(false)

    const token = await getAutoSessionForModel({ model: "gpt-5.3-codex" })
    expect(token?.sessionToken).toBe("token-initial")

    const scoped = await getAutoSessionForModel({
      model: "gpt-5.3-codex",
      endpoint: "/responses",
    })
    expect(scoped?.sessionToken).toBe("token-initial")
  })

  test("returns undefined when model is not covered", async () => {
    const { getAutoSessionForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    getQueue().push(selection("other-model", "token-initial"))

    await prewarmAutoSession()

    const token = await getAutoSessionForModel({ model: "gpt-4o" })
    expect(token?.sessionToken).toBeUndefined()
  })

  test("prewarm failure is swallowed and does not block subsequent flow", async () => {
    const { getAutoSessionForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    await prewarmAutoSession()

    const token = await getAutoSessionForModel({ model: "gpt-5.3-codex" })
    expect(token?.sessionToken).toBeUndefined()
  })

  test("misses after prewarm failure until a later probe registers a pairing", async () => {
    const { getAutoSessionForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    await prewarmAutoSession()
    expect(
      (await getAutoSessionForModel({ model: "gpt-5.3-codex" }))?.sessionToken,
    ).toBeUndefined()
    // 源码充足时启动发现共 8 个探测点（4 档 × 简单题/难题）
    expect(fetchMock).toHaveBeenCalledTimes(8)

    getQueue().push(selection("gpt-5.3-codex", "token-after-failure"))
    await prewarmAutoSession()
    expect(fetchMock).toHaveBeenCalledTimes(16)

    expect(
      (await getAutoSessionForModel({ model: "gpt-5.3-codex" }))?.sessionToken,
    ).toBe("token-after-failure")
  })

  test("reuses cached token for covered model without extra probe", async () => {
    const { getAutoSessionForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    getQueue().push(selection("gpt-5.3-codex", "token-stable"))
    await prewarmAutoSession()
    // 8 个探测点各请求一次；查询命中缓存不再发请求
    expect(fetchMock).toHaveBeenCalledTimes(8)

    const first = await getAutoSessionForModel({ model: "gpt-5.3-codex" })
    const second = await getAutoSessionForModel({ model: "gpt-5.3-codex" })
    expect(first?.sessionToken).toBe("token-stable")
    expect(second?.sessionToken).toBe("token-stable")
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })

  test("misses after Copilot auth token identity changes until re-probe", async () => {
    const { getAutoSessionForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    getQueue().push(selection("gpt-5.3-codex", "token-for-auth-a"))

    await prewarmAutoSession()
    expect(
      (await getAutoSessionForModel({ model: "gpt-5.3-codex" }))?.sessionToken,
    ).toBe("token-for-auth-a")

    state.copilotToken = "dummy-auth-token-b"
    expect(
      (await getAutoSessionForModel({ model: "gpt-5.3-codex" }))?.sessionToken,
    ).toBeUndefined()

    getQueue().push(selection("gpt-5.3-codex", "token-for-auth-b"))
    await prewarmAutoSession()
    expect(
      (await getAutoSessionForModel({ model: "gpt-5.3-codex" }))?.sessionToken,
    ).toBe("token-for-auth-b")
  })

  test("invalid selections never enter the pairing table", async () => {
    const { isModelAutoCovered, registerAutoSelection } =
      await loadAutoSessionModule()

    const future = Math.floor(Date.now() / 1000) + 3600
    const invalidSelections: Array<AutoSelectionResponse> = [
      { session_token: "token", expires_at: future } as AutoSelectionResponse,
      selection("", "token"),
      selection("gpt-5.3-codex", ""),
      selection("gpt-5.3-codex", "token", {
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      }),
      {
        selected_model: { id: "gpt-5.3-codex" },
        session_token: "token",
      } as AutoSelectionResponse,
      // supported_endpoints 含非字符串元素或非数组：边界拒绝，不得进入配对表
      selection("gpt-5.3-codex", "token", {
        supportedEndpoints: ["/responses", 42] as unknown as Array<string>,
      }),
      {
        ...selection("gpt-5.3-codex", "token"),
        selected_model: {
          id: "gpt-5.3-codex",
          supported_endpoints: "/responses" as unknown as Array<string>,
        },
      },
    ]

    for (const invalid of invalidSelections) {
      expect(
        registerAutoSelection(
          invalid,
          createProbeCondition({
            source: "auto",
            tier: "balance",
            prompt: "hello",
          }),
        ),
      ).toBe(false)
    }

    expect(isModelAutoCovered("gpt-5.3-codex")).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("refresh rejects invalid upstream response and caches nothing", async () => {
    const {
      getAutoSessionForModel,
      isModelAutoCovered,
      prewarmAutoSession,
      refreshAutoSession,
    } = await loadAutoSessionModule()

    getQueue().push(
      selection("gpt-5.3-codex", "token-bad", {
        supportedEndpoints: ["/responses", 7] as unknown as Array<string>,
      }),
    )

    let caught: unknown
    try {
      await refreshAutoSession()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    if (!(caught instanceof Error)) {
      throw new Error("expected refresh to reject with Error")
    }
    expect(caught.message).toBe("invalid auto selection response")
    expect(isModelAutoCovered("gpt-5.3-codex")).toBe(false)
    expect(
      (
        await getAutoSessionForModel({
          model: "gpt-5.3-codex",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBeUndefined()

    // prewarm 仍吞掉失败；后续合法探测可恢复配对
    getQueue().push(
      selection("gpt-5.3-codex", "token-good", {
        supportedEndpoints: ["/responses"],
      }),
    )
    await prewarmAutoSession()
    expect(
      (
        await getAutoSessionForModel({
          model: "gpt-5.3-codex",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("token-good")
  })

  test("startup probes post JSON bodies with model-access identity headers", async () => {
    const { prewarmAutoSession } = await loadAutoSessionModule()
    const TIERS = ["efficiency", "balance", "intelligence", "fast"]

    getQueue().push(
      selection("gpt-5.3-codex", "token-shape", {
        supportedEndpoints: ["/responses"],
      }),
    )

    await prewarmAutoSession()

    // 源码充足：4 档 × 简单题/难题 共 8 个探测点
    expect(fetchMock).toHaveBeenCalledTimes(8)
    const easyTiers: Array<string> = []
    let hardPrompts = 0
    for (const call of fetchMock.mock.calls) {
      const [url, init] = call as unknown as [string, RequestInit]
      expect(String(url)).toContain("/auto")
      expect(init.method).toBe("POST")

      const headers = init.headers as Record<string, string>
      expect(headers["content-type"]).toBe("application/json")
      expect(headers["Authorization"]).toBe("Bearer dummy-auth-token-a")
      expect(headers["x-github-api-version"]).toBe("2026-08-01")
      expect(headers["openai-intent"]).toBe("model-access")
      expect(headers["x-interaction-type"]).toBe("model-access")

      if (typeof init.body !== "string") {
        throw new Error("expected string request body")
      }
      const body = JSON.parse(init.body) as {
        prompt: string
        tier: string
      }
      expect(TIERS).toContain(body.tier)
      if (body.prompt === "hello") {
        easyTiers.push(body.tier)
      } else {
        hardPrompts += 1
      }
    }
    expect(easyTiers.sort()).toEqual([...TIERS].sort())
    expect(hardPrompts).toBe(4)
  })

  test("keeps one pairing per model id with the latest token", async () => {
    const { getAutoSessionForModel, registerAutoSelection } =
      await loadAutoSessionModule()

    expect(
      registerAutoSelection(
        selection("gpt-5.3-codex", "token-first"),
        createProbeCondition({
          source: "auto",
          tier: "balance",
          prompt: "hello",
        }),
      ),
    ).toBe(true)
    expect(
      registerAutoSelection(
        selection("gpt-5.3-codex", "token-latest"),
        createProbeCondition({
          source: "auto",
          tier: "balance",
          prompt: "hello",
        }),
      ),
    ).toBe(true)

    expect(
      (await getAutoSessionForModel({ model: "gpt-5.3-codex" }))?.sessionToken,
    ).toBe("token-latest")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("token is only usable for its own model id", async () => {
    const { getAutoSessionForModel, registerAutoSelection } =
      await loadAutoSessionModule()

    registerAutoSelection(
      selection("gpt-5.3-codex", "token-own", {
        supportedEndpoints: ["/responses"],
      }),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )

    expect(
      (
        await getAutoSessionForModel({
          model: "gpt-5.4",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe(undefined)
    expect(
      (
        await getAutoSessionForModel({
          model: "gpt-5.3-codex",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("token-own")
  })

  test("endpoint applicability follows supported_endpoints", async () => {
    const { getAutoSessionForModel, registerAutoSelection } =
      await loadAutoSessionModule()

    registerAutoSelection(
      selection("gpt-6-luna", "token-luna", {
        supportedEndpoints: ["/responses", "ws:/responses"],
      }),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )

    expect(
      (
        await getAutoSessionForModel({
          model: "gpt-6-luna",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("token-luna")
    expect(
      (
        await getAutoSessionForModel({
          model: "gpt-6-luna",
          endpoint: "/chat/completions",
        })
      )?.sessionToken,
    ).toBeUndefined()
    expect(
      (await getAutoSessionForModel({ model: "gpt-6-luna" }))?.sessionToken,
    ).toBe("token-luna")

    // 只支持 websocket 的配对不可用于 HTTP 端点
    registerAutoSelection(
      selection("ws-only-model", "token-ws", {
        supportedEndpoints: ["ws:/responses"],
      }),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    expect(
      (
        await getAutoSessionForModel({
          model: "ws-only-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe(undefined)

    // 上游端点均为完整路径：候选 "/v1/messages" 精确服务请求端点 "/v1/messages"
    registerAutoSelection(
      selection("claude-model", "token-claude", {
        supportedEndpoints: ["/v1/messages"],
      }),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    expect(
      (
        await getAutoSessionForModel({
          model: "claude-model",
          endpoint: "/v1/messages",
        })
      )?.sessionToken,
    ).toBe("token-claude")
  })

  test("lookup result is independent of the forceAgent flag", async () => {
    const { getAutoSessionForModel, registerAutoSelection } =
      await loadAutoSessionModule()

    registerAutoSelection(
      selection("gpt-5.3-codex", "token-flag", {
        supportedEndpoints: ["/responses"],
      }),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )

    state.forceAgent = true
    expect(
      (
        await getAutoSessionForModel({
          model: "gpt-5.3-codex",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("token-flag")

    state.forceAgent = false
    expect(
      (
        await getAutoSessionForModel({
          model: "gpt-5.3-codex",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("token-flag")
  })

  test("invalidate clears every pairing", async () => {
    const {
      getAutoSessionForModel,
      invalidateAutoSession,
      isModelAutoCovered,
      registerAutoSelection,
    } = await loadAutoSessionModule()

    registerAutoSelection(
      selection("gpt-5.3-codex", "token-clear"),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )

    invalidateAutoSession()

    expect(isModelAutoCovered("gpt-5.3-codex")).toBe(false)
    expect(
      (await getAutoSessionForModel({ model: "gpt-5.3-codex" }))?.sessionToken,
    ).toBeUndefined()
  })

  test("refreshAutoSession does not register a stale in-flight response after credential rotation; retries under the new credential", async () => {
    const {
      getAutoSessionForModel,
      invalidateAutoSession,
      refreshAutoSession,
    } = await loadAutoSessionModule()
    const gate = Promise.withResolvers<void>()
    let rotated = false
    let calls = 0
    state.copilotToken = "old-token"
    try {
      setFetchMock(((_input: unknown, init?: RequestInit) => {
        calls += 1
        // 请求硬上限：失控循环立即以普通 Error 终止，不做真实网络
        if (calls > 16) {
          return Promise.reject(new Error("refresh request cap exceeded"))
        }
        const authorization = new Headers(init?.headers).get("authorization")
        if (!rotated) {
          expect(authorization).toBe("Bearer old-token")
          return gate.promise.then(() =>
            Promise.resolve(
              createResponse(selection("old-model", "token-old")),
            ),
          )
        }
        expect(authorization).toBe("Bearer new-token")
        return Promise.resolve(
          createResponse(selection("new-model", "token-new")),
        )
      }) as unknown as typeof fetch)

      const refreshPromise = refreshAutoSession()
      // refresh 同步发起首个请求：此时旧凭据请求必已在途
      expect(calls).toBe(1)
      state.copilotToken = "new-token"
      invalidateAutoSession()
      rotated = true
      gate.resolve()
      await refreshPromise

      // 旧凭据响应不得进入新凭据配对；新凭据重试成功并可命中
      expect(
        (await getAutoSessionForModel({ model: "old-model" }))?.sessionToken,
      ).toBeUndefined()
      expect(
        (await getAutoSessionForModel({ model: "new-model" }))?.sessionToken,
      ).toBe("token-new")
      expect(calls).toBe(2)
    } finally {
      state.copilotToken = "dummy-auth-token-a"
      gate.resolve()
    }
  })
  test("pairing refresh: only a pairing inside the 5-minute window re-probes and updates its token", async () => {
    const mod = await loadAutoSessionModule()
    let callsA = 0
    let callsB = 0
    state.copilotToken = "refresh-token"
    try {
      setFetchMock(((_input: unknown, init?: RequestInit) => {
        if (typeof init?.body !== "string")
          throw new Error("expected string request body")
        const body = JSON.parse(init.body) as { prompt: string }
        if (body.prompt === "hello-a") {
          callsA += 1
          const payload =
            callsA === 1 ?
              selection("model-a", "token-a", {
                expiresAt: Math.floor(Date.now() / 1000) + 4 * 60,
              })
            : selection("model-a", "token-a-2", {
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
              })
          return Promise.resolve(createResponse(payload))
        }
        callsB += 1
        return Promise.resolve(
          createResponse(
            selection("model-b", "token-b", {
              expiresAt: Math.floor(Date.now() / 1000) + 600,
            }),
          ),
        )
      }) as unknown as typeof fetch)

      await mod.runProbePoint("efficiency", "easy", "hello-a")
      await mod.runProbePoint("balance", "easy", "hello-b")

      const start = Date.now()
      while (callsA < 2 && Date.now() - start < 3_000) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(callsA).toBe(2)
      // 窗口外（>5 分钟到期）的配对不补采
      expect(callsB).toBe(1)
      // 同模型补采按新 token 保存并可命中
      expect(
        (await mod.getAutoSessionForModel({ model: "model-a" }))?.sessionToken,
      ).toBe("token-a-2")
      expect(
        (await mod.getAutoSessionForModel({ model: "model-b" }))?.sessionToken,
      ).toBe("token-b")
    } finally {
      state.copilotToken = "dummy-auth-token-a"
      mod.stopProbeScheduler()
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("pairing refresh: due pairing refreshes immediately and does not loop while the new expiry stays in the window", async () => {
    const mod = await loadAutoSessionModule()
    const times: Array<number> = []
    state.copilotToken = "refresh-token"
    try {
      setFetchMock((() => {
        times.push(Date.now())
        // 请求硬上限：失控循环立即以普通 Error 终止
        if (times.length > 16) {
          return Promise.reject(new Error("refresh storm cap exceeded"))
        }
        return Promise.resolve(
          createResponse(
            selection("due-model", `token-${times.length}`, {
              // 首试给已到期配对（now+10s 在 5 分钟窗口内）→ 必须立即补采一次；
              // 补采仍返回窗口内 expiry（now+240s）→ 不得再创建第二条立即定时器
              expiresAt:
                times.length === 1 ?
                  Math.floor(Date.now() / 1000) + 10
                : Math.floor(Date.now() / 1000) + 240,
            }),
          ),
        )
      }) as unknown as typeof fetch)

      await mod.runProbePoint("efficiency", "easy", "hello")

      const start = Date.now()
      while (times.length < 2 && Date.now() - start < 2_000) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      // 短观察窗内总请求数恰为 2：首试 + 一次立即补采
      expect(times.length).toBe(2)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(times.length).toBe(2)
      // stop 之后仍为 2
      mod.stopProbeScheduler()
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(times.length).toBe(2)
      expect(
        (await mod.getAutoSessionForModel({ model: "due-model" }))
          ?.sessionToken,
      ).toBe("token-2")
    } finally {
      state.copilotToken = "dummy-auth-token-a"
      mod.stopProbeScheduler()
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("pairing refresh: invalidate cancels scheduled refreshes", async () => {
    const mod = await loadAutoSessionModule()
    let calls = 0
    state.copilotToken = "refresh-token"
    try {
      setFetchMock((() => {
        calls += 1
        if (calls > 16) return Promise.reject(new Error("cap exceeded"))
        return Promise.resolve(
          createResponse(
            selection("lonely-model", `token-${calls}`, {
              expiresAt: Math.floor(Date.now() / 1000) + 240,
            }),
          ),
        )
      }) as unknown as typeof fetch)

      await mod.runProbePoint("efficiency", "easy", "hello")
      mod.invalidateAutoSession()
      await new Promise((resolve) => setTimeout(resolve, 400))
      // 失效后定时器已清除：不再有后台请求
      expect(calls).toBe(1)
    } finally {
      state.copilotToken = "dummy-auth-token-a"
      mod.stopProbeScheduler()
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("pairing refresh: capped long timer re-arms instead of probing early", async () => {
    const mod = await loadAutoSessionModule()
    let calls = 0
    state.copilotToken = "refresh-token"
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const realNow = Date.now
    const longTimers: Array<{ cb: () => void; delay: number }> = []
    let now = realNow()
    Date.now = () => now
    const marked = new WeakSet<object>()
    try {
      globalThis.setTimeout = ((
        cb: () => void,
        ms?: number,
        ...rest: unknown[]
      ) => {
        // 只拦截超长（封顶）定时器：其余等待原样走真实计时器
        if (ms !== undefined && ms > 60_000) {
          const fake = { unref() {}, ref() {} }
          marked.add(fake)
          longTimers.push({ cb, delay: ms })
          return fake
        }
        return realSetTimeout(
          cb as Parameters<typeof setTimeout>[0],
          ms,
          ...rest,
        )
      }) as unknown as typeof setTimeout
      globalThis.clearTimeout = (handle: unknown) => {
        if (
          typeof handle === "object"
          && handle !== null
          && marked.has(handle)
        ) {
          return
        }
        realClearTimeout(handle as Parameters<typeof clearTimeout>[0])
      }

      const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 3600
      setFetchMock((() => {
        calls += 1
        if (calls > 16) return Promise.reject(new Error("cap exceeded"))
        // 补采在穿越后的时钟下拿到续期（now+120s，仍未来但已进入刷新窗口）
        const renewed =
          calls === 1 ? expiresAt : Math.floor(Date.now() / 1000) + 120
        return Promise.resolve(
          createResponse(
            selection("long-model", `token-${calls}`, { expiresAt: renewed }),
          ),
        )
      }) as unknown as typeof fetch)

      await mod.runProbePoint("efficiency", "easy", "hello")
      // 首试登记了 30 天到期的配对：延时远超 2^31-1ms，定时器被封顶捕获
      expect(calls).toBe(1)
      expect(longTimers.length).toBe(1)
      expect(longTimers[0].delay).toBeGreaterThan(24 * 3600 * 1000)
      expect(longTimers[0].delay).toBeLessThanOrEqual(2 ** 31 - 1)

      // 手动提前触发封顶回调：还未到 expires_at-5min，不得请求 /auto，
      // 且必须已重排下一条等待
      longTimers[0].cb()
      expect(calls).toBe(1)
      expect(longTimers.length).toBe(2)

      // 推进时间越过真实刷新时刻后再触发：到时只发一次
      now += 31 * 24 * 3600 * 1000
      longTimers[1].cb()
      const start = Date.now()
      while (calls < 2 && Date.now() - start < 2_000) {
        await new Promise((resolve) => realSetTimeout(resolve, 10))
      }
      // 让 void runProbePoint 的登记链落定后再断言
      await new Promise((resolve) => realSetTimeout(resolve, 50))
      expect(calls).toBe(2)
      // 续期仍在未来但已进入五分钟窗口：按真实 expiry 正延时再排程
      expect(longTimers.length).toBe(3)
      expect(longTimers[2].delay).toBeGreaterThan(0)
      expect(longTimers[2].delay).toBe(
        (Math.floor(Date.now() / 1000) + 120) * 1000 - Date.now(),
      )
      expect(calls).toBe(2)
      Date.now = realNow
      expect(
        (await mod.getAutoSessionForModel({ model: "long-model" }))
          ?.sessionToken,
      ).toBe("token-2")
    } finally {
      Date.now = realNow
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      state.copilotToken = "dummy-auth-token-a"
      mod.stopProbeScheduler()
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("probe scheduler idle: after stop, waits for in-flight timer refresh", async () => {
    const mod = await loadAutoSessionModule()
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    state.copilotToken = "refresh-token"
    try {
      setFetchMock((() => {
        calls += 1
        if (calls === 1) {
          return Promise.resolve(
            createResponse(
              selection("idle-model", "token-1", {
                expiresAt: Math.floor(Date.now() / 1000) + 10,
              }),
            ),
          )
        }
        // 第二次（定时器到期刷新）挂起在 gate，直到测试放行
        return gate.then(() =>
          createResponse(
            selection("idle-model", "token-2", {
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            }),
          ),
        )
      }) as unknown as typeof fetch)

      await mod.runProbePoint("efficiency", "easy", "hello")
      const start = Date.now()
      while (calls < 2 && Date.now() - start < 2_000) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(calls).toBe(2)

      mod.stopProbeScheduler()
      let settled = false
      const idle = mod.whenProbeSchedulerIdle().then(() => {
        settled = true
      })
      // gate 未放行：在途刷新未结算，idle 不得解决
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(settled).toBe(false)
      release?.()
      await idle
      expect(settled).toBe(true)
    } finally {
      release?.()
      state.copilotToken = "dummy-auth-token-a"
      mod.stopProbeScheduler()
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("pairing refresh: refresh selecting a different model id keeps tokens under their own ids and expiry", async () => {
    const mod = await loadAutoSessionModule()
    let calls = 0
    const realNow = Date.now
    const gate = Promise.withResolvers<void>()
    state.copilotToken = "refresh-token"
    try {
      setFetchMock((() => {
        calls += 1
        if (calls > 16) return Promise.reject(new Error("cap exceeded"))
        if (calls === 1) {
          return Promise.resolve(
            createResponse(
              selection("old-model", "token-old", {
                expiresAt: Math.floor(Date.now() / 1000) + 10,
              }),
            ),
          )
        }
        if (calls === 2) {
          // timer 到期刷新选中不同模型 id
          return Promise.resolve(
            createResponse(
              selection("new-model", "token-new", {
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
              }),
            ),
          )
        }
        // calls===3：并发手工探测的共享在途 fetch，由 gate 挂起
        return gate.promise.then(() =>
          createResponse(
            selection("new-model", "token-new", {
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            }),
          ),
        )
      }) as unknown as typeof fetch)

      await mod.runProbePoint("efficiency", "easy", "hello")
      const start = Date.now()
      while (calls < 2 && Date.now() - start < 2_000) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(calls).toBe(2)

      // token-new 只挂在 new-model 下；old-model 在自身到期前仍命中 token-old
      expect(
        (await mod.getAutoSessionForModel({ model: "new-model" }))
          ?.sessionToken,
      ).toBe("token-new")
      expect(
        (await mod.getAutoSessionForModel({ model: "old-model" }))
          ?.sessionToken,
      ).toBe("token-old")
      expect(mod.isModelAutoCovered("new-model")).toBe(true)
      expect(mod.isModelAutoCovered("old-model")).toBe(true)

      // 同 (tier,kind) 并发手工探测共享单一在途 fetch
      const probeA = mod.runProbePoint("efficiency", "easy", "hello")
      const probeB = mod.runProbePoint("efficiency", "easy", "hello")
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(calls).toBe(3)
      gate.resolve()
      await Promise.all([probeA, probeB])
      expect(calls).toBe(3)

      // 静态边界：越过 old-model 自身到期时刻，绝不能再命中任何 token，
      // 对外覆盖也不得误报
      Date.now = () => realNow() + 11_000
      expect(
        (await mod.getAutoSessionForModel({ model: "old-model" }))
          ?.sessionToken,
      ).toBeUndefined()
      expect(mod.isModelAutoCovered("old-model")).toBe(false)
      expect(
        (await mod.getAutoSessionForModel({ model: "new-model" }))
          ?.sessionToken,
      ).toBe("token-new")
      expect(mod.isModelAutoCovered("new-model")).toBe(true)
      Date.now = realNow
    } finally {
      Date.now = realNow
      gate.resolve()
      state.copilotToken = "dummy-auth-token-a"
      mod.stopProbeScheduler()
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("expired pairing miss re-probes once via recorded source and only the new model wins", async () => {
    const mod = await loadAutoSessionModule()
    let calls = 0
    const realNow = Date.now
    const gate = Promise.withResolvers<void>()
    state.copilotToken = "refresh-token"
    try {
      setFetchMock((() => {
        calls += 1
        if (calls > 16) return Promise.reject(new Error("cap exceeded"))
        if (calls === 1) {
          return Promise.resolve(
            createResponse(
              selection("old-model", "token-old", {
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
              }),
            ),
          )
        }
        // 补采挂在 gate：放行后选中不同模型
        return gate.promise.then(() =>
          createResponse(
            selection("new-model", "token-new", {
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            }),
          ),
        )
      }) as unknown as typeof fetch)

      await mod.runProbePoint("efficiency", "easy", "hello")
      expect(
        (await mod.getAutoSessionForModel({ model: "old-model" }))
          ?.sessionToken,
      ).toBe("token-old")
      expect(calls).toBe(1)

      // 前移时钟越过 old-model 自身到期时刻
      Date.now = () => realNow() + 3_700_000

      // 连续 5 次 lookup：全部 undefined，且单飞只发一次补采
      const results = await Promise.all([
        mod.getAutoSessionForModel({ model: "old-model" }),
        mod.getAutoSessionForModel({ model: "old-model" }),
        mod.getAutoSessionForModel({ model: "old-model" }),
        mod.getAutoSessionForModel({ model: "old-model" }),
        mod.getAutoSessionForModel({ model: "old-model" }),
      ])
      expect(
        results.every((result) => result?.sessionToken === undefined),
      ).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(calls).toBe(2)
      // 挂起期间：旧 model 已删（不会误绑新 token），新 model 尚未登记
      expect(
        (await mod.getAutoSessionForModel({ model: "old-model" }))
          ?.sessionToken,
      ).toBeUndefined()
      expect(
        (await mod.getAutoSessionForModel({ model: "new-model" }))
          ?.sessionToken,
      ).toBeUndefined()

      // 放行：仅按新响应实际 ID 登记
      gate.resolve()
      await mod.whenProbeSchedulerIdle()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(
        (await mod.getAutoSessionForModel({ model: "new-model" }))
          ?.sessionToken,
      ).toBe("token-new")
      expect(
        (await mod.getAutoSessionForModel({ model: "old-model" }))
          ?.sessionToken,
      ).toBeUndefined()
      expect(calls).toBe(2)

      // 恢复真实时钟：新配对仍未到期，继续可用
      Date.now = realNow
      expect(
        (await mod.getAutoSessionForModel({ model: "new-model" }))
          ?.sessionToken,
      ).toBe("token-new")
    } finally {
      Date.now = realNow
      gate.resolve()
      state.copilotToken = "dummy-auth-token-a"
      mod.stopProbeScheduler()
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("expired pairing under rotated credential misses without any request", async () => {
    const mod = await loadAutoSessionModule()
    let calls = 0
    const realNow = Date.now
    state.copilotToken = "old-token"
    try {
      setFetchMock((() => {
        calls += 1
        if (calls > 16) return Promise.reject(new Error("cap exceeded"))
        return Promise.resolve(
          createResponse(
            selection("stale-model", "token-stale", {
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            }),
          ),
        )
      }) as unknown as typeof fetch)

      await mod.runProbePoint("efficiency", "easy", "hello")
      expect(calls).toBe(1)

      // 凭据已轮换但 invalidate/resume 尚未发生（metadata 更新进行中），
      // 旧配对又恰好过期：5 次 get 必须零请求——补采只归完整更新后的 resume
      Date.now = () => realNow() + 3_700_000
      state.copilotToken = "new-token"
      const results = await Promise.all([
        mod.getAutoSessionForModel({ model: "stale-model" }),
        mod.getAutoSessionForModel({ model: "stale-model" }),
        mod.getAutoSessionForModel({ model: "stale-model" }),
        mod.getAutoSessionForModel({ model: "stale-model" }),
        mod.getAutoSessionForModel({ model: "stale-model" }),
      ])
      expect(
        results.every((result) => result?.sessionToken === undefined),
      ).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(calls).toBe(1)
      Date.now = realNow
    } finally {
      Date.now = realNow
      state.copilotToken = "dummy-auth-token-a"
      mod.stopProbeScheduler()
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("resume re-probes pairings established only via refreshAutoSession", async () => {
    const mod = await loadAutoSessionModule()
    let calls = 0
    let failAll = true
    const auths: Array<string | null> = []
    state.copilotToken = "old-token"
    try {
      setFetchMock(((_input: unknown, init?: RequestInit) => {
        calls += 1
        if (calls > 16) return Promise.reject(new Error("cap exceeded"))
        auths.push(new Headers(init?.headers).get("authorization"))
        if (failAll) return Promise.resolve(new Response(null, { status: 400 }))
        return Promise.resolve(
          createResponse(
            selection("refreshed-model", "token-refreshed", {
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            }),
          ),
        )
      }) as unknown as typeof fetch)

      // 全 400 预热：discoveryRan=true 且零配对，后续配对只能来自 refresh
      await mod.prewarmAutoSession()
      expect(mod.isModelAutoCovered("refreshed-model")).toBe(false)
      failAll = false

      // 只经 refreshAutoSession 建立配对
      await mod.refreshAutoSession()
      expect(
        (await mod.getAutoSessionForModel({ model: "refreshed-model" }))
          ?.sessionToken,
      ).toBe("token-refreshed")
      const callsAfterRefresh = calls

      // 真实轮换：invalidate + resume 后必须在新授权头下重新选模型
      state.copilotToken = "new-token"
      mod.invalidateAutoSession()
      mod.resumeAutoSessionDiscoveryAfterRotation()
      await mod.whenProbeSchedulerIdle()
      expect(calls).toBe(callsAfterRefresh + 1)
      expect(auths.at(-1)).toBe("Bearer new-token")
      expect(
        (await mod.getAutoSessionForModel({ model: "refreshed-model" }))
          ?.sessionToken,
      ).toBe("token-refreshed")
    } finally {
      state.copilotToken = "dummy-auth-token-a"
      mod.stopProbeScheduler()
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("expired miss re-probes pairings established only via refreshAutoSession", async () => {
    const mod = await loadAutoSessionModule()
    let calls = 0
    const realNow = Date.now
    state.copilotToken = "refresh-token"
    try {
      setFetchMock((() => {
        calls += 1
        if (calls > 16) return Promise.reject(new Error("cap exceeded"))
        // 重探选中不同模型：不得错绑到原模型 id
        const model = calls === 1 ? "refreshed-model" : "refreshed-model-v2"
        return Promise.resolve(
          createResponse(
            selection(model, `token-${model}`, {
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            }),
          ),
        )
      }) as unknown as typeof fetch)

      await mod.refreshAutoSession()
      expect(
        (await mod.getAutoSessionForModel({ model: "refreshed-model" }))
          ?.sessionToken,
      ).toBe("token-refreshed-model")

      // 推进时钟到过期：首次 get 发一次重新探测
      Date.now = () => realNow() + 3_700_000
      expect(
        (await mod.getAutoSessionForModel({ model: "refreshed-model" }))
          ?.sessionToken,
      ).toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(calls).toBe(2)

      await mod.whenProbeSchedulerIdle()
      await new Promise((resolve) => setTimeout(resolve, 50))
      // 新响应按实际 ID 登记，原模型不得错绑新 token
      expect(
        (await mod.getAutoSessionForModel({ model: "refreshed-model" }))
          ?.sessionToken,
      ).toBeUndefined()
      expect(
        (await mod.getAutoSessionForModel({ model: "refreshed-model-v2" }))
          ?.sessionToken,
      ).toBe("token-refreshed-model-v2")
      expect(calls).toBe(2)
      Date.now = realNow
    } finally {
      Date.now = realNow
      state.copilotToken = "dummy-auth-token-a"
      mod.stopProbeScheduler()
      await mod.whenProbeSchedulerIdle()
    }
  })
})

const installFusionCatalog = (...ids: Array<string>): void => {
  state.models = {
    object: "list",
    data: ids.map((id): Model => ({
      id,
      name: id,
      object: "model",
      model_picker_enabled: true,
      preview: false,
      vendor: "test",
      version: "test",
      capabilities: {
        family: "test",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "test",
        type: "chat",
      },
      supported_endpoints: ["/responses", "/chat/completions", "/v1/messages"],
    })),
  }
}

const fusionResponse = (
  model: string,
  token: string,
  expiresAt = Math.floor(Date.now() / 1000) + 3600,
): Response =>
  new Response(
    JSON.stringify({
      fusion_pattern: "solo",
      steps: [{ model_id: model }],
      session: { token, expires_at: expiresAt },
    }),
    { status: 200 },
  )

describe("two-source discount pairings", () => {
  beforeEach(() => {
    state.copilotToken = "discount-auth-a"
    getConfig().autoDiscovery = undefined
    installFusionCatalog("discount-model", "other-model")
  })

  afterEach(async () => {
    for (const module of modules.splice(0)) {
      module.stopProbeScheduler()
      await module.whenProbeSchedulerIdle()
    }
    globalThis.fetch = originalFetch
    state.copilotToken = originalToken
    state.models = originalModels
    getConfig().autoDiscovery = originalAutoDiscovery
    mock.restore()
    await mock.module("node:timers/promises", () => originalTimerPromises)
  })

  test("Fusion30 wins even when Auto10 arrives later; endpoint and excluded-source selection use the same candidates", async () => {
    const mod = await loadAutoSessionModule()
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    expect(
      mod.registerFusionSelection(
        {
          planVersion: "2" as const,
          fusionPattern: "solo",
          steps: [{ modelId: "discount-model" }],
          sessionToken: "fusion-30",
          expiresAt,
        },
        createProbeCondition({
          source: "fusion",
          planVersion: "2",
          fusionMode: "hydrafusion",
          prompt: "hello",
        }),
      ),
    ).toBe(true)
    expect(
      mod.registerAutoSelection(
        selection("discount-model", "auto-10", {
          supportedEndpoints: [
            "/responses",
            "/chat/completions",
            "/v1/messages",
          ],
        }),
        createProbeCondition({
          source: "auto",
          tier: "balance",
          prompt: "hello",
        }),
      ),
    ).toBe(true)
    expect(
      await mod.getAutoSessionForModel({
        model: "discount-model",
        endpoint: "/responses",
      }),
    ).toEqual({
      sessionToken: "fusion-30",
      source: "fusion",
      expectedDiscount: 30,
    })
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/chat/completions",
        })
      )?.sessionToken,
    ).toBe("auto-10")
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/v1/messages",
        })
      )?.sessionToken,
    ).toBe("auto-10")
    expect(
      await mod.getAutoSessionForModel({
        model: "discount-model",
        endpoint: "/responses",
        excludedSources: new Set(["fusion"]),
      }),
    ).toEqual({ sessionToken: "auto-10", source: "auto", expectedDiscount: 10 })
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          excludedSources: new Set(["fusion", "auto"]),
        })
      )?.sessionToken,
    ).toBeUndefined()
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "other-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBeUndefined()
  })

  test("source expiry is independent and uses server expiry rather than a fixed cache lifetime", async () => {
    const mod = await loadAutoSessionModule()
    mod.stopProbeScheduler()
    let now = Date.now()
    spyOn(Date, "now").mockImplementation(() => now)
    const expiresAt = Math.floor(now / 1000)
    mod.registerFusionSelection(
      {
        planVersion: "2" as const,
        fusionPattern: "solo",
        steps: [{ modelId: "discount-model" }],
        sessionToken: "fusion-short",
        expiresAt: expiresAt + 600,
      },
      createProbeCondition({
        source: "fusion",
        planVersion: "2",
        fusionMode: "hydrafusion",
        prompt: "hello",
      }),
    )
    mod.registerAutoSelection(
      selection("discount-model", "auto-long", {
        expiresAt: expiresAt + 1800,
        supportedEndpoints: ["/responses"],
      }),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    now += 601_000
    expect(
      await mod.getAutoSessionForModel({
        model: "discount-model",
        endpoint: "/responses",
      }),
    ).toEqual({
      sessionToken: "auto-long",
      source: "auto",
      expectedDiscount: 10,
    })
    expect(mod.isModelAutoCovered("discount-model")).toBe(true)
    now += 1_200_000
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBeUndefined()
    expect(mod.isModelAutoCovered("discount-model")).toBe(false)
  })

  test("Auto expiry cannot expire a still-valid Fusion candidate", async () => {
    const mod = await loadAutoSessionModule()
    mod.stopProbeScheduler()
    let now = Date.now()
    spyOn(Date, "now").mockImplementation(() => now)
    mod.registerAutoSelection(
      selection("discount-model", "auto-short", {
        expiresAt: Math.floor(now / 1000) + 600,
      }),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    mod.registerFusionSelection(
      {
        planVersion: "2" as const,
        fusionPattern: "solo",
        steps: [{ modelId: "discount-model" }],
        sessionToken: "fusion-long",
        expiresAt: Math.floor(now / 1000) + 1800,
      },
      createProbeCondition({
        source: "fusion",
        planVersion: "2",
        fusionMode: "hydrafusion",
        prompt: "hello",
      }),
    )
    now += 601_000
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("fusion-long")
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          excludedSources: new Set(["fusion"]),
        })
      )?.sessionToken,
    ).toBeUndefined()
  })

  test("rejection removes only the sent source and rejects replay until the original expiry", async () => {
    const mod = await loadAutoSessionModule()
    mod.stopProbeScheduler()
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const fusion = {
      planVersion: "2" as const,
      fusionPattern: "solo",
      steps: [{ modelId: "discount-model" }],
      sessionToken: "rejected-fusion",
      expiresAt,
    }
    const auto = selection("discount-model", "kept-auto")
    mod.registerFusionSelection(
      fusion,
      createProbeCondition({
        source: "fusion",
        planVersion: "2",
        fusionMode: "hydrafusion",
        prompt: "hello",
      }),
    )
    mod.registerAutoSelection(
      auto,
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    expect(
      mod.invalidateAutoSessionPairing("discount-model", fusion.sessionToken),
    ).toBe(true)
    expect(
      mod.registerFusionSelection(
        fusion,
        createProbeCondition({
          source: "fusion",
          planVersion: "2",
          fusionMode: "hydrafusion",
          prompt: "hello",
        }),
      ),
    ).toBe(false)
    expect(
      (await mod.getAutoSessionForModel({ model: "discount-model" }))
        ?.sessionToken,
    ).toBe("kept-auto")
    expect(
      mod.registerFusionSelection(
        { ...fusion, sessionToken: "new-fusion" },
        createProbeCondition({
          source: "fusion",
          planVersion: "2",
          fusionMode: "hydrafusion",
          prompt: "hello",
        }),
      ),
    ).toBe(true)
    expect(
      mod.invalidateAutoSessionPairing("discount-model", fusion.sessionToken),
    ).toBe(false)
    expect(
      (await mod.getAutoSessionForModel({ model: "discount-model" }))
        ?.sessionToken,
    ).toBe("new-fusion")
    expect(
      mod.invalidateAutoSessionPairing("discount-model", "kept-auto"),
    ).toBe(true)
    expect(
      mod.registerAutoSelection(
        auto,
        createProbeCondition({
          source: "auto",
          tier: "balance",
          prompt: "hello",
        }),
      ),
    ).toBe(false)
    expect(
      (await mod.getAutoSessionForModel({ model: "discount-model" }))
        ?.sessionToken,
    ).toBe("new-fusion")
  })

  test("newer probe request wins even when its expiry is shorter than a late older result", async () => {
    const mod = await loadAutoSessionModule()
    const older = Promise.withResolvers<Response>()
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw new Error("expected string request body")
      const body = JSON.parse(init.body) as { prompt: string }
      return body.prompt === "older" ?
          older.promise
        : Promise.resolve(
            createResponse(selection("discount-model", "newer", { expiresAt })),
          )
    }) as unknown as typeof fetch
    const first = mod.runProbePoint("efficiency", "easy", "older")
    try {
      await mod.runProbePoint("balance", "easy", "newer")
      older.resolve(
        createResponse(
          selection("discount-model", "older", { expiresAt: expiresAt + 3600 }),
        ),
      )
      await first
      expect(
        (await mod.getAutoSessionForModel({ model: "discount-model" }))
          ?.sessionToken,
      ).toBe("newer")
    } finally {
      older.resolve(createResponse(selection("discount-model", "older")))
      await first
    }
  })

  test("a pre-rejection in-flight Auto response cannot cross the source commit barrier", async () => {
    const mod = await loadAutoSessionModule()
    const stale = Promise.withResolvers<Response>()
    mod.registerAutoSelection(
      selection("discount-model", "sent-auto"),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    globalThis.fetch = mock(() => stale.promise) as unknown as typeof fetch
    const pending = mod.runProbePoint("efficiency", "easy", "stale")
    try {
      expect(
        mod.invalidateAutoSessionPairing("discount-model", "sent-auto"),
      ).toBe(true)
      stale.resolve(
        createResponse(selection("discount-model", "late-different-auto")),
      )
      await pending
      mod.stopProbeScheduler()
      expect(
        (await mod.getAutoSessionForModel({ model: "discount-model" }))
          ?.sessionToken,
      ).toBeUndefined()
    } finally {
      mod.stopProbeScheduler()
      stale.resolve(
        createResponse(selection("discount-model", "late-different-auto")),
      )
      await pending
    }
  })

  test("same-credential cache invalidation blocks earlier successes but accepts the next probe", async () => {
    const mod = await loadAutoSessionModule()
    const stale = Promise.withResolvers<Response>()
    let calls = 0
    globalThis.fetch = mock(() => {
      calls++
      return calls === 1 ?
          stale.promise
        : Promise.resolve(
            createResponse(selection("discount-model", "fresh-auto")),
          )
    }) as unknown as typeof fetch
    const pending = mod.runProbePoint("efficiency", "easy", "hello")
    try {
      expect(calls).toBe(1)
      mod.invalidateAutoSession()
      stale.resolve(createResponse(selection("discount-model", "stale-auto")))
      expect(await pending).toBeUndefined()
      expect(mod.isModelAutoCovered("discount-model")).toBe(false)
      expect(calls).toBe(1)
      await mod.runProbePoint("efficiency", "easy", "hello")
      expect(calls).toBe(2)
      expect(
        (await mod.getAutoSessionForModel({ model: "discount-model" }))
          ?.sessionToken,
      ).toBe("fresh-auto")
    } finally {
      mod.stopProbeScheduler()
      stale.resolve(createResponse(selection("discount-model", "stale-auto")))
      await pending
    }
  })

  test("selection honors the actual request identity snapshot across credential rotation", async () => {
    const mod = await loadAutoSessionModule()
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    mod.registerFusionSelection(
      {
        planVersion: "2" as const,
        fusionPattern: "solo",
        steps: [{ modelId: "discount-model" }],
        sessionToken: "identity-a",
        expiresAt,
      },
      createProbeCondition({
        source: "fusion",
        planVersion: "2",
        fusionMode: "hydrafusion",
        prompt: "hello",
      }),
    )
    state.copilotToken = "discount-auth-b"
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          authToken: "discount-auth-b",
        })
      )?.sessionToken,
    ).toBeUndefined()
    mod.invalidateAutoSession()
    mod.registerFusionSelection(
      {
        planVersion: "2" as const,
        fusionPattern: "solo",
        steps: [{ modelId: "discount-model" }],
        sessionToken: "identity-b",
        expiresAt,
      },
      createProbeCondition({
        source: "fusion",
        planVersion: "2",
        fusionMode: "hydrafusion",
        prompt: "hello",
      }),
    )
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          authToken: "discount-auth-a",
        })
      )?.sessionToken,
    ).toBeUndefined()
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          authToken: "discount-auth-b",
        })
      )?.sessionToken,
    ).toBe("identity-b")
  })

  test("Fusion expiry after the public promotion date uses Auto immediately while a single background renewal restores 30", async () => {
    const mod = await loadAutoSessionModule()
    let now = Date.parse("2026-11-30T23:59:00Z")
    spyOn(Date, "now").mockImplementation(() => now)
    const renewal = Promise.withResolvers<Response>()
    const renewalStarted = Promise.withResolvers<void>()
    let fusionCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith("/model/fusion")) {
        fusionCalls++
        if (fusionCalls > 4) {
          renewalStarted.resolve()
          return renewal.promise
        }
        return Promise.resolve(
          fusionResponse(
            "discount-model",
            "fusion-before-date",
            Math.floor(now / 1000) + 600,
          ),
        )
      }
      if (!url.endsWith("/auto"))
        throw new Error("unexpected selection endpoint")
      return Promise.resolve(
        createResponse(selection("discount-model", "auto-before-renewal")),
      )
    }) as unknown as typeof fetch
    try {
      await mod.prewarmAutoSession()
      expect(fusionCalls).toBe(4)
      mod.registerAutoSelection(
        selection("discount-model", "auto-during-renewal", {
          expiresAt: Math.floor(now / 1000) + 7200,
          supportedEndpoints: ["/responses"],
        }),
        createProbeCondition({
          source: "auto",
          tier: "balance",
          prompt: "hello",
        }),
      )
      expect(
        (
          await mod.getAutoSessionForModel({
            model: "discount-model",
            endpoint: "/responses",
          })
        )?.sessionToken,
      ).toBe("fusion-before-date")
      now += 601_000
      const selections = await Promise.all(
        Array.from({ length: 20 }, () =>
          mod.getAutoSessionForModel({
            model: "discount-model",
            endpoint: "/responses",
          }),
        ),
      )
      expect(
        selections.every(
          (item) =>
            item?.source === "auto"
            && item.sessionToken === "auto-during-renewal",
        ),
      ).toBe(true)
      await renewalStarted.promise
      expect(fusionCalls).toBe(5)
      renewal.resolve(fusionResponse("discount-model", "fusion-after-date"))
      await mod.whenProbeSchedulerIdle()
      expect(
        await mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/responses",
        }),
      ).toEqual({
        sessionToken: "fusion-after-date",
        source: "fusion",
        expectedDiscount: 30,
      })
    } finally {
      mod.stopProbeScheduler()
      renewal.resolve(fusionResponse("discount-model", "fusion-after-date"))
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("each source refreshes at its own expiry minus five minutes without replacing the other source", async () => {
    const mod = await loadAutoSessionModule()
    let now = Math.floor(Date.now() / 1000) * 1000
    spyOn(Date, "now").mockImplementation(() => now)
    const timers: Array<{
      callback: () => void
      ms: number
      cancelled: boolean
    }> = []
    const realClearTimeout = globalThis.clearTimeout
    spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      ms = 0,
    ) => {
      const timer = { callback, ms, cancelled: false, unref() {} }
      timers.push(timer)
      return timer
    }) as unknown as typeof setTimeout)
    spyOn(globalThis, "clearTimeout").mockImplementation((timer: unknown) => {
      const captured = timers.find((candidate) => candidate === timer)
      if (captured) captured.cancelled = true
      else realClearTimeout(timer as NodeJS.Timeout)
    })
    let autoCalls = 0
    let fusionCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith("/model/fusion")) {
        fusionCalls++
        return Promise.resolve(
          fusionResponse("discount-model", "fusion-refreshed"),
        )
      }
      if (!url.endsWith("/auto"))
        throw new Error("unexpected selection endpoint")
      autoCalls++
      return Promise.resolve(
        createResponse(selection("discount-model", "auto-refreshed")),
      )
    }) as unknown as typeof fetch
    mod.registerAutoSelection(
      selection("discount-model", "auto-initial", {
        expiresAt: Math.floor(now / 1000) + 900,
      }),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    mod.registerFusionSelection(
      {
        planVersion: "2" as const,
        fusionPattern: "solo",
        steps: [{ modelId: "discount-model" }],
        sessionToken: "fusion-initial",
        expiresAt: Math.floor(now / 1000) + 600,
      },
      createProbeCondition({
        source: "fusion",
        planVersion: "2",
        fusionMode: "hydrafusion",
        prompt: "hello",
      }),
    )
    expect(timers.map((timer) => timer.ms)).toEqual([600_000, 300_000])
    now += 300_000
    timers[1].callback()
    await mod.whenProbeSchedulerIdle()
    expect(fusionCalls).toBe(1)
    expect(autoCalls).toBe(0)
    expect(
      (await mod.getAutoSessionForModel({ model: "discount-model" }))
        ?.sessionToken,
    ).toBe("fusion-refreshed")
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          excludedSources: new Set(["fusion"]),
        })
      )?.sessionToken,
    ).toBe("auto-initial")
    now += 300_000
    expect(timers[0].cancelled).toBe(false)
    timers[0].callback()
    await mod.whenProbeSchedulerIdle()
    expect(autoCalls).toBe(1)
    expect(fusionCalls).toBe(1)
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          excludedSources: new Set(["fusion"]),
        })
      )?.sessionToken,
    ).toBe("auto-refreshed")
    expect(
      (await mod.getAutoSessionForModel({ model: "discount-model" }))
        ?.sessionToken,
    ).toBe("fusion-refreshed")
  })

  test("Fusion probe commit order follows requests rather than token expiry", async () => {
    const mod = await loadAutoSessionModule()
    const gates = Array.from({ length: 4 }, () =>
      Promise.withResolvers<Response>(),
    )
    const registered = Promise.withResolvers<void>()
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    let fusionCalls = 0
    spyOn(consola, "info").mockImplementation(
      Object.assign(
        (message: unknown) => {
          if (
            String(message).includes("source=fusion")
            && String(message).includes("expected_discount=30%")
          )
            registered.resolve()
        },
        { raw() {} },
      ),
    )
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith("/model/fusion")) return gates[fusionCalls++].promise
      if (!url.endsWith("/auto"))
        throw new Error("unexpected selection endpoint")
      return Promise.resolve(
        createResponse(selection("discount-model", "later-auto")),
      )
    }) as unknown as typeof fetch
    // The short real budget returns while the externally gated HTTP responses remain in flight.
    const warm = mod.prewarmAutoSession({ startupBudgetMs: 20 })
    try {
      await warm
      expect(fusionCalls).toBe(4)
      gates[3].resolve(
        fusionResponse("discount-model", "newest-fusion", expiresAt),
      )
      await registered.promise
      for (const gate of gates.slice(0, 3))
        gate.resolve(
          fusionResponse("discount-model", "older-fusion", expiresAt + 3600),
        )
      await mod.whenProbeSchedulerIdle()
      expect(
        (await mod.getAutoSessionForModel({ model: "discount-model" }))
          ?.sessionToken,
      ).toBe("newest-fusion")
    } finally {
      mod.stopProbeScheduler()
      for (const gate of gates)
        gate.resolve(fusionResponse("discount-model", "released-fusion"))
      await warm
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("pre-rejection Fusion responses cannot restore a candidate or remove the valid Auto fallback", async () => {
    const mod = await loadAutoSessionModule()
    const stale = Promise.withResolvers<void>()
    let fusionCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith("/model/fusion")) {
        fusionCalls++
        return stale.promise.then(() =>
          fusionResponse("discount-model", "late-different-fusion"),
        )
      }
      if (!url.endsWith("/auto"))
        throw new Error("unexpected selection endpoint")
      return Promise.resolve(
        createResponse(selection("discount-model", "preserved-auto")),
      )
    }) as unknown as typeof fetch
    mod.registerFusionSelection(
      {
        planVersion: "2" as const,
        fusionPattern: "solo",
        steps: [{ modelId: "discount-model" }],
        sessionToken: "rejected-fusion",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      createProbeCondition({
        source: "fusion",
        planVersion: "2",
        fusionMode: "hydrafusion",
        prompt: "hello",
      }),
    )
    try {
      // Exercise invalidation while all four seed requests are still in flight.
      await mod.prewarmAutoSession({ startupBudgetMs: 20 })
      expect(fusionCalls).toBe(4)
      expect(
        mod.invalidateAutoSessionPairing("discount-model", "rejected-fusion"),
      ).toBe(true)
      mod.stopProbeScheduler()
      stale.resolve()
      await mod.whenProbeSchedulerIdle()
      expect(
        (await mod.getAutoSessionForModel({ model: "discount-model" }))
          ?.sessionToken,
      ).toBe("preserved-auto")
      expect(
        (
          await mod.getAutoSessionForModel({
            model: "discount-model",
            excludedSources: new Set(["auto"]),
          })
        )?.sessionToken,
      ).toBeUndefined()
    } finally {
      mod.stopProbeScheduler()
      stale.resolve()
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("old-identity Fusion responses cannot overwrite a freshly registered new-identity pairing", async () => {
    const mod = await loadAutoSessionModule()
    const stale = Promise.withResolvers<void>()
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer discount-auth-a",
        )
        if (url.endsWith("/model/fusion"))
          return stale.promise.then(() =>
            fusionResponse("discount-model", "old-identity-fusion"),
          )
        if (!url.endsWith("/auto"))
          throw new Error("unexpected selection endpoint")
        return Promise.resolve(
          createResponse(selection("discount-model", "old-identity-auto")),
        )
      },
    ) as unknown as typeof fetch
    try {
      await mod.prewarmAutoSession({ startupBudgetMs: 20 })
      state.copilotToken = "discount-auth-b"
      mod.invalidateAutoSession()
      mod.stopProbeScheduler()
      expect(
        mod.registerFusionSelection(
          {
            planVersion: "2" as const,
            fusionPattern: "solo",
            steps: [{ modelId: "discount-model" }],
            sessionToken: "new-identity-fusion",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
          createProbeCondition({
            source: "fusion",
            planVersion: "2",
            fusionMode: "hydrafusion",
            prompt: "hello",
          }),
        ),
      ).toBe(true)
      stale.resolve()
      await mod.whenProbeSchedulerIdle()
      expect(
        (
          await mod.getAutoSessionForModel({
            model: "discount-model",
            authToken: "discount-auth-a",
          })
        )?.sessionToken,
      ).toBeUndefined()
      expect(
        (
          await mod.getAutoSessionForModel({
            model: "discount-model",
            authToken: "discount-auth-b",
          })
        )?.sessionToken,
      ).toBe("new-identity-fusion")
    } finally {
      mod.stopProbeScheduler()
      stale.resolve()
      await mod.whenProbeSchedulerIdle()
    }
  })

  test("an in-flight Auto10 response arriving after Fusion30 cannot downgrade the model", async () => {
    const mod = await loadAutoSessionModule()
    const auto = Promise.withResolvers<Response>()
    globalThis.fetch = mock(() => auto.promise) as unknown as typeof fetch
    const pending = mod.runProbePoint("efficiency", "easy", "late-auto")
    try {
      expect(
        mod.registerFusionSelection(
          {
            planVersion: "2" as const,
            fusionPattern: "solo",
            steps: [{ modelId: "discount-model" }],
            sessionToken: "earlier-fusion",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
          createProbeCondition({
            source: "fusion",
            planVersion: "2",
            fusionMode: "hydrafusion",
            prompt: "hello",
          }),
        ),
      ).toBe(true)
      auto.resolve(createResponse(selection("discount-model", "late-auto")))
      await pending
      expect(
        await mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/responses",
        }),
      ).toEqual({
        sessionToken: "earlier-fusion",
        source: "fusion",
        expectedDiscount: 30,
      })
      expect(
        (
          await mod.getAutoSessionForModel({
            model: "discount-model",
            excludedSources: new Set(["fusion"]),
          })
        )?.sessionToken,
      ).toBe("late-auto")
    } finally {
      mod.stopProbeScheduler()
      auto.resolve(createResponse(selection("discount-model", "late-auto")))
      await pending
    }
  })

  test("Fusion 保存题面的续期选到 N 后按真实模型登记，M 继续共享变体补采", async () => {
    const clock = installProbeClock(Date.now())
    const mod = await loadAutoSessionModule()
    getConfig().autoDiscovery = { models: ["discount-model"] }
    const savedProbe = createProbeCondition({
      source: "fusion",
      planVersion: "2",
      fusionMode: "hydrafusion",
      prompt: "hello",
    })
    mod.resumeAutoSessionDiscoveryAfterRotation()
    mod.registerFusionSelection(
      {
        planVersion: "2" as const,
        fusionPattern: "solo",
        steps: [{ modelId: "discount-model" }],
        sessionToken: "expired-fusion",
        expiresAt: Math.floor(clock.now / 1000) + 600,
      },
      savedProbe,
    )
    mod.registerAutoSelection(
      selection("discount-model", "kept-auto", {
        expiresAt: Math.floor(clock.now / 1000) + 86400,
        supportedEndpoints: ["/responses"],
      }),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    const prompts: Array<string> = []
    const conditionIds: Array<string> = []
    let recoverVariants = false
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        if (!url.endsWith("/model/fusion"))
          throw new Error("unexpected selection endpoint")
        if (typeof init?.body !== "string")
          throw new Error("expected string request body")
        const {
          prompt,
          plan_version: planVersion,
          fusion_mode: fusionMode,
        } = JSON.parse(init.body) as {
          prompt: string
          plan_version: "1" | "2"
          fusion_mode: "hydrafusion"
        }
        const condition = createProbeCondition({
          source: "fusion",
          planVersion,
          fusionMode,
          prompt,
        })
        prompts.push(prompt)
        conditionIds.push(condition.id)
        const recovered = recoverVariants && condition.id !== savedProbe.id
        return Promise.resolve(
          fusionResponse(
            recovered ? "discount-model" : "other-model",
            recovered ? "variant-m" : "actual-n",
          ),
        )
      },
    ) as unknown as typeof fetch
    clock.now += 601_000
    const selections = await Promise.all(
      Array.from({ length: 20 }, () =>
        mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/responses",
        }),
      ),
    )
    expect(selections.every((item) => item?.sessionToken === "kept-auto")).toBe(
      true,
    )
    await clock.finishCurrentRound(mod)
    expect(prompts).toHaveLength(10)
    expect(prompts[0]).toBe("hello")
    expect(conditionIds[1]).not.toBe(conditionIds[0])
    expect(new Set(conditionIds.slice(0, 10)).size).toBe(10)
    const exhaustedAt = clock.now
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "other-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("actual-n")
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("kept-auto")
    clock.now = exhaustedAt + 89_999
    await mod.getAutoSessionForModel({
      model: "discount-model",
      endpoint: "/responses",
    })
    expect(prompts).toHaveLength(10)
    clock.now = exhaustedAt + 90_000
    recoverVariants = true
    await Promise.all(
      Array.from({ length: 20 }, () =>
        mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/responses",
        }),
      ),
    )
    await clock.finishCurrentRound(mod)
    expect(prompts).toHaveLength(12)
    expect(prompts[10]).toBe("hello")
    expect(conditionIds[11]).not.toBe(conditionIds[10])
    expect(new Set(conditionIds.slice(10)).size).toBe(2)
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("variant-m")
    expect(prompts).toHaveLength(12)
  })

  test("Fusion target 的定时续期和过期重获都有界，失败算十次预算且冷却后才能重开", async () => {
    const clock = installProbeClock(Math.floor(Date.now() / 1000) * 1000)
    const startedAt = clock.now
    const mod = await loadAutoSessionModule()
    const timers = clock.timers
    const prompts: Array<string> = []
    let failing = false
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        if (!url.endsWith("/model/fusion"))
          throw new Error("unexpected selection endpoint")
        if (typeof init?.body !== "string")
          throw new Error("expected string request body")
        const { prompt } = JSON.parse(init.body) as { prompt: string }
        prompts.push(prompt)
        if (failing) {
          return Promise.resolve(
            new Response(null, {
              status: 503,
              headers: { "retry-after": "1" },
            }),
          )
        }
        return Promise.resolve(
          fusionResponse(
            "discount-model",
            "fusion-target",
            Math.floor(clock.now / 1000) + 600,
          ),
        )
      },
    ) as unknown as typeof fetch
    getConfig().autoDiscovery = { models: ["discount-model"] }
    mod.resumeAutoSessionDiscoveryAfterRotation()
    mod.registerAutoSelection(
      selection("discount-model", "kept-auto", {
        expiresAt: Math.floor(clock.now / 1000) + 86400,
        supportedEndpoints: ["/responses"],
      }),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    await clock.finishCurrentRound(mod)
    expect(prompts).toHaveLength(1)
    const savedPrompt = prompts[0]
    const refresh = timers.find((timer) => timer.ms === 300_000)
    if (refresh === undefined) throw new Error("missing Fusion refresh timer")
    expect(refresh).toBeDefined()
    failing = true
    clock.now = startedAt + 300_000
    refresh.cancelled = true
    refresh.callback()
    await clock.finishCurrentRound(mod)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toBe(savedPrompt)
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("fusion-target")
    expect(prompts).toHaveLength(2)
    clock.now = startedAt + 601_000
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("kept-auto")
    await clock.finishCurrentRound(mod)
    expect(prompts).toHaveLength(12)
    expect(new Set(prompts.slice(2)).size).toBeGreaterThan(1)
    const cooldown = timers.find(
      (timer) => !timer.cancelled && timer.ms === 90_000,
    )
    if (cooldown === undefined) throw new Error("missing Fusion cooldown timer")
    expect(clock.now).toBeLessThan(cooldown.at)
    await clock.advanceBy(cooldown.at - clock.now - 1)
    await Promise.all(
      Array.from({ length: 20 }, () =>
        mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/responses",
        }),
      ),
    )
    expect(prompts).toHaveLength(12)
    failing = false
    await clock.advanceBy(1)
    await mod.getAutoSessionForModel({
      model: "discount-model",
      endpoint: "/responses",
    })
    await clock.finishCurrentRound(mod)
    expect(prompts).toHaveLength(13)
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "discount-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("fusion-target")
    expect(prompts).toHaveLength(13)
  })
})
