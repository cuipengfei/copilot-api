import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { createProbeCondition } from "../src/lib/auto-probe-prompts"
import consola from "consola"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"

import { state } from "../src/lib/state"
import type { AutoSelectionResponse } from "../src/services/copilot/get-auto-selection"
import { getConfig } from "../src/lib/config-store"

import type * as AutoSessionModule from "../src/lib/auto-session"
import type { Model } from "../src/lib/types/models"

const TIERS = ["efficiency", "balance", "intelligence", "fast"] as const

const okSelection = (
  modelId: string,
  sessionToken: string = `token-${modelId}`,
): AutoSelectionResponse => ({
  selected_model: { id: modelId, supported_endpoints: ["/responses"] },
  session_token: sessionToken,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
})

const createResponse = (payload: AutoSelectionResponse) =>
  new Response(JSON.stringify(payload), { status: 200 })

const originalFetch = globalThis.fetch
const originalAutoDiscovery = getConfig().autoDiscovery

const originalToken = state.copilotToken
const originalModels = state.models
const modules: Array<typeof AutoSessionModule> = []
// 动态导入用于重置模块级配对表：每个用例需要干净的 auto-session 状态。
// Static imports cannot reset the module-owned pairing table and scheduler.
// 带 query 的动态导入被 TS 视为 any，断言回模块类型以满足类型安全返回
const loadAutoSessionModule = async (): Promise<typeof AutoSessionModule> => {
  const module = (await import(
    `../src/lib/auto-session?test=${Date.now()}-${Math.random()}`
  )) as typeof AutoSessionModule
  modules.push(module)
  return module
}

interface RecordedCall {
  url: string
  init?: RequestInit
}

// 按请求内容路由，避免依赖调用顺序；Error 返回值模拟该探测点失败；
// Promise 返回值模拟上游长时间无响应（由测试控制放行时机）；
// Response 返回值直接作为上游应答（429/5xx/400 等非 2xx 状态）
const installRouter = (
  handler: (
    body: { prompt: string; tier: string },
    init?: RequestInit,
  ) =>
    | AutoSelectionResponse
    | Error
    | Response
    | Promise<AutoSelectionResponse | Response>,
  fusionHandler?: (
    body: { prompt: string },
    init?: RequestInit,
  ) => Response | Promise<Response>,
): { calls: Array<RecordedCall>; fusionCalls: Array<RecordedCall> } => {
  const fusionCalls: Array<RecordedCall> = []
  // 调用记录设硬上限：超出即视为探测循环失控，立即以普通 Error 终止，
  // 保证 mock 数组与日志占用有界
  const MAX_RECORDED_CALLS = 256
  const calls: Array<RecordedCall> = []
  const fetchMock = mock(
    (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = url instanceof Request ? url.url : String(url)
      if (calls.length >= MAX_RECORDED_CALLS) {
        return Promise.reject(
          new Error(
            `installRouter recorded ${MAX_RECORDED_CALLS} calls: runaway probe loop`,
          ),
        )
      }
      if (u.endsWith("/model/fusion")) {
        if (typeof init?.body !== "string")
          throw new Error("expected string request body")
        fusionCalls.push({ url: u, init })
        return Promise.resolve(
          fusionHandler?.(JSON.parse(init.body) as { prompt: string }, init)
            ?? new Response(
              JSON.stringify({ error: { code: "model_pool_not_eligible" } }),
              { status: 403 },
            ),
        )
      }
      calls.push({ url: u, init })
      if (!u.includes("/auto")) {
        // 本地替身必须暴露意外请求：非 /auto 一律视为上游泄漏，立即失败
        return Promise.reject(new Error(`unexpected fetch: ${u}`))
      }
      const raw = typeof init?.body === "string" ? init.body : "{}"
      const body = JSON.parse(raw) as { prompt: string; tier: string }
      const result = handler(body, init)
      if (result instanceof Error) return Promise.reject(result)
      if (result instanceof Response) return Promise.resolve(result)
      if (result instanceof Promise) {
        return result.then((r) =>
          r instanceof Response ? r : createResponse(r),
        )
      }
      return Promise.resolve(createResponse(result))
    },
  )
  ;(globalThis as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  return { calls, fusionCalls }
}

const requestBody = (call: RecordedCall): { prompt: string; tier: string } => {
  const raw = call.init?.body
  if (typeof raw !== "string") throw new Error("expected string request body")
  return JSON.parse(raw) as { prompt: string; tier: string }
}
const walkTs = async (
  dir: string,
  out: Array<string> = [],
): Promise<Array<string>> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walkTs(full, out)
    else if (
      entry.name.endsWith(".ts")
      && !entry.name.endsWith(".test.ts")
      && !entry.name.endsWith(".d.ts")
    ) {
      out.push(full)
    }
  }
  return out
}

const appearsInSourceTree = async (snippet: string): Promise<boolean> => {
  const needle = snippet.split("\n")
  for (const file of await walkTs("src")) {
    const lines = (await readFile(file, "utf8")).split("\n")
    for (let i = 0; i + needle.length <= lines.length; i += 1) {
      if (
        lines[i] === needle[0]
        && lines.slice(i, i + needle.length).join("\n") === snippet
      ) {
        return true
      }
    }
  }
  return false
}

interface InfoSpy {
  mock: { calls: Array<Array<unknown>> }
}

const discoveryLogLine = (infoSpy: InfoSpy): string => {
  const line = infoSpy.mock.calls
    .map((call) => String(call[0]))
    .find((text) => text.startsWith("[auto-session] discovery result "))
  expect(line).toBeDefined()
  return line as string
}

beforeEach(() => {
  state.copilotToken = "discovery-auth-token"
  getConfig().autoDiscovery = undefined
})

afterEach(async () => {
  for (const module of modules.splice(0)) {
    module.stopProbeScheduler()
    await module.whenProbeSchedulerIdle()
  }
  state.copilotToken = originalToken
  state.models = originalModels
  ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  mock.restore()
  getConfig().autoDiscovery = originalAutoDiscovery
})

test("startup probes fixed intelligence input and sampled hard inputs for the other tiers", async () => {
  const mod = await loadAutoSessionModule()
  const tokens = new Map<string, string>()
  const { calls } = installRouter((body) => {
    const model = `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`
    const token = `token-${model}`
    tokens.set(model, token)
    return okSelection(model, token)
  })

  await mod.prewarmAutoSession()

  expect(calls).toHaveLength(8)
  const perTier = new Map<string, { easy: number; hard: number }>()
  for (const call of calls) {
    expect(call.url).toContain("/auto")
    const headers = call.init?.headers as Record<string, string>
    expect(headers["content-type"]).toBe("application/json")
    expect(headers["Authorization"]).toBe("Bearer discovery-auth-token")
    const body = requestBody(call)
    const kinds = perTier.get(body.tier) ?? { easy: 0, hard: 0 }
    perTier.set(body.tier, kinds)
    kinds[body.prompt === "hello" ? "easy" : "hard"] += 1
  }
  for (const tier of TIERS) {
    expect(perTier.get(tier)).toEqual({ easy: 1, hard: 1 })
  }

  // 难题：恰好 100 行真实源码 + 空行 + 固定问题句
  const hardCall = calls.find(
    (call) =>
      requestBody(call).tier !== "intelligence"
      && requestBody(call).prompt !== "hello",
  ) as RecordedCall
  const lines = requestBody(hardCall).prompt.split("\n")
  expect(lines).toHaveLength(102)
  expect(lines[100]).toBe("")
  expect(await appearsInSourceTree(lines.slice(0, 100).join("\n"))).toBe(true)

  // 每次成功响应按实际模型 ID 注册，token 与模型精确绑定
  for (const [model, token] of tokens) {
    expect(mod.isModelAutoCovered(model)).toBe(true)
    expect(
      (await mod.getAutoSessionForModel({ model, endpoint: "/responses" }))
        ?.sessionToken,
    ).toBe(token)
  }
})

test("easy probe failure still runs hard probe for the same tier", async () => {
  const mod = await loadAutoSessionModule()
  const seen: Array<string> = []
  installRouter((body) => {
    if (body.prompt === "hello" && body.tier === "efficiency") {
      return new Error("easy probe down")
    }
    const model = `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`
    seen.push(model)
    return okSelection(model)
  })

  await mod.prewarmAutoSession()

  expect(seen).toContain("hard-efficiency")
  expect(mod.isModelAutoCovered("hard-efficiency")).toBe(true)
  expect(mod.isModelAutoCovered("easy-efficiency")).toBe(false)
})

test("same model from both prompts resamples hard prompt at most once", async () => {
  const mod = await loadAutoSessionModule()
  const tierCalls = new Map<string, number>()
  installRouter((body) => {
    tierCalls.set(body.tier, (tierCalls.get(body.tier) ?? 0) + 1)
    if (body.tier === "balance") return okSelection("dup-model")
    return okSelection(
      `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`,
    )
  })

  await mod.prewarmAutoSession()

  expect(tierCalls.get("balance")).toBe(3)
  expect(tierCalls.get("efficiency")).toBe(2)
  expect(tierCalls.get("intelligence")).toBe(2)
  expect(tierCalls.get("fast")).toBe(2)
  expect(mod.isModelAutoCovered("dup-model")).toBe(true)
})

test("probes carry an abort signal so unresponsive upstream cannot hang startup", async () => {
  const mod = await loadAutoSessionModule()
  let intelligenceSignal: AbortSignal | undefined
  installRouter((body, init) => {
    if (body.tier === "intelligence") {
      if (init?.signal) {
        intelligenceSignal = init.signal
        return new Error("simulated network abort")
      }
      return okSelection("no-signal-model")
    }
    return okSelection(`model-${body.tier}`)
  })

  await mod.prewarmAutoSession()

  expect(intelligenceSignal).toBeInstanceOf(AbortSignal)
  expect(mod.isModelAutoCovered("no-signal-model")).toBe(false)
})

