import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import type { AutoSelectionResponse } from "../src/services/copilot/get-auto-selection"

type AutoSessionModule = typeof import("../src/lib/auto-session")

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
  ;(globalThis as TestGlobal).fetch = mockedFetch
}

const originalFetch = globalThis.fetch

const loadAutoSessionModule = async (): Promise<AutoSessionModule> => {
  const module = (await import(
    `../src/lib/auto-session?test=${Date.now()}-${Math.random()}`
  )) as AutoSessionModule
  return module
}

let fetchMock: ReturnType<typeof mock>

describe("auto-session", () => {
  beforeEach(() => {
    const queue: Array<AutoSelectionResponse> = []
    ;(globalThis as TestGlobal).__AUTO_SESSION_QUEUE__ = queue
    state.copilotToken = "dummy-auth-token-a"

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

  afterEach(() => {
    setFetchMock(originalFetch)
    delete (globalThis as TestGlobal).__AUTO_SESSION_QUEUE__
    mock.restore()
  })

  test("prewarm registers pairing by selected model id and caches token", async () => {
    const {
      getAutoSessionTokenForModel,
      isModelAutoCovered,
      prewarmAutoSession,
    } = await loadAutoSessionModule()

    getQueue().push(
      selection("gpt-5.3-codex", "token-initial", {
        supportedEndpoints: ["/responses", "ws:/responses"],
      }),
    )

    await prewarmAutoSession()

    expect(isModelAutoCovered("gpt-5.3-codex")).toBe(true)
    expect(isModelAutoCovered("not-covered")).toBe(false)

    const token = await getAutoSessionTokenForModel("gpt-5.3-codex")
    expect(token).toBe("token-initial")

    const scoped = await getAutoSessionTokenForModel(
      "gpt-5.3-codex",
      "/responses",
    )
    expect(scoped).toBe("token-initial")
  })

  test("returns undefined when model is not covered", async () => {
    const { getAutoSessionTokenForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    getQueue().push(selection("other-model", "token-initial"))

    await prewarmAutoSession()

    const token = await getAutoSessionTokenForModel("gpt-4o")
    expect(token).toBeUndefined()
  })

  test("prewarm failure is swallowed and does not block subsequent flow", async () => {
    const { getAutoSessionTokenForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    await prewarmAutoSession()

    const token = await getAutoSessionTokenForModel("gpt-5.3-codex")
    expect(token).toBeUndefined()
  })

  test("misses after prewarm failure until a later probe registers a pairing", async () => {
    const { getAutoSessionTokenForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    await prewarmAutoSession()
    expect(await getAutoSessionTokenForModel("gpt-5.3-codex")).toBeUndefined()
    // 源码充足时启动发现共 8 个探测点（4 档 × 简单题/难题）
    expect(fetchMock).toHaveBeenCalledTimes(8)

    getQueue().push(selection("gpt-5.3-codex", "token-after-failure"))
    await prewarmAutoSession()
    expect(fetchMock).toHaveBeenCalledTimes(16)

    expect(await getAutoSessionTokenForModel("gpt-5.3-codex")).toBe(
      "token-after-failure",
    )
  })

  test("reuses cached token for covered model without extra probe", async () => {
    const { getAutoSessionTokenForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    getQueue().push(selection("gpt-5.3-codex", "token-stable"))
    await prewarmAutoSession()
    // 8 个探测点各请求一次；查询命中缓存不再发请求
    expect(fetchMock).toHaveBeenCalledTimes(8)

    const first = await getAutoSessionTokenForModel("gpt-5.3-codex")
    const second = await getAutoSessionTokenForModel("gpt-5.3-codex")
    expect(first).toBe("token-stable")
    expect(second).toBe("token-stable")
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })

  test("misses after Copilot auth token identity changes until re-probe", async () => {
    const { getAutoSessionTokenForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    getQueue().push(selection("gpt-5.3-codex", "token-for-auth-a"))

    await prewarmAutoSession()
    expect(await getAutoSessionTokenForModel("gpt-5.3-codex")).toBe(
      "token-for-auth-a",
    )

    state.copilotToken = "dummy-auth-token-b"
    expect(await getAutoSessionTokenForModel("gpt-5.3-codex")).toBeUndefined()

    getQueue().push(selection("gpt-5.3-codex", "token-for-auth-b"))
    await prewarmAutoSession()
    expect(await getAutoSessionTokenForModel("gpt-5.3-codex")).toBe(
      "token-for-auth-b",
    )
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
      expect(registerAutoSelection(invalid)).toBe(false)
    }

    expect(isModelAutoCovered("gpt-5.3-codex")).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("refresh rejects invalid upstream response and caches nothing", async () => {
    const {
      getAutoSessionTokenForModel,
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
      await getAutoSessionTokenForModel("gpt-5.3-codex", "/responses"),
    ).toBeUndefined()

    // prewarm 仍吞掉失败；后续合法探测可恢复配对
    getQueue().push(
      selection("gpt-5.3-codex", "token-good", {
        supportedEndpoints: ["/responses"],
      }),
    )
    await prewarmAutoSession()
    expect(
      await getAutoSessionTokenForModel("gpt-5.3-codex", "/responses"),
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
        const lines = body.prompt.split("\n")
        expect(lines).toHaveLength(102)
        expect(lines[100]).toBe("")
      }
    }
    expect(easyTiers.sort()).toEqual([...TIERS].sort())
    expect(hardPrompts).toBe(4)
  })

  test("keeps one pairing per model id with the latest token", async () => {
    const { getAutoSessionTokenForModel, registerAutoSelection } =
      await loadAutoSessionModule()

    expect(
      registerAutoSelection(selection("gpt-5.3-codex", "token-first")),
    ).toBe(true)
    expect(
      registerAutoSelection(selection("gpt-5.3-codex", "token-latest")),
    ).toBe(true)

    expect(await getAutoSessionTokenForModel("gpt-5.3-codex")).toBe(
      "token-latest",
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("token is only usable for its own model id", async () => {
    const { getAutoSessionTokenForModel, registerAutoSelection } =
      await loadAutoSessionModule()

    registerAutoSelection(
      selection("gpt-5.3-codex", "token-own", {
        supportedEndpoints: ["/responses"],
      }),
    )

    expect(await getAutoSessionTokenForModel("gpt-5.4", "/responses")).toBe(
      undefined,
    )
    expect(
      await getAutoSessionTokenForModel("gpt-5.3-codex", "/responses"),
    ).toBe("token-own")
  })

  test("endpoint applicability follows supported_endpoints", async () => {
    const { getAutoSessionTokenForModel, registerAutoSelection } =
      await loadAutoSessionModule()

    registerAutoSelection(
      selection("gpt-6-luna", "token-luna", {
        supportedEndpoints: ["/responses", "ws:/responses"],
      }),
    )

    expect(await getAutoSessionTokenForModel("gpt-6-luna", "/responses")).toBe(
      "token-luna",
    )
    expect(
      await getAutoSessionTokenForModel("gpt-6-luna", "/chat/completions"),
    ).toBeUndefined()
    expect(await getAutoSessionTokenForModel("gpt-6-luna")).toBe("token-luna")

    // 只支持 websocket 的配对不可用于 HTTP 端点
    registerAutoSelection(
      selection("ws-only-model", "token-ws", {
        supportedEndpoints: ["ws:/responses"],
      }),
    )
    expect(
      await getAutoSessionTokenForModel("ws-only-model", "/responses"),
    ).toBe(undefined)

    // 上游端点均为完整路径：候选 "/v1/messages" 精确服务请求端点 "/v1/messages"
    registerAutoSelection(
      selection("claude-model", "token-claude", {
        supportedEndpoints: ["/v1/messages"],
      }),
    )
    expect(
      await getAutoSessionTokenForModel("claude-model", "/v1/messages"),
    ).toBe("token-claude")
  })

  test("lookup result is independent of the forceAgent flag", async () => {
    const { getAutoSessionTokenForModel, registerAutoSelection } =
      await loadAutoSessionModule()

    registerAutoSelection(
      selection("gpt-5.3-codex", "token-flag", {
        supportedEndpoints: ["/responses"],
      }),
    )

    state.forceAgent = true
    expect(
      await getAutoSessionTokenForModel("gpt-5.3-codex", "/responses"),
    ).toBe("token-flag")

    state.forceAgent = false
    expect(
      await getAutoSessionTokenForModel("gpt-5.3-codex", "/responses"),
    ).toBe("token-flag")
  })

  test("invalidate clears every pairing", async () => {
    const {
      getAutoSessionTokenForModel,
      invalidateAutoSession,
      isModelAutoCovered,
      registerAutoSelection,
    } = await loadAutoSessionModule()

    registerAutoSelection(selection("gpt-5.3-codex", "token-clear"))

    invalidateAutoSession()

    expect(isModelAutoCovered("gpt-5.3-codex")).toBe(false)
    expect(await getAutoSessionTokenForModel("gpt-5.3-codex")).toBeUndefined()
  })

  test("refreshAutoSession does not register a stale in-flight response after credential rotation; retries under the new credential", async () => {
    const {
      getAutoSessionTokenForModel,
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
      expect(await getAutoSessionTokenForModel("old-model")).toBeUndefined()
      expect(await getAutoSessionTokenForModel("new-model")).toBe("token-new")
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
      expect(await mod.getAutoSessionTokenForModel("model-a")).toBe("token-a-2")
      expect(await mod.getAutoSessionTokenForModel("model-b")).toBe("token-b")
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
      expect(await mod.getAutoSessionTokenForModel("due-model")).toBe("token-2")
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
        // 补采在穿越后的时钟下拿到续期（now+120s，仍在未来、无需再排程）
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
      Date.now = () => realNow() + 31 * 24 * 3600 * 1000
      longTimers[1].cb()
      const start = Date.now()
      while (calls < 2 && Date.now() - start < 2_000) {
        await new Promise((resolve) => realSetTimeout(resolve, 10))
      }
      // 让 void runProbePoint 的登记链落定后再断言
      await new Promise((resolve) => realSetTimeout(resolve, 50))
      expect(calls).toBe(2)
      // 刷新仍拿到同一过期 expiry（fromTimer 且 fireIn<=0）→ 不再排新定时器
      expect(longTimers.length).toBe(2)
      Date.now = realNow
      expect(await mod.getAutoSessionTokenForModel("long-model")).toBe(
        "token-2",
      )
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
      expect(await mod.getAutoSessionTokenForModel("new-model")).toBe(
        "token-new",
      )
      expect(await mod.getAutoSessionTokenForModel("old-model")).toBe(
        "token-old",
      )
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
      expect(await mod.getAutoSessionTokenForModel("old-model")).toBeUndefined()
      expect(mod.isModelAutoCovered("old-model")).toBe(false)
      expect(await mod.getAutoSessionTokenForModel("new-model")).toBe(
        "token-new",
      )
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
      expect(await mod.getAutoSessionTokenForModel("old-model")).toBe(
        "token-old",
      )
      expect(calls).toBe(1)

      // 前移时钟越过 old-model 自身到期时刻
      Date.now = () => realNow() + 3_700_000

      // 连续 5 次 lookup：全部 undefined，且单飞只发一次补采
      const results = await Promise.all([
        mod.getAutoSessionTokenForModel("old-model"),
        mod.getAutoSessionTokenForModel("old-model"),
        mod.getAutoSessionTokenForModel("old-model"),
        mod.getAutoSessionTokenForModel("old-model"),
        mod.getAutoSessionTokenForModel("old-model"),
      ])
      expect(results.every((result) => result === undefined)).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(calls).toBe(2)
      // 挂起期间：旧 model 已删（不会误绑新 token），新 model 尚未登记
      expect(await mod.getAutoSessionTokenForModel("old-model")).toBeUndefined()
      expect(await mod.getAutoSessionTokenForModel("new-model")).toBeUndefined()

      // 放行：仅按新响应实际 ID 登记
      gate.resolve()
      await mod.whenProbeSchedulerIdle()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(await mod.getAutoSessionTokenForModel("new-model")).toBe(
        "token-new",
      )
      expect(await mod.getAutoSessionTokenForModel("old-model")).toBeUndefined()
      expect(calls).toBe(2)

      // 恢复真实时钟：新配对仍未到期，继续可用
      Date.now = realNow
      expect(await mod.getAutoSessionTokenForModel("new-model")).toBe(
        "token-new",
      )
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
        mod.getAutoSessionTokenForModel("stale-model"),
        mod.getAutoSessionTokenForModel("stale-model"),
        mod.getAutoSessionTokenForModel("stale-model"),
        mod.getAutoSessionTokenForModel("stale-model"),
        mod.getAutoSessionTokenForModel("stale-model"),
      ])
      expect(results.every((result) => result === undefined)).toBe(true)
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
      expect(await mod.getAutoSessionTokenForModel("refreshed-model")).toBe(
        "token-refreshed",
      )
      const callsAfterRefresh = calls

      // 真实轮换：invalidate + resume 后必须在新授权头下重新选模型
      state.copilotToken = "new-token"
      mod.invalidateAutoSession()
      mod.resumeAutoSessionDiscoveryAfterRotation()
      await mod.whenProbeSchedulerIdle()
      expect(calls).toBe(callsAfterRefresh + 1)
      expect(auths.at(-1)).toBe("Bearer new-token")
      expect(await mod.getAutoSessionTokenForModel("refreshed-model")).toBe(
        "token-refreshed",
      )
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
      expect(await mod.getAutoSessionTokenForModel("refreshed-model")).toBe(
        "token-refreshed-model",
      )

      // 推进时钟到过期：首次 get 发一次重新探测
      Date.now = () => realNow() + 3_700_000
      expect(
        await mod.getAutoSessionTokenForModel("refreshed-model"),
      ).toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(calls).toBe(2)

      await mod.whenProbeSchedulerIdle()
      await new Promise((resolve) => setTimeout(resolve, 50))
      // 新响应按实际 ID 登记，原模型不得错绑新 token
      expect(
        await mod.getAutoSessionTokenForModel("refreshed-model"),
      ).toBeUndefined()
      expect(await mod.getAutoSessionTokenForModel("refreshed-model-v2")).toBe(
        "token-refreshed-model-v2",
      )
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
