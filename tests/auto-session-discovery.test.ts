import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import consola from "consola"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { state } from "../src/lib/state"
import type { AutoSelectionResponse } from "../src/services/copilot/get-auto-selection"

import type * as AutoSessionModule from "../src/lib/auto-session"

const HARD_QUESTION =
  "请指出这段代码中最可能的正确性问题，以及确认该问题所需的信息。"
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

// 动态导入用于重置模块级配对表：每个用例需要干净的 auto-session 状态。
// 带 query 的动态导入被 TS 视为 any，断言回模块类型以满足类型安全返回
const loadAutoSessionModule = (): Promise<typeof AutoSessionModule> =>
  import(
    `../src/lib/auto-session?test=${Date.now()}-${Math.random()}`
  ) as Promise<typeof AutoSessionModule>

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
): { calls: Array<RecordedCall> } => {
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
  return { calls }
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
    .find((text) => text.includes("discovery complete"))
  expect(line).toBeDefined()
  return line as string
}

beforeEach(() => {
  state.copilotToken = "discovery-auth-token"
})

afterEach(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  mock.restore()
})

test("startup discovery probes four tiers with hello easy and 100-line source hard prompt", async () => {
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
    (call) => requestBody(call).prompt !== "hello",
  ) as RecordedCall
  const lines = requestBody(hardCall).prompt.split("\n")
  expect(lines).toHaveLength(102)
  expect(lines[100]).toBe("")
  expect(lines[101]).toBe(HARD_QUESTION)
  expect(await appearsInSourceTree(lines.slice(0, 100).join("\n"))).toBe(true)

  // 每次成功响应按实际模型 ID 注册，token 与模型精确绑定
  for (const [model, token] of tokens) {
    expect(mod.isModelAutoCovered(model)).toBe(true)
    expect(await mod.getAutoSessionTokenForModel(model, "/responses")).toBe(
      token,
    )
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

test("each tier samples its own hard snippet independently", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-per-tier-"))
  try {
    await writeFile(
      path.join(dir, "wide.ts"),
      Array.from({ length: 150 }, (_, i) => `export const w${i} = ${i}`).join(
        "\n",
      ),
    )
    const mod = await loadAutoSessionModule()
    const hardPrompts: Array<string> = []
    installRouter((body) => {
      if (body.prompt !== "hello") hardPrompts.push(body.prompt)
      // 各档两题不同模型，避免触发重采干扰取样次数统计
      return okSelection(
        `${body.prompt === "hello" ? "easy" : "hard"}-${body.tier}`,
      )
    })

    // 每次取样恰好消耗两次 Math.random：文件选择（仅 1 文件）与起点选择（51 窗）。
    // 并发下各档取样调用顺序不定，但任意两次调用的起点都不同即证非共享片段。
    const script = [0.1, 0.02, 0.1, 0.3, 0.1, 0.6, 0.1, 0.85]
    let i = 0
    const randomSpy = spyOn(Math, "random").mockImplementation(
      () => script[i++ % script.length],
    )
    try {
      await mod.prewarmAutoSession({ sourceRoot: dir })
    } finally {
      randomSpy.mockRestore()
    }

    expect(hardPrompts).toHaveLength(4)
    expect(new Set(hardPrompts).size).toBeGreaterThanOrEqual(2)
  } finally {
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
    expect(failedLines.some((line) => line.includes("Error"))).toBe(true)
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
      .filter((line) => line.includes("selection request failed"))
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

test("insufficient source reports incomplete and normal request path stays usable", async () => {
  const mod = await loadAutoSessionModule()
  const infoSpy = spyOn(consola, "info")
  const { calls } = installRouter((body) =>
    okSelection(`only-${body.prompt === "hello" ? "easy" : "hard"}`),
  )
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-none-"))
  try {
    await mod.prewarmAutoSession({ sourceRoot: emptyDir })

    // 难题跳过：每档仅简单题一次
    expect(calls).toHaveLength(4)
    expect(mod.isModelAutoCovered("only-easy")).toBe(true)
    expect(mod.isModelAutoCovered("only-hard")).toBe(false)
    const line = discoveryLogLine(infoSpy)
    expect(line).toContain("models=only-easy")
    expect(line).toContain("incomplete=4")
    // 请求路径仍可用（命中已注册配对）
    expect(
      await mod.getAutoSessionTokenForModel("only-easy", "/responses"),
    ).toBe("token-only-easy")
  } finally {
    await rm(emptyDir, { recursive: true, force: true })
  }
})

test("discovery log lists deduped model ids without tiers, prompts, source or tokens", async () => {
  const mod = await loadAutoSessionModule()
  const infoSpy = spyOn(consola, "info")
  installRouter(() => okSelection("shared-model", "secret-session-token"))

  await mod.prewarmAutoSession()

  const line = discoveryLogLine(infoSpy)
  expect(line).toContain("models=shared-model")
  expect(line).toContain("incomplete=0")
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
    expect(await mod.getAutoSessionTokenForModel("gated-model")).toBeUndefined()

    // 放行后在后台完成补采，配对立即命中可用
    gate.resolve()
    await waitFor(() => mod.isModelAutoCovered("gated-model"), 3_000)
    expect(await mod.getAutoSessionTokenForModel("gated-model")).toBe(
      "token-gated-model",
    )
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
      await mod.getAutoSessionTokenForModel("fast-efficiency", "/responses"),
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
  try {
    await writeWideSource(dir, "wide.ts")
    let easyAttempts = 0
    installRouter((body) => {
      if (body.tier === "efficiency" && body.prompt === "hello") {
        easyAttempts += 1
        if (easyAttempts === 1) return new TypeError("fetch failed")
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
    // 单次退避抖动下限 1s
    expect(elapsed).toBeGreaterThanOrEqual(1_000)
    expect(mod.isModelAutoCovered("easy-efficiency")).toBe(true)

    // 重试日志只含固定类别，不含错误对象、prompt、tier 或 token
    const retryLines = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("probe retry"))
    expect(retryLines).toHaveLength(1)
    expect(retryLines[0]).toBe("[auto-session] probe retry: network")
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
    expect(
      infoLines().some((line) => line.includes("discovery snapshot")),
    ).toBe(true)
    expect(
      infoLines().some((line) => line.includes("discovery complete")),
    ).toBe(false)

    gate.resolve()
    await waitFor(
      () => infoLines().some((line) => line.includes("discovery complete")),
      3_000,
    )
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

test("budget snapshot counts all eight unsettled probe points as incomplete", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-snippet-snap8-"))
  const mod = await loadAutoSessionModule()
  const gate = Promise.withResolvers<void>()
  const infoSpy = spyOn(consola, "info")
  try {
    await writeWideSource(dir, "wide.ts")
    installRouter(() => gate.promise.then(() => okSelection("gated-model")))

    await mod.prewarmAutoSession({ sourceRoot: dir, startupBudgetMs: 80 })

    const snapshot = infoSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("discovery snapshot"))
    expect(snapshot).toContain("incomplete=8")
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

    // 新凭据下补采成功并登记
    await waitFor(() => mod.isModelAutoCovered("new-easy-efficiency"), 3_000)
    expect(
      await mod.getAutoSessionTokenForModel(
        "new-easy-efficiency",
        "/responses",
      ),
    ).toBe("token-new-easy-efficiency")
    // 旧凭据的响应不得进入新凭据配对：旧模型必须脱靶
    expect(
      await mod.getAutoSessionTokenForModel("old-model", "/responses"),
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
      await mod.getAutoSessionTokenForModel("easy-efficiency"),
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
    expect(await mod.getAutoSessionTokenForModel("easy-efficiency")).toBe(
      "token-easy-efficiency",
    )
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