test("sampleHardSnippet returns 100 consecutive lines from an eligible file only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-"))
  try {
    await writeFile(
      path.join(dir, "a.ts"),
      Array.from({ length: 150 }, (_, i) => `export const a${i} = ${i}`).join(
        "\n",
      ),
    )
    await writeFile(
      path.join(dir, "b.ts"),
      Array.from({ length: 100 }, (_, i) => `export const b${i} = ${i}`).join(
        "\n",
      ),
    )
    await writeFile(
      path.join(dir, "c.ts"),
      Array.from({ length: 99 }, (_, i) => `export const c${i} = ${i}`).join(
        "\n",
      ),
    )

    const mod = await loadAutoSessionModule()
    const snippet = await mod.sampleHardSnippet(dir)

    expect(snippet?.text.split("\n")).toHaveLength(100)
    expect(snippet?.file.endsWith("c.ts")).toBe(false)
    if (!snippet) throw new Error("expected snippet")
    const lines = (await readFile(snippet.file, "utf8")).split("\n")
    expect(
      lines.slice(snippet.startLine, snippet.startLine + 100).join("\n"),
    ).toBe(snippet.text)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("sampleHardSnippet returns undefined when source is insufficient", async () => {
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-empty-"))
  const shortDir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-short-"))
  try {
    await writeFile(
      path.join(shortDir, "short.ts"),
      Array.from({ length: 99 }, (_, i) => `const s${i} = ${i}`).join("\n"),
    )
    const mod = await loadAutoSessionModule()
    expect(await mod.sampleHardSnippet(emptyDir)).toBeUndefined()
    expect(await mod.sampleHardSnippet(shortDir)).toBeUndefined()
  } finally {
    await rm(emptyDir, { recursive: true, force: true })
    await rm(shortDir, { recursive: true, force: true })
  }
})

test("resample excludes the previous snippet and fails closed without alternatives", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-resample-"))
  try {
    await writeFile(
      path.join(dir, "only.ts"),
      Array.from({ length: 100 }, (_, i) => `export const o${i} = ${i}`).join(
        "\n",
      ),
    )
    const mod = await loadAutoSessionModule()
    const first = await mod.sampleHardSnippet(dir, () => 0)
    expect(first).toBeDefined()
    // 唯一候选被排除：无替代片段，明确返回 undefined（由调用方记未完成）
    expect(await mod.sampleHardSnippet(dir, () => 0, first)).toBeUndefined()

    // 存在替代片段时：恒定 rng 也保证拿到不同片段，不受随机性影响
    const wideDir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-wide-"))
    try {
      await writeFile(
        path.join(wideDir, "wide.ts"),
        Array.from({ length: 150 }, (_, i) => `export const w${i} = ${i}`).join(
          "\n",
        ),
      )
      const wide = await mod.sampleHardSnippet(wideDir, () => 0)
      const resampled = await mod.sampleHardSnippet(wideDir, () => 0, wide)
      expect(resampled).toBeDefined()
      expect(resampled?.text).not.toBe(wide?.text)
      expect(resampled?.startLine).not.toBe(wide?.startLine)
    } finally {
      await rm(wideDir, { recursive: true, force: true })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("sampleHardSnippet draws file and start independently from correct ranges", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-uniform-"))
  try {
    await writeFile(
      path.join(dir, "a.ts"),
      Array.from({ length: 150 }, (_, i) => `export const a${i} = ${i}`).join(
        "\n",
      ),
    )
    await writeFile(
      path.join(dir, "b.ts"),
      Array.from({ length: 100 }, (_, i) => `export const b${i} = ${i}`).join(
        "\n",
      ),
    )

    const seen: Array<number> = []
    const script = [0.1, 0.5]
    let i = 0
    const rng = (max: number) => {
      seen.push(max)
      return Math.floor(script[i++ % script.length] * max)
    }

    const mod = await loadAutoSessionModule()
    const first = await mod.sampleHardSnippet(dir, rng)
    if (!first) throw new Error("expected snippet")
    const windowsOf = (file: string) => (file.endsWith("a.ts") ? 51 : 1)
    // 先抽文件（2 选 1）再抽起点（该文件窗口数），两次抽取范围各自独立正确
    expect(seen).toEqual([2, windowsOf(first.file)])
    expect(first.startLine).toBe(Math.floor(0.5 * windowsOf(first.file)))
    expect(first.text.split("\n")).toHaveLength(100)

    seen.length = 0
    i = 0
    const script2 = [0.9, 0.9]
    const rng2 = (max: number) => {
      seen.push(max)
      return Math.floor(script2[i++ % script2.length] * max)
    }
    const second = await mod.sampleHardSnippet(dir, rng2)
    expect(second?.file).not.toBe(first.file)
    expect(seen).toEqual([2, windowsOf(second?.file ?? "")])
    expect(second?.startLine).toBe(
      Math.floor(0.9 * windowsOf(second?.file ?? "")),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("sampleHardSnippet ignores the trailing-newline pseudo-line", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-eol-"))
  try {
    // 99 行 + 末尾换行：split 后虽为 100 个元素，最后一行是伪行，不得视为合格
    await writeFile(
      path.join(dir, "c.ts"),
      `${Array.from({ length: 99 }, (_, i) => `const c${i} = ${i}`).join("\n")}\n`,
    )
    const mod = await loadAutoSessionModule()
    expect(await mod.sampleHardSnippet(dir, () => 0)).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("efficiency balance and fast send independently sampled source windows", async () => {
  const mod = await loadAutoSessionModule()
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-tier-source-"))
  const sourceLines = Array.from(
    { length: 1100 },
    (_, index) => `export const fixtureRow${index} = ${index}`,
  )
  const fixtureLines = new Set(sourceLines)
  const sampledTiers = ["efficiency", "balance", "fast"]
  const sourceWindows = new Map<string, Array<string>>()
  let randomStep = 0
  const random = spyOn(Math, "random").mockImplementation(() => {
    randomStep = (randomStep + 1) % 1000
    return randomStep / 1000
  })
  installRouter((body) => {
    if (sampledTiers.includes(body.tier) && body.prompt !== "hello") {
      sourceWindows.set(
        body.tier,
        body.prompt.split("\n").filter((line) => fixtureLines.has(line)),
      )
    }
    return okSelection(
      `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`,
    )
  })
  try {
    await writeFile(path.join(dir, "fixture.ts"), sourceLines.join("\n"))
    await mod.prewarmAutoSession({ sourceRoot: dir })
    expect([...sourceWindows.keys()].sort()).toEqual([...sampledTiers].sort())
    for (const tier of sampledTiers) {
      expect(sourceWindows.get(tier)).toHaveLength(100)
    }
    expect(
      new Set([...sourceWindows.values()].map((lines) => lines.join("\n")))
        .size,
    ).toBe(sampledTiers.length)
  } finally {
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    random.mockRestore()
    await rm(dir, { recursive: true, force: true })
  }
})

test("terminal probe failures log minimal diagnosable status without prompt, source, tier or token", async () => {
  const mod = await loadAutoSessionModule()
  const { calls } = installRouter((body) => {
    if (body.tier === "efficiency" && body.prompt === "hello") {
      // 400 类：请求格式问题，记为待处理且不重试
      return new Response(null, {
        status: 400,
        statusText: "EVIDENCE-MARKER",
      })
    }
    if (body.tier === "balance" && body.prompt === "hello") {
      return new Error("simulated non-network failure")
    }
    return okSelection(
      `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`,
    )
  })
  const warnSpy = spyOn(consola, "warn")
  const errorSpy = spyOn(consola, "error")

  try {
    await mod.prewarmAutoSession()

    const pendingLines = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("probe pending"))
    const failedLines = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("probe failed"))
    expect(pendingLines.some((line) => line.includes("http 400"))).toBe(true)
    expect(failedLines).toHaveLength(1)
    for (const line of [...pendingLines, ...failedLines]) {
      expect(line).not.toContain("hello")
      expect(line).not.toContain("export const")
      expect(line).not.toMatch(/token-/)
      for (const tier of TIERS) {
        expect(line).not.toContain(tier)
      }
    }
    // 上游侧日志只含整数状态码：statusText 是上游可控正文，不得回显
    const upstreamLines = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[auto] selection request failed"))
    expect(upstreamLines.length).toBe(1)
    for (const line of upstreamLines) {
      expect(line).toContain("HTTP 400")
      expect(line).not.toContain("EVIDENCE-MARKER")
    }
    // 400 点不重试：efficiency 简单题只请求一次
    const easyEfficiencyCalls = calls.filter(
      (call) =>
        requestBody(call).tier === "efficiency"
        && requestBody(call).prompt === "hello",
    ).length
    expect(easyEfficiencyCalls).toBe(1)
  } finally {
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
  }
})

test("insufficient source still reports acquired models and keeps requests usable", async () => {
  const mod = await loadAutoSessionModule()
  const infoSpy = spyOn(consola, "info")
  const { calls } = installRouter((body) =>
    okSelection(`only-${body.prompt === "hello" ? "easy" : "hard"}`),
  )
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-none-"))
  try {
    await mod.prewarmAutoSession({ sourceRoot: emptyDir })

    // 固定 intelligence 难题在没有磁盘源码时仍可取得配对。
    expect(calls).toHaveLength(5)
    expect(mod.isModelAutoCovered("only-easy")).toBe(true)
    expect(mod.isModelAutoCovered("only-hard")).toBe(true)
    const line = discoveryLogLine(infoSpy)
    expect(line).toContain('obtained=["only-easy","only-hard"]')
    // 请求路径仍可用（命中已注册配对）
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "only-easy",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("token-only-easy")
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "only-hard",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("token-only-hard")
  } finally {
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    await rm(emptyDir, { recursive: true, force: true })
  }
})

test("discovery reports model IDs without exposing prompts or tokens", async () => {
  const mod = await loadAutoSessionModule()
  const infoSpy = spyOn(consola, "info")
  installRouter(() => okSelection("shared-model", "secret-session-token"))

  await mod.prewarmAutoSession()
  expect(mod.isModelAutoCovered("shared-model")).toBe(true)

  const line = discoveryLogLine(infoSpy)
  expect(line).toContain('obtained=["shared-model"] missing=[]')
  expect(line).not.toContain("secret-session-token")
  expect(line).not.toContain("hello")
  for (const tier of TIERS) {
    expect(line).not.toContain(tier)
  }
})

// 轮询直至断言成立或超时。例外：后台补采完成没有对外信号（刻意不加测试专用接口），
// 且被测对象本身就是真实计时预算竞速，无法用假计时器确定性地驱动。
const waitFor = async (
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  const tick = (ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, ms)
    return promise
  }
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await tick(10)
  }
}

test("startup discovery wait has a hard budget; in-flight probes finish in background and become usable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-budget-"))
  // gate 提升出 try：finally 收尾放行 deferred fetch，避免测试悬挂
  const gate = Promise.withResolvers<void>()
  const mod = await loadAutoSessionModule()
  try {
    await writeFile(
      path.join(dir, "wide.ts"),
      Array.from({ length: 150 }, (_, i) => `export const w${i} = ${i}`).join(
        "\n",
      ),
    )
    // 全部 /auto 挂起：模拟上游长时间无响应（测试替身不使用 AbortSignal）
    installRouter(() => gate.promise.then(() => okSelection("gated-model")))

    const startedAt = Date.now()
    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })
    const elapsed = Date.now() - startedAt

    // 启动等待有确定上限：远小于单请求 15s 超时，服务可开始接收请求
    expect(elapsed).toBeLessThan(2_000)
    // 启动返回时普通请求路径不被在途探测阻断（未覆盖模型返回 undefined 而非挂起）
    expect(
      (await mod.getAutoSessionForModel({ model: "gated-model" }))
        ?.sessionToken,
    ).toBeUndefined()

    // 放行后在后台完成补采，配对立即命中可用
    gate.resolve()
    await waitFor(() => mod.isModelAutoCovered("gated-model"), 3_000)
    expect(
      (await mod.getAutoSessionForModel({ model: "gated-model" }))
        ?.sessionToken,
    ).toBe("token-gated-model")
  } finally {
    gate.resolve()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("successful probe points are usable at startup return while a stalled tier recovers in background", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-partial-"))
  const gate = Promise.withResolvers<void>()
  const mod = await loadAutoSessionModule()
  try {
    await writeFile(
      path.join(dir, "wide.ts"),
      Array.from({ length: 150 }, (_, i) => `export const p${i} = ${i}`).join(
        "\n",
      ),
    )
    const mod = await loadAutoSessionModule()
    installRouter((body) => {
      if (body.tier === "balance") {
        return gate.promise.then(() => okSelection("balance-model"))
      }
      return okSelection(`fast-${body.tier}`)
    })

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })

    // 成功点在启动返回时立即可用
    expect(mod.isModelAutoCovered("fast-efficiency")).toBe(true)
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "fast-efficiency",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("token-fast-efficiency")
    // 被挂起的档尚未覆盖，但不妨碍其他点与普通请求
    expect(mod.isModelAutoCovered("balance-model")).toBe(false)

    gate.resolve()
    await waitFor(() => mod.isModelAutoCovered("balance-model"), 3_000)
  } finally {
    gate.resolve()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

// 真实挂起等待的例外说明：被测行为本身是真实退避计时与凭据边界事件，
// 无对外完成信号（刻意不加测试专用接口），短等待仅用于断言"没有发生重试"
const settleMs = async (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  await promise
}

const writeWideSource = async (dir: string, name: string) => {
  await writeFile(
    path.join(dir, name),
    Array.from({ length: 150 }, (_, i) => `export const w${i} = ${i}`).join(
      "\n",
    ),
  )
}

test("429 probe honors Retry-After seconds then succeeds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-429s-"))
  const mod = await loadAutoSessionModule()
  try {
    await writeWideSource(dir, "wide.ts")
    let easyAttempts = 0
    installRouter((body) => {
      if (body.tier === "efficiency" && body.prompt === "hello") {
        easyAttempts += 1
        if (easyAttempts <= 2) {
          return new Response(null, {
            status: 429,
            headers: { "retry-after": "1" },
          })
        }
        return okSelection("easy-efficiency")
      }
      return okSelection(
        `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`,
      )
    })

    const startedAt = Date.now()
    await mod.prewarmAutoSession({ sourceRoot: dir })
    const elapsed = Date.now() - startedAt

    expect(easyAttempts).toBe(3)
    expect(elapsed).toBeGreaterThanOrEqual(1_800)
    expect(mod.isModelAutoCovered("easy-efficiency")).toBe(true)
  } finally {
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("429 probe honors Retry-After HTTP-date then succeeds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-429d-"))
  const mod = await loadAutoSessionModule()
  try {
    await writeWideSource(dir, "wide.ts")
    let easyAttempts = 0
    installRouter((body) => {
      if (body.tier === "efficiency" && body.prompt === "hello") {
        easyAttempts += 1
        if (easyAttempts === 1) {
          const retryAt = new Date(Date.now() + 2_200)
          return new Response(null, {
            status: 429,
            headers: { "retry-after": retryAt.toUTCString() },
          })
        }
        return okSelection("easy-efficiency")
      }
      return okSelection(
        `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`,
      )
    })

    const startedAt = Date.now()
    await mod.prewarmAutoSession({ sourceRoot: dir })
    const elapsed = Date.now() - startedAt

    expect(easyAttempts).toBe(2)
    expect(elapsed).toBeGreaterThanOrEqual(1_000)
    expect(mod.isModelAutoCovered("easy-efficiency")).toBe(true)
  } finally {
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("5xx probe retries with backoff from 1s and eventually succeeds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-5xx-"))
  const mod = await loadAutoSessionModule()
  try {
    await writeWideSource(dir, "wide.ts")
    let easyAttempts = 0
    installRouter((body) => {
      if (body.tier === "efficiency" && body.prompt === "hello") {
        easyAttempts += 1
        if (easyAttempts <= 2) return new Response(null, { status: 500 })
        return okSelection("easy-efficiency")
      }
      return okSelection(
        `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`,
      )
    })

    const startedAt = Date.now()
    await mod.prewarmAutoSession({ sourceRoot: dir })
    const elapsed = Date.now() - startedAt

    expect(easyAttempts).toBe(3)
    // 两次随机退避，每次抖动下限 1s（规格：从 1 秒起）
    expect(elapsed).toBeGreaterThanOrEqual(1_900)
    expect(mod.isModelAutoCovered("easy-efficiency")).toBe(true)
  } finally {
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("network failure probe retries with backoff and eventually succeeds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-net-"))
  const mod = await loadAutoSessionModule()
  const warnSpy = spyOn(consola, "warn")
  const debugSpy = spyOn(consola, "debug")
  const infoSpy = spyOn(consola, "info")
  try {
    await writeWideSource(dir, "wide.ts")
    let easyAttempts = 0
    installRouter((body) => {
      if (body.tier === "efficiency" && body.prompt === "hello") {
        easyAttempts += 1
        if (easyAttempts <= 2) return new TypeError("fetch failed")
        return okSelection("easy-efficiency")
      }
      return okSelection(
        `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`,
      )
    })

    const startedAt = Date.now()
    await mod.prewarmAutoSession({ sourceRoot: dir })
    const elapsed = Date.now() - startedAt

    expect(easyAttempts).toBe(3)
    // 单次退避抖动下限 1s
    expect(elapsed).toBeGreaterThanOrEqual(1_000)
    expect(mod.isModelAutoCovered("easy-efficiency")).toBe(true)

    // 重试日志只含固定类别，不含错误对象、prompt、tier 或 token
    const retryLines = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("probe retry"))
    expect(retryLines).toHaveLength(1)
    expect(retryLines[0]).toContain("source=auto")
    expect(retryLines[0]).toContain("network")
    expect(
      debugSpy.mock.calls.some(
        (call) =>
          String(call[0]).includes("probe retry")
          && String(call[0]).includes("source=auto"),
      ),
    ).toBe(true)
    expect(
      infoSpy.mock.calls.filter(
        (call) =>
          String(call[0]).includes("probe recovered")
          && String(call[0]).includes("source=auto"),
      ),
    ).toHaveLength(1)
  } finally {
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("401 halts all probes for the same credential; only a real credential change resumes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-401-"))
  const mod = await loadAutoSessionModule()
  state.copilotToken = "halted-token"
  try {
    await writeWideSource(dir, "wide.ts")
    const { calls } = installRouter((body) => {
      if (state.copilotToken === "halted-token") {
        return new Response(null, { status: 401 })
      }
      return okSelection(`resumed-${body.tier}`)
    })
    const autoCalls = () =>
      calls.filter((call) => call.url.includes("/auto")).length

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })

    // 八个点各试一次后全部暂停：挂起期间无重试请求
    await settleMs(400)
    expect(autoCalls()).toBe(8)
    // 单纯清空缓存（同凭据）不算凭据变化，探测不得恢复
    mod.invalidateAutoSession()
    await settleMs(300)
    expect(autoCalls()).toBe(8)

    // 真实凭据变化 + 缓存失效边界：探测恢复并成功登记
    state.copilotToken = "rotated-token"
    mod.invalidateAutoSession()
    await nextTurn()
    expect(autoCalls()).toBe(8)
    mod.resumeAutoSessionDiscoveryAfterRotation()
    await waitFor(
      () => autoCalls() > 8 && mod.isModelAutoCovered("resumed-efficiency"),
      3_000,
    )
  } finally {
    state.copilotToken = "discovery-auth-token"
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("eight probe points run independently: hard point does not wait for its easy point", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-8pt-"))
  const mod = await loadAutoSessionModule()
  const gate = Promise.withResolvers<void>()
  try {
    await writeWideSource(dir, "wide.ts")
    installRouter((body) => {
      if (body.prompt === "hello") {
        return gate.promise.then(() => okSelection("easy-model"))
      }
      return okSelection(`hard-${body.tier}`)
    })

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })

    // 简单题全部挂起时，难题点已完成并登记
    expect(mod.isModelAutoCovered("hard-efficiency")).toBe(true)
    expect(mod.isModelAutoCovered("easy-model")).toBe(false)

    gate.resolve()
    await waitFor(() => mod.isModelAutoCovered("easy-model"), 3_000)
  } finally {
    gate.resolve()
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("budget expiry logs a snapshot while probes still run; final log follows completion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-log-"))
  const mod = await loadAutoSessionModule()
  const gate = Promise.withResolvers<void>()
  const infoSpy = spyOn(consola, "info")
  const infoLines = () => infoSpy.mock.calls.map((call) => String(call[0]))
  try {
    await writeWideSource(dir, "wide.ts")
    installRouter(() => gate.promise.then(() => okSelection("gated-model")))

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })

    // 预算到期是快照而非最终态：后台仍在运行
    const snapshot = infoLines().find((line) =>
      line.includes("discovery snapshot"),
    )
    expect(snapshot).toContain("obtained=[] missing=[]")
    expect(snapshot).toContain("fusion_obtained=[]")
    expect(snapshot).toContain("auto_obtained=[]")
    expect(snapshot).toContain("fusion_missing=[]")
    expect(snapshot).toContain("auto_missing=[]")
    expect(
      infoLines().some((line) =>
        line.startsWith("[auto-session] discovery result "),
      ),
    ).toBe(false)

    gate.resolve()
    await waitFor(
      () =>
        infoLines().some((line) =>
          line.startsWith("[auto-session] discovery result "),
        ),
      3_000,
    )
    const result = discoveryLogLine(infoSpy)
    expect(result).toContain('obtained=["gated-model"] missing=[]')
    expect(result).toContain("fusion_obtained=[]")
    expect(result).toContain('auto_obtained=["gated-model"]')
    expect(result).toContain("fusion_missing=[]")
    expect(result).toContain("auto_missing=[]")
  } finally {
    gate.resolve()
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("easy probe registers while source sampling is still pending", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-slowscan-"))
  const mod = await loadAutoSessionModule()
  const sampleGate = Promise.withResolvers<void>()
  const OriginalGlob = Bun.Glob
  // 平台接缝替身：采样扫描挂起期间，简单题不得被阻断
  const GatedGlob = class extends OriginalGlob {
    override async *scan(
      ...args: Parameters<InstanceType<typeof OriginalGlob>["scan"]>
    ) {
      await sampleGate.promise
      yield* super.scan(...args)
    }
  }
  ;(Bun as unknown as { Glob: typeof Bun.Glob }).Glob = GatedGlob
  try {
    await writeWideSource(dir, "wide.ts")
    installRouter((body) =>
      okSelection(`${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`),
    )

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })

    // 采样仍挂起时简单题已完成并登记
    expect(mod.isModelAutoCovered("easy-efficiency")).toBe(true)
    sampleGate.resolve()
    await waitFor(() => mod.isModelAutoCovered("hard-efficiency"), 3_000)
  } finally {
    sampleGate.resolve()
    ;(Bun as unknown as { Glob: typeof Bun.Glob }).Glob = OriginalGlob
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("stop cancels a long Retry-After sleep and joins without waiting it out", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-longra-"))
  const mod = await loadAutoSessionModule()
  try {
    await writeWideSource(dir, "wide.ts")
    let easyAttempts = 0
    const { calls } = installRouter((body) => {
      if (body.tier === "efficiency" && body.prompt === "hello") {
        easyAttempts += 1
        if (easyAttempts === 1) {
          return new Response(null, {
            status: 429,
            headers: { "retry-after": "30" },
          })
        }
        return okSelection("easy-efficiency")
      }
      return okSelection(
        `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`,
      )
    })
    const easyCalls = () =>
      calls.filter(
        (call) =>
          requestBody(call).tier === "efficiency"
          && requestBody(call).prompt === "hello",
      ).length

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })
    mod.stopProbeScheduler()
    const joinStart = Date.now()
    await mod.whenProbeSchedulerIdle()
    expect(Date.now() - joinStart).toBeLessThan(2_000)
    // 停止后不再发起新请求
    expect(easyCalls()).toBe(1)
  } finally {
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("backoff starts at 1s, doubles, and is capped at 30s", async () => {
  const mod = await loadAutoSessionModule()
  for (let i = 0; i < 50; i += 1) {
    const first = mod.nextBackoffMs(0)
    expect(first).toBeGreaterThanOrEqual(1_000)
    expect(first).toBeLessThan(1_600)
    const second = mod.nextBackoffMs(1)
    expect(second).toBeGreaterThanOrEqual(2_000)
    const capped = mod.nextBackoffMs(20)
    expect(capped).toBe(30_000)
  }
})

test("budget snapshot reports no acquired models before responses arrive", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-snap8-"))
  const mod = await loadAutoSessionModule()
  const gate = Promise.withResolvers<void>()
  const infoSpy = spyOn(consola, "info")
  getConfig().autoDiscovery = { models: ["gated-model", "missing-model"] }
  try {
    await writeWideSource(dir, "wide.ts")
    installRouter(() => gate.promise.then(() => okSelection("gated-model")))

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })

    const snapshot = infoSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("discovery snapshot"))
    expect(snapshot).toContain(
      'obtained=[] missing=["gated-model","missing-model"]',
    )
    mod.stopProbeScheduler()
    gate.resolve()
    await mod.whenProbeSchedulerIdle()
    expect(discoveryLogLine(infoSpy)).toContain('obtained=["gated-model"]')
    const targetResult = infoSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("target discovery stopped"))
    expect(targetResult).toContain('missing=["missing-model"]')
  } finally {
    gate.resolve()
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("401 arriving after a credential rotation is attributed to the requesting credential", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-midflight-"))
  const mod = await loadAutoSessionModule()
  const gate = Promise.withResolvers<void>()
  let rotated = false
  state.copilotToken = "old-token"
  try {
    await writeWideSource(dir, "wide.ts")
    installRouter((_body, init) => {
      // 轮换前发出的在途请求必须携带旧凭据，上游据此拒认（401）；
      // 轮换后重试的请求必须携带新凭据，上游接受（200）
      const authorization = new Headers(init?.headers).get("authorization")
      if (!rotated) {
        expect(authorization).toBe("Bearer old-token")
        return gate.promise.then(() => new Response(null, { status: 401 }))
      }
      expect(authorization).toBe("Bearer new-token")
      return okSelection("resumed-model")
    })
    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })

    // 响应在途时凭据已轮换：401 属于发起请求的 old-token，
    // 不得把已更新的 new-token 也暂停
    state.copilotToken = "new-token"
    mod.invalidateAutoSession()
    rotated = true
    gate.resolve()
    await nextTurn()
    expect(mod.isModelAutoCovered("resumed-model")).toBe(false)
    mod.resumeAutoSessionDiscoveryAfterRotation()
    await waitFor(() => mod.isModelAutoCovered("resumed-model"), 3_000)
  } finally {
    state.copilotToken = "discovery-auth-token"
    gate.resolve()
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("same-credential invalidate does not interrupt an in-progress backoff", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-nopoke-"))
  const mod = await loadAutoSessionModule()
  try {
    await writeWideSource(dir, "wide.ts")
    let easyAttempts = 0
    const { calls } = installRouter((body) => {
      if (body.tier === "efficiency" && body.prompt === "hello") {
        easyAttempts += 1
        if (easyAttempts === 1) return new Response(null, { status: 500 })
        return okSelection("easy-efficiency")
      }
      return okSelection(
        `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`,
      )
    })
    const easyCalls = () =>
      calls.filter(
        (call) =>
          requestBody(call).tier === "efficiency"
          && requestBody(call).prompt === "hello",
      ).length

    const prewarmPromise = mod.prewarmAutoSession({ sourceRoot: dir })
    await waitFor(() => easyCalls() === 1, 3_000)
    // 同凭据的缓存清空：不得提前唤醒正在遵守退避的探测
    mod.invalidateAutoSession()
    await settleMs(400)
    expect(easyCalls()).toBe(1)
    await prewarmPromise
    expect(easyCalls()).toBe(2)
    expect(mod.isModelAutoCovered("easy-efficiency")).toBe(true)
  } finally {
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("401 without any credential parks all points instead of hammering /auto", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-nocred-"))
  const mod = await loadAutoSessionModule()
  state.copilotToken = undefined
  try {
    await writeWideSource(dir, "wide.ts")
    const { calls } = installRouter(() => {
      if (state.copilotToken === undefined) {
        return new Response(null, { status: 401 })
      }
      return okSelection("credentialed-model")
    })
    const autoCalls = () =>
      calls.filter((call) => call.url.includes("/auto")).length

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })
    await settleMs(400)
    // 无凭据 401：八点各试一次后暂停，不得无限高速重试
    expect(autoCalls()).toBe(8)

    state.copilotToken = "fresh-token"
    mod.invalidateAutoSession()
    await nextTurn()
    expect(autoCalls()).toBe(8)
    mod.resumeAutoSessionDiscoveryAfterRotation()
    await waitFor(() => mod.isModelAutoCovered("credentialed-model"), 3_000)
  } finally {
    state.copilotToken = "discovery-auth-token"
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("429 with empty or missing Retry-After falls back to backoff", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-rafb-"))
  const mod = await loadAutoSessionModule()
  try {
    await writeWideSource(dir, "wide.ts")
    let easyAttempts = 0
    installRouter((body) => {
      if (body.tier === "efficiency" && body.prompt === "hello") {
        easyAttempts += 1
        if (easyAttempts === 1) {
          // 空头：Number('') 会变 0，必须按非法头回退到随机退避
          return new Response(null, {
            status: 429,
            headers: { "retry-after": "" },
          })
        }
        if (easyAttempts === 2) {
          // 缺头：同样回退退避
          return new Response(null, { status: 429 })
        }
        return okSelection("easy-efficiency")
      }
      return okSelection(
        `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`,
      )
    })

    const startedAt = Date.now()
    await mod.prewarmAutoSession({ sourceRoot: dir })
    const elapsed = Date.now() - startedAt

    expect(easyAttempts).toBe(3)
    // 两次回退退避，每次抖动下限 1s
    expect(elapsed).toBeGreaterThanOrEqual(1_900)
    expect(mod.isModelAutoCovered("easy-efficiency")).toBe(true)
  } finally {
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("stale in-flight /auto success from an old credential is not registered; point re-probes under the new credential", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-stale-"))
  const mod = await loadAutoSessionModule()
  const gate = Promise.withResolvers<void>()
  let rotated = false
  state.copilotToken = "old-token"
  try {
    await writeWideSource(dir, "wide.ts")
    const { calls } = installRouter((_body, init) => {
      // 真实鉴权头分派：旧凭据请求挂起到放行，新凭据请求立即应答
      const authorization = new Headers(init?.headers).get("authorization")
      if (!rotated) {
        expect(authorization).toBe("Bearer old-token")
        return gate.promise.then(() => okSelection("old-model", "token-old"))
      }
      expect(authorization).toBe("Bearer new-token")
      // 按探测点区分模型：避免同档两题同模型触发重采路径干扰计数
      const point = `${_body.prompt === "hello" ? "easy" : "hard"}-${_body.tier}`
      return okSelection(`new-${point}`, `token-new-${point}`)
    })

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })

    // 八点旧凭据请求均在途时完成轮换
    state.copilotToken = "new-token"
    mod.invalidateAutoSession()
    rotated = true
    gate.resolve()
    await nextTurn()
    expect(calls).toHaveLength(8)
    expect(mod.isModelAutoCovered("old-model")).toBe(false)
    mod.resumeAutoSessionDiscoveryAfterRotation()

    // 新凭据下补采成功并登记
    await waitFor(() => mod.isModelAutoCovered("new-easy-efficiency"), 3_000)
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "new-easy-efficiency",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("token-new-easy-efficiency")
    // 旧凭据的响应不得进入新凭据配对：旧模型必须脱靶
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "old-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBeUndefined()
    // 每点单飞：八点旧请求各结算一次后，每点恰好再发一次新凭据请求
    expect(calls.filter((call) => call.url.includes("/auto"))).toHaveLength(16)
  } finally {
    state.copilotToken = "discovery-auth-token"
    gate.resolve()
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("429 Retry-After overflow: legal huge wait parks all eight points without hot-looping", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-raov-"))
  const mod = await loadAutoSessionModule()
  try {
    await writeWideSource(dir, "wide.ts")
    // 2147484 秒 → 2,147,484,000ms（>2^31-1）：合法大等待，必须分块睡眠而非立即返回
    const { calls } = installRouter(
      () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "2147484" },
        }),
    )

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })
    // 首试后 200ms 观察窗：8 个点全部停在退避里，零新增请求
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(calls.length).toBe(8)
    // stop+idle 必须及时结束（唤醒分块睡眠），不得等 24 天
    mod.stopProbeScheduler()
    const joinStart = Date.now()
    await mod.whenProbeSchedulerIdle()
    expect(Date.now() - joinStart).toBeLessThan(2_000)
    expect(calls.length).toBe(8)
  } finally {
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("429 Retry-After overflow: non-finite seconds falls back to >=1s backoff", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-rainf-"))
  const mod = await loadAutoSessionModule()
  try {
    await writeWideSource(dir, "wide.ts")
    // 1e308 秒相乘得 Infinity：视为非法头，回退随机退避（>=1s）
    const { calls } = installRouter(
      () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "1e308" },
        }),
    )

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })
    const firstBatchAt = Date.now()
    const start = Date.now()
    while (calls.length < 9 && Date.now() - start < 3_000) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(calls.length).toBeGreaterThanOrEqual(9)
    // 回退退避下限 1s：第二批请求不得提前。
    // 阈值取 900ms：1s 下限留调度抖动余量，与热循环（<100ms，见红跑）明确分离
    expect(Date.now() - firstBatchAt).toBeGreaterThanOrEqual(900)
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
  } finally {
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("429 Retry-After overflow: unsafe-integer ms falls back to >=1s backoff", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-raunsafe-"))
  const mod = await loadAutoSessionModule()
  try {
    await writeWideSource(dir, "wide.ts")
    // 1e16 秒相乘得 1e19ms（超 MAX_SAFE_INTEGER）：视为非法头，回退随机退避（>=1s）
    const { calls } = installRouter(
      () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "1e16" },
        }),
    )

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })
    const firstBatchAt = Date.now()
    const start = Date.now()
    while (calls.length < 9 && Date.now() - start < 3_000) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(calls.length).toBeGreaterThanOrEqual(9)
    expect(Date.now() - firstBatchAt).toBeGreaterThanOrEqual(900)
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
  } finally {
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("invalidate plus resume after real credential rotation re-probes quiet successful points in background", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-rotinv-"))
  const mod = await loadAutoSessionModule()
  state.copilotToken = "old-token"
  try {
    await writeWideSource(dir, "wide.ts")
    const newTokenAuths: Array<string> = []
    const { calls } = installRouter((body, init) => {
      const auth = new Headers(init?.headers).get("authorization")
      if (auth === "Bearer new-token") newTokenAuths.push(auth)
      return okSelection(
        `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`,
      )
    })
    await mod.prewarmAutoSession({ sourceRoot: dir })
    expect(calls).toHaveLength(8)
    expect(mod.isModelAutoCovered("easy-efficiency")).toBe(true)

    state.copilotToken = "new-token"
    // 旧凭据配对即使尚未调用 invalidate 也不得报覆盖
    expect(mod.isModelAutoCovered("easy-efficiency")).toBe(false)
    expect(
      (await mod.getAutoSessionForModel({ model: "easy-efficiency" }))
        ?.sessionToken,
    ).toBeUndefined()

    // 单纯 invalidate（测试清理同路径）绝不自行发请求
    mod.invalidateAutoSession()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(calls).toHaveLength(8)
    await mod.whenProbeSchedulerIdle()
    expect(calls).toHaveLength(8)

    // 真实身份变化入口：invalidate + 显式 resume 才后台补采
    mod.resumeAutoSessionDiscoveryAfterRotation()
    await mod.whenProbeSchedulerIdle()
    // 8 个安静成功点全部按新凭据后台补采，且只携带新凭据
    expect(calls).toHaveLength(16)
    expect(newTokenAuths).toHaveLength(8)
    expect(
      (await mod.getAutoSessionForModel({ model: "easy-efficiency" }))
        ?.sessionToken,
    ).toBe("token-easy-efficiency")
    expect(mod.isModelAutoCovered("easy-efficiency")).toBe(true)

    // 幂等：同凭据再次 invalidate+resume（如 Auto token 失效刷新）不得重复补采
    mod.invalidateAutoSession()
    mod.resumeAutoSessionDiscoveryAfterRotation()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(calls).toHaveLength(16)
    await mod.whenProbeSchedulerIdle()
    expect(calls).toHaveLength(16)
  } finally {
    state.copilotToken = "discovery-auth-token"
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("invalidate re-probes nothing without prior discovery or with the same credential", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-nopre-"))
  const mod = await loadAutoSessionModule()
  try {
    await writeWideSource(dir, "wide.ts")
    const { calls } = installRouter((body) =>
      okSelection(`${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`),
    )
    // 初次 setup 前 invalidate：零请求
    mod.invalidateAutoSession()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(calls).toHaveLength(0)
    // discovery 完成后同凭据 invalidate：零补采
    state.copilotToken = "same-token"
    await mod.prewarmAutoSession({ sourceRoot: dir })
    expect(calls).toHaveLength(8)
    mod.invalidateAutoSession()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(calls).toHaveLength(8)
  } finally {
    state.copilotToken = "discovery-auth-token"
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("credential rotation with halted 401 points re-probes at most one in-flight per point", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-haltrot-"))
  const mod = await loadAutoSessionModule()
  state.copilotToken = "old-token"
  try {
    await writeWideSource(dir, "wide.ts")
    const perPointNew = new Map<string, number>()
    const { calls } = installRouter((body, init) => {
      const auth = new Headers(init?.headers).get("authorization")
      if (auth !== "Bearer new-token")
        return new Response(null, { status: 401 })
      const point = `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`
      perPointNew.set(point, (perPointNew.get(point) ?? 0) + 1)
      return okSelection(`resumed-${point}`)
    })
    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })

    state.copilotToken = "new-token"
    mod.invalidateAutoSession()
    mod.resumeAutoSessionDiscoveryAfterRotation()
    await mod.whenProbeSchedulerIdle()
    // 挂起点的自我重试与 invalidate 补采经 runProbePoint 单飞合并
    for (const tier of TIERS) {
      expect(perPointNew.get(`easy-${tier}`)).toBe(1)
      expect(perPointNew.get(`hard-${tier}`)).toBe(1)
    }
    expect(
      calls.filter(
        (call) =>
          new Headers(call.init?.headers).get("authorization")
          === "Bearer new-token",
      ),
    ).toHaveLength(8)
  } finally {
    state.copilotToken = "discovery-auth-token"
    mod.stopProbeScheduler?.()
    await mod.whenProbeSchedulerIdle?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test("configured cold misses share discovery and accept only the selected target", async () => {
  const mod = await loadAutoSessionModule()
  const config = getConfig()
  const previous = config.autoDiscovery
  const gate = Promise.withResolvers<AutoSelectionResponse>()
  config.autoDiscovery = { models: ["target-model"] }
  installDiscountCatalog(
    "target-model",
    "fusion-only-model",
    "existing-auto-model",
  )
  mod.registerAutoSelection(
    okSelection("existing-auto-model", "existing-auto-token"),
    createProbeCondition({ source: "auto", tier: "balance", prompt: "hello" }),
  )
  const { calls } = installRouter(() => gate.promise)
  const infoSpy = spyOn(consola, "info")
  try {
    mod.resumeAutoSessionDiscoveryAfterRotation()
    const pending = Array.from({ length: 20 }, () =>
      mod.getAutoSessionForModel({
        model: "target-model",
        endpoint: "/responses",
      }),
    )
    await waitFor(() => calls.length === 1, 1_000)
    expect(
      mod.registerFusionSelection(
        {
          planVersion: "2" as const,
          fusionPattern: "solo",
          steps: [{ modelId: "fusion-only-model" }],
          sessionToken: "FUSION_ONLY_PRIVATE",
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
    expect(
      (await mod.getAutoSessionForModel({ model: "unconfigured-model" }))
        ?.sessionToken,
    ).toBeUndefined()
    gate.resolve(okSelection("target-model", "target-session"))
    expect(
      (await Promise.all(pending)).map((item) => item?.sessionToken),
    ).toEqual(Array.from({ length: 20 }, () => "target-session"))
    expect(calls).toHaveLength(1)
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "target-model",
          endpoint: "/v1/messages",
        })
      )?.sessionToken,
    ).toBeUndefined()
    expect(calls).toHaveLength(1)
    await mod.whenProbeSchedulerIdle()
    const lines = infoSpy.mock.calls.map((call) => String(call[0]))
    const starts = lines.filter(
      (line) =>
        line.includes("target discovery start") && line.includes("source=auto"),
    )
    expect(starts).toEqual([
      '[auto-session] target discovery start source=auto reason=miss missing=["target-model"]',
    ])
    const results = lines.filter(
      (line) =>
        line.includes("target discovery result")
        && line.includes("source=auto"),
    )
    expect(results).toEqual([
      '[auto-session] target discovery result source=auto added=["target-model"] missing=[]',
    ])
    expect(lines.join("\n")).not.toContain("FUSION_ONLY_PRIVATE")
  } finally {
    mod.stopProbeScheduler()
    gate.resolve(okSelection("target-model"))
    await mod.whenProbeSchedulerIdle()
    config.autoDiscovery = previous
  }
})

test("configured miss timeout leaves shared discovery running for later requests", async () => {
  const mod = await loadAutoSessionModule()
  const config = getConfig()
  const previous = config.autoDiscovery
  const gate = Promise.withResolvers<AutoSelectionResponse>()
  config.autoDiscovery = { models: ["target-model"] }
  const { calls } = installRouter(() => gate.promise)
  try {
    mod.resumeAutoSessionDiscoveryAfterRotation()
    const started = Date.now()
    expect(
      (await mod.getAutoSessionForModel({ model: "target-model" }))
        ?.sessionToken,
    ).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
    expect(Date.now() - started).toBeLessThan(2_800)
    expect(calls).toHaveLength(1)
    gate.resolve(okSelection("target-model", "late-session"))
    await waitFor(() => mod.isModelAutoCovered("target-model"), 1_000)
    expect(
      (await mod.getAutoSessionForModel({ model: "target-model" }))
        ?.sessionToken,
    ).toBe("late-session")
    expect(calls).toHaveLength(1)
  } finally {
    mod.stopProbeScheduler()
    gate.resolve(okSelection("target-model"))
    await mod.whenProbeSchedulerIdle()
    config.autoDiscovery = previous
  }
})

test("rotation ends old miss wait and rejects late old-credential selection", async () => {
  const mod = await loadAutoSessionModule()
  const config = getConfig()
  const previous = config.autoDiscovery
  const gate = Promise.withResolvers<AutoSelectionResponse>()
  config.autoDiscovery = { models: ["target-model"] }
  const originalAuthorization = `Bearer ${state.copilotToken}`
  const { calls } = installRouter((_body, init) => {
    const auth = new Headers(init?.headers).get("authorization")
    return auth === originalAuthorization ?
        gate.promise
      : okSelection("target-model", "new-session")
  })
  try {
    mod.resumeAutoSessionDiscoveryAfterRotation()
    const pending = mod.getAutoSessionForModel({ model: "target-model" })
    await waitFor(() => calls.length === 1, 1_000)
    state.copilotToken = "rotated-token"
    mod.invalidateAutoSession()
    expect((await pending)?.sessionToken).toBeUndefined()
    expect(
      (await mod.getAutoSessionForModel({ model: "target-model" }))
        ?.sessionToken,
    ).toBeUndefined()
    mod.resumeAutoSessionDiscoveryAfterRotation()
    gate.resolve(okSelection("target-model", "old-session"))
    await waitFor(() => mod.isModelAutoCovered("target-model"), 4_500)
    expect(
      (await mod.getAutoSessionForModel({ model: "target-model" }))
        ?.sessionToken,
    ).toBe("new-session")
  } finally {
    mod.stopProbeScheduler()
    gate.resolve(okSelection("target-model"))
    await mod.whenProbeSchedulerIdle()
    config.autoDiscovery = previous
  }
})

test("stop settles concurrent miss waiters before the upstream request finishes", async () => {
  const mod = await loadAutoSessionModule()
  const config = getConfig()
  const previous = config.autoDiscovery
  const gate = Promise.withResolvers<AutoSelectionResponse>()
  config.autoDiscovery = { models: ["target-model"] }
  const { calls } = installRouter(() => gate.promise)
  try {
    mod.resumeAutoSessionDiscoveryAfterRotation()
    const pending = Array.from({ length: 20 }, () =>
      mod.getAutoSessionForModel({ model: "target-model" }),
    )
    await waitFor(() => calls.length === 1, 1_000)
    mod.stopProbeScheduler()
    mod.stopProbeScheduler()
    expect(
      (await Promise.all(pending)).map((item) => item?.sessionToken),
    ).toEqual(Array.from({ length: 20 }, () => undefined))
    expect(
      (await mod.getAutoSessionForModel({ model: "target-model" }))
        ?.sessionToken,
    ).toBeUndefined()
    expect(calls).toHaveLength(1)
  } finally {
    mod.stopProbeScheduler()
    gate.resolve(okSelection("target-model"))
    await mod.whenProbeSchedulerIdle()
    config.autoDiscovery = previous
  }
})

test("wrong-model selection never supplies the configured target token", async () => {
  const mod = await loadAutoSessionModule()
  const config = getConfig()
  const previous = config.autoDiscovery
  config.autoDiscovery = { models: ["target-model"] }
  installRouter(() => okSelection("other-model", "other-session"))
  try {
    mod.resumeAutoSessionDiscoveryAfterRotation()
    expect(
      (await mod.getAutoSessionForModel({ model: "target-model" }))
        ?.sessionToken,
    ).toBeUndefined()
    expect(mod.isModelAutoCovered("target-model")).toBe(false)
    expect(
      (await mod.getAutoSessionForModel({ model: "other-model" }))
        ?.sessionToken,
    ).toBe("other-session")
  } finally {
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    config.autoDiscovery = previous
  }
})

test("expired configured pairing is replaced before the requesting caller receives a token", async () => {
  const mod = await loadAutoSessionModule()
  const config = getConfig()
  const previous = config.autoDiscovery
  const realNow = Date.now
  let clockOffset = 0
  let requests = 0
  const renewal = Promise.withResolvers<AutoSelectionResponse>()
  config.autoDiscovery = { models: ["target-model"] }
  Date.now = () => realNow() + clockOffset
  const { calls } = installRouter(() => {
    requests++
    return requests === 1 ?
        okSelection("target-model", "session-1")
      : renewal.promise
  })
  try {
    mod.resumeAutoSessionDiscoveryAfterRotation()
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "target-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("session-1")
    await mod.whenProbeSchedulerIdle()
    clockOffset = 3_700_000
    const pending = Array.from({ length: 20 }, () =>
      mod.getAutoSessionForModel({
        model: "target-model",
        endpoint: "/responses",
      }),
    )
    await nextTurn()
    expect(requests).toBe(2)
    expect(calls[1].url).toBe(calls[0].url)
    expect(requestBody(calls[1])).toEqual(requestBody(calls[0]))
    renewal.resolve(okSelection("target-model", "session-2"))
    expect(
      (await Promise.all(pending)).map((selection) => selection?.sessionToken),
    ).toEqual(Array.from({ length: 20 }, () => "session-2"))
    await mod.whenProbeSchedulerIdle()
    expect(requests).toBe(2)
  } finally {
    Date.now = realNow
    mod.stopProbeScheduler()
    renewal.resolve(okSelection("target-model", "session-2"))
    await mod.whenProbeSchedulerIdle()
    config.autoDiscovery = previous
  }
})

test("cold miss rejects an acquired token unsupported by the requested endpoint", async () => {
  const mod = await loadAutoSessionModule()
  const config = getConfig()
  const previous = config.autoDiscovery
  config.autoDiscovery = { models: ["target-model"] }
  const { calls } = installRouter(() =>
    okSelection("target-model", "response-session"),
  )
  try {
    mod.resumeAutoSessionDiscoveryAfterRotation()
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "target-model",
          endpoint: "/v1/messages",
        })
      )?.sessionToken,
    ).toBeUndefined()
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "target-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("response-session")
    expect(calls).toHaveLength(1)
  } finally {
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    config.autoDiscovery = previous
  }
})

test("cold miss waits for metadata readiness before issuing an authenticated probe", async () => {
  const mod = await loadAutoSessionModule()
  const config = getConfig()
  const previous = config.autoDiscovery
  config.autoDiscovery = { models: ["target-model"] }
  const { calls } = installRouter(() =>
    okSelection("target-model", "ready-session"),
  )
  try {
    expect(
      (await mod.getAutoSessionForModel({ model: "target-model" }))
        ?.sessionToken,
    ).toBeUndefined()
    expect(calls).toHaveLength(0)
    mod.resumeAutoSessionDiscoveryAfterRotation()
    expect(calls).toHaveLength(0)
    expect(
      (await mod.getAutoSessionForModel({ model: "target-model" }))
        ?.sessionToken,
    ).toBe("ready-session")
    expect(calls).toHaveLength(1)
  } finally {
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    config.autoDiscovery = previous
  }
})

test("exhausted target discovery resumes on a miss after 90 seconds", async () => {
  const mod = await loadAutoSessionModule()
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-cooldown-"))
  let now = Date.now()
  let advancing = true
  const clock = spyOn(Date, "now").mockImplementation(() => {
    if (advancing) now += 4_000
    return now
  })
  // Freeze at source exhaustion, before later history/idle reads advance the test clock.
  const info = consola.info
  spyOn(consola, "info").mockImplementation(
    Object.assign(
      (...args: Parameters<typeof info>) => {
        if (
          String(args[0]).startsWith(
            "[auto-session] target discovery exhausted source=auto ",
          )
        )
          advancing = false
        return info(...args)
      },
      { raw: info.raw },
    ),
  )
  getConfig().autoDiscovery = { models: ["target-model"] }
  let available = false
  const { calls } = installRouter(() =>
    available ?
      okSelection("target-model")
    : new Response(null, { status: 400 }),
  )
  try {
    await mod.prewarmAutoSession({ sourceRoot: dir })
    await mod.whenProbeSchedulerIdle()
    expect(advancing).toBe(false)
    const exhaustedAt = now
    const exhaustedCalls = calls.length
    now = exhaustedAt + 89_999
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "target-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBeUndefined()
    expect(calls).toHaveLength(exhaustedCalls)
    now = exhaustedAt + 90_000
    available = true
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "target-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("token-target-model")
    await mod.whenProbeSchedulerIdle()
    expect(calls).toHaveLength(exhaustedCalls + 1)
  } finally {
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    clock.mockRestore()
    await rm(dir, { recursive: true, force: true })
  }
})

test("intelligence changes its hard question when distinct startup models still miss a target", async () => {
  const mod = await loadAutoSessionModule()
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "auto-intelligence-variant-"),
  )
  getConfig().autoDiscovery = { models: ["wanted-model"] }
  const hardPrompts: Array<string> = []
  installRouter((body) => {
    if (body.tier !== "intelligence" || body.prompt === "hello") {
      return okSelection(`other-${body.tier}`)
    }
    hardPrompts.push(body.prompt)
    return new Set(hardPrompts).size > 1 ?
        okSelection("wanted-model", "wanted-session")
      : okSelection("first-hard-model")
  })
  try {
    await mod.prewarmAutoSession({ sourceRoot: dir })
    await mod.whenProbeSchedulerIdle()
    expect(hardPrompts).toHaveLength(2)
    expect(hardPrompts[1]).not.toBe(hardPrompts[0])
    expect(
      (await mod.getAutoSessionForModel({ model: "wanted-model" }))
        ?.sessionToken,
    ).toBe("wanted-session")
    expect(mod.isModelAutoCovered("first-hard-model")).toBe(true)
  } finally {
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    await rm(dir, { recursive: true, force: true })
  }
})

test("shared target discovery starts with intelligence and changes its question after a miss", async () => {
  const mod = await loadAutoSessionModule()
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => (now += 4_000))
  getConfig().autoDiscovery = { models: ["wanted-model"] }
  const intelligencePrompts = new Set<string>()
  const { calls } = installRouter((body) => {
    if (body.tier === "intelligence") intelligencePrompts.add(body.prompt)
    return intelligencePrompts.size > 1 ?
        okSelection("wanted-model", "wanted-session")
      : okSelection("other-model", "other-session")
  })
  try {
    mod.resumeAutoSessionDiscoveryAfterRotation()
    await mod.getAutoSessionForModel({ model: "wanted-model" })
    await mod.whenProbeSchedulerIdle()
    expect(requestBody(calls[0]).tier).toBe("intelligence")
    expect(intelligencePrompts.size).toBe(2)
    expect(
      (await mod.getAutoSessionForModel({ model: "wanted-model" }))
        ?.sessionToken,
    ).toBe("wanted-session")
    expect(
      (await mod.getAutoSessionForModel({ model: "other-model" }))
        ?.sessionToken,
    ).toBe("other-session")
  } finally {
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    clock.mockRestore()
  }
})

const installDiscountCatalog = (...ids: Array<string>): void => {
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
      supported_endpoints: ["/responses"],
    })),
  }
}

const fusionSelectionResponse = (model: string, token: string): Response =>
  new Response(
    JSON.stringify({
      fusion_pattern: "solo",
      steps: [{ model_id: model }],
      session: { token, expires_at: Math.floor(Date.now() / 1000) + 3600 },
    }),
  )

test("Fusion pool 403 pauses only Fusion while Auto still retries and supplies its 10 percent candidate", async () => {
  const mod = await loadAutoSessionModule()
  installDiscountCatalog("wanted-model")
  getConfig().autoDiscovery = { models: ["wanted-model"] }
  let now = Date.parse("2026-12-15T12:00:00Z")
  const clock = spyOn(Date, "now").mockImplementation(() => (now += 4_000))
  let efficiencyAttempts = 0
  const { calls, fusionCalls } = installRouter((body) => {
    if (
      body.tier === "efficiency"
      && body.prompt === "hello"
      && ++efficiencyAttempts === 1
    ) {
      return new Response(null, { status: 500 })
    }
    return okSelection("wanted-model", "auto-after-fusion-pool-denied")
  })
  try {
    await mod.prewarmAutoSession()
    await mod.whenProbeSchedulerIdle()
    expect(fusionCalls).toHaveLength(4)
    expect(efficiencyAttempts).toBe(2)
    expect(calls.every((call) => call.url.endsWith("/auto"))).toBe(true)
    expect(
      await mod.getAutoSessionForModel({
        model: "wanted-model",
        endpoint: "/responses",
      }),
    ).toEqual({
      sessionToken: "auto-after-fusion-pool-denied",
      source: "auto",
      expectedDiscount: 10,
    })
  } finally {
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    clock.mockRestore()
  }
})

test("Fusion becoming unavailable releases already parked probes and joins without another request", async () => {
  const mod = await loadAutoSessionModule()
  installDiscountCatalog("wanted-model")
  getConfig().autoDiscovery = { models: ["wanted-model"] }
  const unavailable = Promise.withResolvers<Response>()
  let attempts = 0
  const { fusionCalls } = installRouter(
    () => okSelection("wanted-model", "kept-auto"),
    () => {
      attempts++
      if (attempts === 1)
        return new Response(
          JSON.stringify({ error: { code: "account_denied" } }),
          { status: 403 },
        )
      if (attempts === 2) return unavailable.promise
      return new Response(null, { status: 400 })
    },
  )
  const poolDenied = (): Response =>
    new Response(
      JSON.stringify({ error: { code: "model_pool_not_eligible" } }),
      { status: 403 },
    )
  try {
    await mod.prewarmAutoSession({ startupBudgetMs: 20 })
    expect(fusionCalls).toHaveLength(4)
    unavailable.resolve(poolDenied())
    await mod.whenProbeSchedulerIdle()
    expect(fusionCalls).toHaveLength(4)
    expect(
      await mod.getAutoSessionForModel({
        model: "wanted-model",
        endpoint: "/responses",
      }),
    ).toEqual({
      sessionToken: "kept-auto",
      source: "auto",
      expectedDiscount: 10,
    })
    await mod.whenProbeSchedulerIdle()
    expect(fusionCalls).toHaveLength(4)
  } finally {
    mod.stopProbeScheduler()
    unavailable.resolve(poolDenied())
    await mod.whenProbeSchedulerIdle()
  }
})

test("Fusion shares four seeds plus ten additional attempts across targets, counts failures, and respects a 90 second cooldown after the promotion date", async () => {
  const mod = await loadAutoSessionModule()
  installDiscountCatalog("wanted-a", "wanted-b")
  getConfig().autoDiscovery = { models: ["wanted-a", "wanted-b"] }
  let now = Date.parse("2026-12-15T12:00:00Z")
  let advancing = true
  const clock = spyOn(Date, "now").mockImplementation(() => {
    if (advancing) now += 4_000
    return now
  })
  mod.registerAutoSelection(
    {
      ...okSelection("wanted-a", "auto-a"),
      expires_at: Math.floor(now / 1000) + 86400,
    },
    createProbeCondition({ source: "auto", tier: "balance", prompt: "hello" }),
  )
  mod.registerAutoSelection(
    {
      ...okSelection("wanted-b", "auto-b"),
      expires_at: Math.floor(now / 1000) + 86400,
    },
    createProbeCondition({ source: "auto", tier: "balance", prompt: "hello" }),
  )
  let recovered = false
  let fusionAttempts = 0
  let recoveries = 0
  const { fusionCalls } = installRouter(
    () => ({
      ...okSelection("wanted-a", "auto-a"),
      expires_at: Math.floor(now / 1000) + 86400,
    }),
    () => {
      fusionAttempts++
      if (recovered) {
        recoveries++
        return fusionSelectionResponse(
          recoveries === 1 ? "wanted-a" : "wanted-b",
          `fusion-recovered-${recoveries}`,
        )
      }
      if (fusionAttempts <= 4) return new Response(null, { status: 400 })
      if (fusionAttempts % 3 === 0)
        return Promise.reject(new TypeError("fetch failed"))
      return new Response(null, {
        status: fusionAttempts % 2 === 0 ? 503 : 429,
        headers: { "retry-after": "1" },
      })
    },
  )
  try {
    await mod.prewarmAutoSession()
    await mod.whenProbeSchedulerIdle()
    expect(fusionCalls).toHaveLength(14)
    const seedPrompts = fusionCalls.slice(0, 4).map((call) => {
      const body = call.init?.body
      if (typeof body !== "string")
        throw new Error("expected string request body")
      return JSON.parse(body) as { prompt: string }
    })
    expect(new Set(seedPrompts.map((body) => body.prompt)).size).toBe(4)
    advancing = false
    const exhaustedAt = now
    now = exhaustedAt + 89_999
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "wanted-a",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("auto-a")
    expect(fusionCalls).toHaveLength(14)
    now = exhaustedAt + 90_000
    recovered = true
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "wanted-a",
          endpoint: "/responses",
        })
      )?.source,
    ).toBe("auto")
    advancing = true
    await mod.whenProbeSchedulerIdle()
    expect(fusionCalls).toHaveLength(16)
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "wanted-a",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("fusion-recovered-1")
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "wanted-b",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("fusion-recovered-2")
  } finally {
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    clock.mockRestore()
  }
})

test("twenty concurrent configured misses share one in-flight request per source and return Auto without waiting for Fusion", async () => {
  const mod = await loadAutoSessionModule()
  installDiscountCatalog("wanted-model")
  getConfig().autoDiscovery = { models: ["wanted-model"] }
  const auto = Promise.withResolvers<AutoSelectionResponse>()
  const fusion = Promise.withResolvers<Response>()
  const autoStarted = Promise.withResolvers<void>()
  const fusionStarted = Promise.withResolvers<void>()
  const { calls, fusionCalls } = installRouter(
    () => {
      autoStarted.resolve()
      return auto.promise
    },
    () => {
      fusionStarted.resolve()
      return fusion.promise
    },
  )
  mod.resumeAutoSessionDiscoveryAfterRotation()
  const pending = Array.from({ length: 20 }, () =>
    mod.getAutoSessionForModel({
      model: "wanted-model",
      endpoint: "/responses",
    }),
  )
  try {
    await Promise.all([autoStarted.promise, fusionStarted.promise])
    expect(calls).toHaveLength(1)
    expect(fusionCalls).toHaveLength(1)
    auto.resolve(okSelection("wanted-model", "immediate-auto"))
    expect(
      (await Promise.all(pending)).every(
        (item) =>
          item?.sessionToken === "immediate-auto" && item.source === "auto",
      ),
    ).toBe(true)
    expect(fusionCalls).toHaveLength(1)
    fusion.resolve(fusionSelectionResponse("wanted-model", "later-fusion"))
    await mod.whenProbeSchedulerIdle()
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "wanted-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("later-fusion")
  } finally {
    mod.stopProbeScheduler()
    auto.resolve(okSelection("wanted-model", "immediate-auto"))
    fusion.resolve(fusionSelectionResponse("wanted-model", "later-fusion"))
    await mod.whenProbeSchedulerIdle()
    await Promise.all(pending)
  }
})

test("startup shares the 30 second budget across Auto and Fusion, then stop joins both in-flight sources", async () => {
  const mod = await loadAutoSessionModule()
  expect(mod.STARTUP_PROBE_BUDGET_MS).toBe(30_000)
  installDiscountCatalog("wanted-model")
  const auto = Promise.withResolvers<AutoSelectionResponse>()
  const fusion = Promise.withResolvers<Response>()
  const { calls, fusionCalls } = installRouter(
    () => auto.promise,
    () => fusion.promise,
  )
  try {
    // A shortened real budget exercises the same platform-timer race without a 30s test delay.
    const started = Date.now()
    await mod.prewarmAutoSession({ startupBudgetMs: 80 })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(calls.length).toBeGreaterThan(0)
    expect(fusionCalls).toHaveLength(4)
    mod.stopProbeScheduler()
    let joined = false
    const idle = mod.whenProbeSchedulerIdle().then(() => {
      joined = true
    })
    auto.resolve(okSelection("wanted-model", "auto-after-budget"))
    await auto.promise
    await Promise.resolve()
    expect(joined).toBe(false)
    fusion.resolve(
      fusionSelectionResponse("wanted-model", "fusion-after-budget"),
    )
    await idle
    expect(joined).toBe(true)
  } finally {
    mod.stopProbeScheduler()
    auto.resolve(okSelection("wanted-model", "auto-after-budget"))
    fusion.resolve(
      fusionSelectionResponse("wanted-model", "fusion-after-budget"),
    )
    await mod.whenProbeSchedulerIdle()
  }
})

test("Fusion 的失败种子各发送一次，随后共享十次补采并进入冷却", async () => {
  const mod = await loadAutoSessionModule()
  const dir = await mkdtemp(path.join(os.tmpdir(), "fusion-failed-seeds-"))
  installDiscountCatalog("wanted-model")
  getConfig().autoDiscovery = { models: ["wanted-model"] }
  let now = Date.now()
  let advancing = true
  const clock = spyOn(Date, "now").mockImplementation(() => {
    if (advancing) now += 4_000
    return now
  })
  const info = consola.info
  spyOn(consola, "info").mockImplementation(
    Object.assign(
      (...args: Parameters<typeof info>) => {
        if (
          String(args[0]).startsWith(
            "[auto-session] target discovery exhausted source=fusion ",
          )
        )
          advancing = false
        return info(...args)
      },
      { raw: info.raw },
    ),
  )
  const { fusionCalls } = installRouter(
    () => ({
      ...okSelection("wanted-model", "kept-auto"),
      expires_at: Math.floor(now / 1000) + 86400,
    }),
    () => new Response(null, { status: 503, headers: { "retry-after": "1" } }),
  )
  try {
    await mod.prewarmAutoSession({ sourceRoot: dir })
    await mod.whenProbeSchedulerIdle()
    expect(fusionCalls).toHaveLength(14)
    const conditions = fusionCalls.map((call) => {
      const raw = call.init?.body
      if (typeof raw !== "string")
        throw new Error("expected string request body")
      const body = JSON.parse(raw) as {
        prompt: string
        plan_version: "1" | "2"
        fusion_mode: "hydrafusion"
      }
      expect(body.fusion_mode).toBe("hydrafusion")
      expect(["1", "2"]).toContain(body.plan_version)
      return createProbeCondition({
        source: "fusion",
        planVersion: body.plan_version,
        fusionMode: body.fusion_mode,
        prompt: body.prompt,
      })
    })
    const seeds = conditions.slice(0, 4)
    expect(new Set(seeds.map((condition) => condition.prompt)).size).toBe(4)
    expect(seeds.map((condition) => condition.planVersion)).toEqual([
      "1",
      "2",
      "1",
      "2",
    ])
    for (const seed of seeds)
      expect(
        conditions.filter((condition) => condition.id === seed.id),
      ).toHaveLength(1)
    const targets = conditions.slice(4)
    expect(targets).toHaveLength(10)
    expect(new Set(targets.map((condition) => condition.id)).size).toBe(10)
    for (const planVersion of ["1", "2"])
      expect(
        targets.filter((condition) => condition.planVersion === planVersion),
      ).toHaveLength(5)
    expect(
      conditions
        .filter((condition) => condition.prompt === "hello")
        .map((condition) => condition.planVersion),
    ).toEqual(["1", "2"])
    expect(advancing).toBe(false)
    const exhaustedAt = now
    now = exhaustedAt + 89_999
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "wanted-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("kept-auto")
    expect(fusionCalls).toHaveLength(14)
    now = exhaustedAt + 90_000
    advancing = true
    await mod.getAutoSessionForModel({
      model: "wanted-model",
      endpoint: "/responses",
    })
    await mod.whenProbeSchedulerIdle()
    expect(fusionCalls).toHaveLength(24)
  } finally {
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    clock.mockRestore()
    await rm(dir, { recursive: true, force: true })
  }
})

test.each([429, 503])(
  "Fusion 的单次有界失败保留 %s Retry-After，后续补采不能提前发送",
  async (status) => {
    const mod = await loadAutoSessionModule()
    const dir = await mkdtemp(path.join(os.tmpdir(), "fusion-retry-deadline-"))
    installDiscountCatalog("wanted-model")
    let now = Date.now()
    spyOn(Date, "now").mockImplementation(() => now)
    const { fusionCalls } = installRouter(
      () => okSelection("wanted-model", "kept-auto"),
      () => new Response(null, { status, headers: { "retry-after": "3600" } }),
    )
    try {
      await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 20 })
      expect(fusionCalls).toHaveLength(4)
      now += 3_599_999
      await nextTurn()
      expect(fusionCalls).toHaveLength(4)
      mod.stopProbeScheduler()
      await mod.whenProbeSchedulerIdle()
      expect(fusionCalls).toHaveLength(4)
    } finally {
      mod.stopProbeScheduler()
      await mod.whenProbeSchedulerIdle()
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test("Fusion 轮换中的种子等待元数据就绪，丢弃 A 响应且 B 每点保持单飞", async () => {
  const mod = await loadAutoSessionModule()
  const dir = await mkdtemp(path.join(os.tmpdir(), "fusion-rotation-seeds-"))
  installDiscountCatalog("old-model")
  const oldAuthorization = `Bearer ${state.copilotToken}`
  const old = Promise.withResolvers<void>()
  const fresh = Promise.withResolvers<void>()
  const freshStarted = Promise.withResolvers<void>()
  let freshCalls = 0
  const { fusionCalls } = installRouter(
    () => new Response(null, { status: 400 }),
    (_body, init) => {
      if (new Headers(init?.headers).get("authorization") === oldAuthorization)
        return old.promise.then(() =>
          fusionSelectionResponse("old-model", "stale-a"),
        )
      if (++freshCalls === 4) freshStarted.resolve()
      return fresh.promise.then(() =>
        fusionSelectionResponse("new-model", "ready-b"),
      )
    },
  )
  const warm = mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 20 })
  try {
    await warm
    expect(fusionCalls).toHaveLength(4)
    state.copilotToken = "rotated-fusion-token"
    old.resolve()
    await nextTurn()
    expect(fusionCalls).toHaveLength(4)
    expect(mod.isModelAutoCovered("old-model")).toBe(false)
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "old-model",
          waitForDiscovery: false,
        })
      )?.sessionToken,
    ).toBeUndefined()
    installDiscountCatalog("new-model")
    mod.resumeAutoSessionDiscoveryAfterRotation()
    mod.resumeAutoSessionDiscoveryAfterRotation()
    await freshStarted.promise
    expect(fusionCalls).toHaveLength(8)
    expect(
      new Set(fusionCalls.slice(4).map((call) => requestBody(call).prompt))
        .size,
    ).toBe(4)
    fresh.resolve()
    await mod.whenProbeSchedulerIdle()
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "new-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("ready-b")
    expect(mod.isModelAutoCovered("old-model")).toBe(false)
    expect(fusionCalls).toHaveLength(8)
  } finally {
    mod.stopProbeScheduler()
    old.resolve()
    fresh.resolve()
    await warm
    await mod.whenProbeSchedulerIdle()
    await rm(dir, { recursive: true, force: true })
  }
})

test("Fusion 补采轮次的 finally 不得在新身份元数据就绪前开启 B 请求", async () => {
  const mod = await loadAutoSessionModule()
  installDiscountCatalog("old-model")
  getConfig().autoDiscovery = { models: ["wanted-model"] }
  const oldAuthorization = `Bearer ${state.copilotToken}`
  const old = Promise.withResolvers<Response>()
  const oldStarted = Promise.withResolvers<void>()
  const { fusionCalls } = installRouter(
    () => okSelection("wanted-model", "kept-auto"),
    (_body, init) => {
      if (
        new Headers(init?.headers).get("authorization") === oldAuthorization
      ) {
        oldStarted.resolve()
        return old.promise
      }
      return fusionSelectionResponse("wanted-model", "ready-b")
    },
  )
  try {
    mod.resumeAutoSessionDiscoveryAfterRotation()
    await mod.getAutoSessionForModel({
      model: "wanted-model",
      waitForDiscovery: false,
    })
    await oldStarted.promise
    expect(fusionCalls).toHaveLength(1)
    state.copilotToken = "rotated-fusion-token"
    old.resolve(fusionSelectionResponse("old-model", "stale-a"))
    await nextTurn()
    expect(fusionCalls).toHaveLength(1)
    expect(mod.isModelAutoCovered("old-model")).toBe(false)
    installDiscountCatalog("wanted-model")
    mod.resumeAutoSessionDiscoveryAfterRotation()
    await mod.whenProbeSchedulerIdle()
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "wanted-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("ready-b")
    expect(fusionCalls).toHaveLength(5)
  } finally {
    mod.stopProbeScheduler()
    old.resolve(fusionSelectionResponse("old-model", "stale-a"))
    await mod.whenProbeSchedulerIdle()
  }
})

test("停止唤醒等待轮换元数据的 Fusion 种子且不发送 B 请求", async () => {
  const mod = await loadAutoSessionModule()
  const dir = await mkdtemp(path.join(os.tmpdir(), "fusion-rotation-stop-"))
  installDiscountCatalog("old-model")
  const old = Promise.withResolvers<void>()
  const { fusionCalls } = installRouter(
    () => new Response(null, { status: 400 }),
    () =>
      old.promise.then(() => fusionSelectionResponse("old-model", "stale-a")),
  )
  try {
    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 20 })
    state.copilotToken = "rotated-fusion-token"
    old.resolve()
    await nextTurn()
    expect(fusionCalls).toHaveLength(4)
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    expect(fusionCalls).toHaveLength(4)
    expect(mod.isModelAutoCovered("old-model")).toBe(false)
  } finally {
    mod.stopProbeScheduler()
    old.resolve()
    await mod.whenProbeSchedulerIdle()
    await rm(dir, { recursive: true, force: true })
  }
})

test("Fusion 种子跨 A→B 未就绪→C 就绪轮换后，C 的失败发送每点仍只有一次", async () => {
  const mod = await loadAutoSessionModule()
  const dir = await mkdtemp(path.join(os.tmpdir(), "fusion-rotation-budget-"))
  installDiscountCatalog("old-model")
  const oldAuthorization = `Bearer ${state.copilotToken}`
  const old = Promise.withResolvers<void>()
  let now = Date.now()
  let advancing = false
  spyOn(Date, "now").mockImplementation(() => {
    if (advancing) now += 4_000
    return now
  })
  const { fusionCalls } = installRouter(
    () => new Response(null, { status: 400 }),
    (_body, init) => {
      if (
        new Headers(init?.headers).get("authorization") === oldAuthorization
      ) {
        return old.promise.then(() =>
          fusionSelectionResponse("old-model", "stale-a"),
        )
      }
      return new Response(null, { status: 503 })
    },
  )
  try {
    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 20 })
    expect(fusionCalls).toHaveLength(4)
    state.copilotToken = "rotation-budget-b"
    old.resolve()
    await nextTurn()
    expect(fusionCalls).toHaveLength(4)
    expect(mod.isModelAutoCovered("old-model")).toBe(false)

    state.copilotToken = "rotation-budget-c"
    advancing = true
    mod.resumeAutoSessionDiscoveryAfterRotation()
    await mod.whenProbeSchedulerIdle()

    expect(fusionCalls).toHaveLength(8)
    const cCalls = fusionCalls.filter(
      (call) =>
        new Headers(call.init?.headers).get("authorization")
        === "Bearer rotation-budget-c",
    )
    expect(cCalls).toHaveLength(4)
    expect(new Set(cCalls.map((call) => requestBody(call).prompt)).size).toBe(4)
    expect(
      fusionCalls.some(
        (call) =>
          new Headers(call.init?.headers).get("authorization")
          === "Bearer rotation-budget-b",
      ),
    ).toBe(false)
    expect(mod.isModelAutoCovered("old-model")).toBe(false)
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
    expect(fusionCalls).toHaveLength(8)
  } finally {
    mod.stopProbeScheduler()
    old.resolve()
    await mod.whenProbeSchedulerIdle()
    await rm(dir, { recursive: true, force: true })
  }
})

test("Fusion round summaries exclude coverage acquired only by Auto", async () => {
  const mod = await loadAutoSessionModule()
  installDiscountCatalog("target-model", "auto-only-model", "later-auto-model")
  getConfig().autoDiscovery = { models: ["target-model"] }
  const gate = Promise.withResolvers<Response>()
  const infoSpy = spyOn(consola, "info")
  const { fusionCalls } = installRouter(
    () => new Response(null, { status: 400 }),
    () => gate.promise,
  )
  try {
    mod.resumeAutoSessionDiscoveryAfterRotation()
    mod.registerAutoSelection(
      okSelection("auto-only-model", "AUTO_ONLY_PRIVATE"),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    expect(fusionCalls).toHaveLength(0)
    mod.registerAutoSelection(
      okSelection("target-model", "AUTO_TARGET_PRIVATE"),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    await waitFor(() => fusionCalls.length === 1, 1_000)
    mod.registerAutoSelection(
      okSelection("later-auto-model", "LATER_AUTO_PRIVATE"),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    mod.stopProbeScheduler()
    gate.resolve(
      fusionSelectionResponse("target-model", "FUSION_TARGET_PRIVATE"),
    )
    await mod.whenProbeSchedulerIdle()

    const lines = infoSpy.mock.calls.map((call) => String(call[0]))
    expect(
      lines.filter((line) => line.includes("target discovery start")),
    ).toEqual([
      '[auto-session] target discovery start source=fusion reason=miss missing=["target-model"]',
    ])
    expect(
      lines.filter((line) => line.includes("target discovery stopped")),
    ).toEqual([
      '[auto-session] target discovery stopped source=fusion added=["target-model"] missing=[]',
    ])
    expect(lines.join("\n")).not.toContain("PRIVATE")
  } finally {
    mod.stopProbeScheduler()
    gate.resolve(new Response(null, { status: 400 }))
    await mod.whenProbeSchedulerIdle()
  }
})
