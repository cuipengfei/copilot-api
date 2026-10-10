import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { HARD_QUESTION } from "../src/lib/auto-probe-prompts"
import { createVarietyCases } from "../.agents/skills/copilot-backend-tester/scripts/auto-variety-prompts.mjs"

interface VarietySource {
  file: string
  startLine: number
  lineCount: number
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const cliPath = path.join(
  cwd,
  ".agents/skills/copilot-backend-tester/scripts/test-auto-select.mjs",
)
const preloadPath = path.join(
  cwd,
  "tests/fixtures/backend-auto-variety-preload.ts",
)

const decoder = new TextDecoder()

const FIXTURE_GITHUB_TOKEN = "ghu_backendVarietyFixtureToken000000000000"
const FIXTURE_SESSION_TOKEN = "fake-session-token-for-variety-tests"
const EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token"
const ALL_TIERS = ["efficiency", "balance", "intelligence", "fast"]
const SNIPPET_ERROR_MESSAGE =
  "auto-variety: unable to sample a 100-line TypeScript snippet from the source root"

// 固定任务措辞（与原探测一致，跨轮不变）：intelligence 优先，P6 原 task 措辞 pinning
const TASK_TAILS: Record<string, string> = {
  "task-behavior":
    "Task: 说明这段程序的主要行为、输入、输出和状态变化。仅依据提供的材料，不要求修改代码。",
  "task-cancellation":
    "Task: 为该模块增加调用方可取消操作的能力，保持现有成功路径、错误传播和资源清理行为。检查已有取消支持；若已满足，指出证据。否则给出完整修改、受影响调用方和验证用例。",
  "task-concurrency":
    "Task: 检查并发请求、取消、异常和状态变化的交错。只报告有源码依据的问题；给出能够触发问题的事件顺序、最小修复和区分修复前后行为的验证。证据不足时明确说明。",
  "task-correctness":
    "Task: 完成端到端正确性分析：建立状态模型，追踪跨文件调用关系，检查并发、取消和异常下的不变量；对成立的问题给出完整修复与确定性验证，对无法确认的问题列出缺失证据。不得预设一定存在缺陷。",
}
const TASK_CONTEXT_FILES = [
  "src/lib/request-auth.ts",
  "src/server.ts",
  "src/lib/config.ts",
  "tests/request-auth.test.ts",
] as const

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex")

// POSIX 行数：尾换行不额外计 1，空文件为 0（与 case profile 的 lineCount 约定一致）
const lineCountOf = (text: string): number =>
  text.length === 0 ?
    0
  : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

interface RecordFile {
  scenario: string
  requests: Array<RecordedRequest>
  responses: Array<{ url: string; status: number }>
}

interface VarietyResult {
  prompt_id: string
  tier: string
  status: number | null
  selected_model: string | null
  supported_endpoints: Array<string> | null
  source?: VarietySource
  sources?: Array<VarietySource>
  prompt_sha256?: string
  error?: string
}

interface VarietyOutput {
  observed_at: string
  proxy_url: string
  upstream: string
  account: string
  account_source: string
  complete: boolean
  stop_reason: string | null
  auto_requests: number
  results: Array<VarietyResult>
  observed_models: Array<string>
  expected_cases: number
}

interface CliRun {
  exitCode: number
  stdout: string
  stderr: string
  record: RecordFile | null
  upstreamBase: string
  proxyUrl: string
  elapsedMs: number
}

const tempDirs: Array<string> = []

const autoVarietyTempDir = (): string => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "backend-auto-variety-"),
  )
  tempDirs.push(tempDir)
  return tempDir
}

// fetch 被 preload 全量接管，子进程零真实 socket；随机高端口仅用于命名 fake
// upstream 与 proxy-url（显式传入，避免 ps 探测命中真实 4141 进程的 -g token）
const randomLocalPort = (): number =>
  40_000 + Math.floor(Math.random() * 20_000)

const runVarietyCli = (args: Array<string>, scenario: string): CliRun => {
  const tempDir = autoVarietyTempDir()
  const recordPath = path.join(tempDir, "record.json")
  const upstreamBase = `http://127.0.0.1:${randomLocalPort()}`
  const proxyUrl = `http://127.0.0.1:${randomLocalPort()}`
  const startedAt = Date.now()
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--preload",
      preloadPath,
      cliPath,
      "--proxy-url",
      proxyUrl,
      ...args,
    ],
    cwd,
    env: {
      ...process.env,
      HOME: tempDir,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
      COPILOT_API_GITHUB_TOKEN: FIXTURE_GITHUB_TOKEN,
      BACKEND_AUTO_VARIETY_RECORD: recordPath,
      BACKEND_AUTO_VARIETY_SCENARIO: scenario,
      BACKEND_AUTO_VARIETY_UPSTREAM_PORT: upstreamBase.replace(
        "http://127.0.0.1:",
        "",
      ),
    },
  })
  let record: RecordFile | null = null
  if (fs.existsSync(recordPath)) {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as RecordFile
  }
  return {
    exitCode: result.exitCode ?? -1,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
    record,
    upstreamBase,
    proxyUrl,
    elapsedMs: Date.now() - startedAt,
  }
}

const parseOutput = (run: CliRun): VarietyOutput =>
  JSON.parse(run.stdout) as VarietyOutput

const autoBodies = (run: CliRun): Array<{ prompt: string; tier: string }> => {
  const requests = run.record?.requests ?? []
  return requests
    .filter((request) => request.url === `${run.upstreamBase}/auto`)
    .map((request) => request.body as { prompt: string; tier: string })
}

const sourceText = (source: VarietySource): string => {
  const absolute = path.join(cwd, source.file)
  expect(fs.existsSync(absolute)).toBe(true)
  return fs
    .readFileSync(absolute, "utf8")
    .split("\n")
    .slice(source.startLine, source.startLine + source.lineCount)
    .join("\n")
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

describe("backend-auto-variety CLI", () => {
  test("runs 12 fixed cases with one auth, real source prompts, and no generation requests", () => {
    const run = runVarietyCli(["--variety"], "ok")
    expect(run.exitCode).toBe(0)
    const output = parseOutput(run)

    expect(output.expected_cases).toBe(12)
    expect(output.complete).toBe(true)
    expect(output.stop_reason).toBeNull()
    expect(output.account).toBe("individual")
    expect(output.account_source).toBe("expectation")
    expect(output.proxy_url).toBe(run.proxyUrl)
    expect(output.upstream).toBe(run.upstreamBase)
    expect(output.auto_requests).toBe(12)
    expect(output.results).toHaveLength(12)
    for (const result of output.results) {
      expect(result.status).toBe(200)
      expect(typeof result.selected_model).toBe("string")
    }

    // 网络轮廓：恰好 1 次认证 + 12 次 /auto，无任何其他端点
    const requests = run.record?.requests ?? []
    expect(requests).toHaveLength(13)
    expect(
      requests.filter((request) => request.url === EXCHANGE_URL),
    ).toHaveLength(1)
    expect(
      requests.filter((request) => request.url === `${run.upstreamBase}/auto`),
    ).toHaveLength(12)
    for (const request of requests) {
      expect([EXCHANGE_URL, `${run.upstreamBase}/auto`]).toContain(request.url)
    }
    const exchange = requests.find((request) => request.url === EXCHANGE_URL)
    expect(exchange?.headers.authorization).toBe(
      `token ${FIXTURE_GITHUB_TOKEN}`,
    )

    // hard case：真实 100 行源码 + 空行 + HARD_QUESTION，source 可回溯到真实文件
    const bodies = autoBodies(run)
    expect(bodies).toHaveLength(12)
    let hardCount = 0
    for (const [index, result] of output.results.entries()) {
      if (!result.prompt_id.startsWith("hard-")) {
        continue
      }
      hardCount += 1
      const body = bodies[index]
      const source = result.source
      if (source === undefined || body === undefined) {
        throw new Error(
          `case ${result.prompt_id} missing source or request body`,
        )
      }
      expect(source.lineCount).toBe(100)
      expect(path.isAbsolute(source.file)).toBe(false)
      expect(body.prompt).toBe(`${sourceText(source)}\n\n${HARD_QUESTION}`)
    }
    expect(hardCount).toBe(4)

    // 四个任务 case：完整跨文件上下文（4 个真实文件全文）+ 固定任务尾
    const taskResults = output.results.filter((result) =>
      result.prompt_id.startsWith("task-"),
    )
    expect(taskResults).toHaveLength(4)
    const taskTails = new Set<string>()
    for (const result of taskResults) {
      expect(result.source).toBeUndefined()
      const sources = result.sources
      if (sources === undefined) {
        throw new Error(`case ${result.prompt_id} missing sources`)
      }
      expect(sources.map((entry) => entry.file)).toEqual([
        ...TASK_CONTEXT_FILES,
      ])
      const index = output.results.indexOf(result)
      const body = bodies[index]
      if (body === undefined) {
        throw new Error(`case ${result.prompt_id} missing request body`)
      }
      for (const source of sources) {
        expect(source.startLine).toBe(0)
        expect(path.isAbsolute(source.file)).toBe(false)
        const absolute = path.join(cwd, source.file)
        const text = fs.readFileSync(absolute, "utf8")
        expect(source.lineCount).toBe(lineCountOf(text))
        // 关键消费行为：请求 prompt 嵌入文件完整原文，无截断
        expect(body.prompt).toContain(text)
      }
      const tail = body.prompt.slice(body.prompt.lastIndexOf("\n") + 1)
      expect(body.prompt).not.toContain("Task: Task:")
      expect(tail).toBe(TASK_TAILS[result.prompt_id])
      taskTails.add(tail)
    }
    expect(taskTails.size).toBe(4)

    // 其余 case 不带源码元数据；全部 case 带可复核 prompt_sha256
    for (const result of output.results) {
      if (result.prompt_id.startsWith("hard-")) {
        expect(result.sources).toBeUndefined()
      }
      if (
        !result.prompt_id.startsWith("hard-")
        && !result.prompt_id.startsWith("task-")
      ) {
        expect(result.source).toBeUndefined()
        expect(result.sources).toBeUndefined()
      }
      const index = output.results.indexOf(result)
      const body = bodies[index]
      if (body === undefined) {
        throw new Error(`case ${result.prompt_id} missing request body`)
      }
      expect(result.prompt_sha256).toBe(sha256Hex(body.prompt))
    }

    // tier 多样性与 observed_models 按实际响应去重（unknown ID 原样报告）
    expect(new Set(output.results.map((result) => result.tier))).toEqual(
      new Set(ALL_TIERS),
    )
    const servedIds = output.results
      .map((result) => result.selected_model)
      .filter((model) => model !== null)
    expect(output.observed_models).toEqual([...new Set(servedIds)].sort())
    expect(output.observed_models.length).toBeGreaterThanOrEqual(2)
    expect(output.observed_models).toContain("unknown-exp-model-9")
    expect(output.observed_models).toEqual([...output.observed_models].sort())

    // 安全边界：stdout/stderr 不泄露 token、session、prompt 或源码
    for (const stream of [run.stdout, run.stderr]) {
      expect(stream).not.toContain(FIXTURE_GITHUB_TOKEN)
      expect(stream).not.toContain(FIXTURE_SESSION_TOKEN)
      for (const body of bodies) {
        expect(stream).not.toContain(body.prompt)
      }
    }
  })

  for (const [scenario, stopReason] of [
    ["http429", "http_429"],
    ["http401", "http_401"],
    ["http403", "http_403"],
  ] as const) {
    test(`${scenario} stops on the first failure`, () => {
      const run = runVarietyCli(["--variety"], scenario)
      const output = parseOutput(run)

      expect(output.complete).toBe(false)
      expect(output.stop_reason).toBe(stopReason)
      expect(output.auto_requests).toBe(1)
      expect(output.results).toHaveLength(1)
      expect(output.results[0]?.status).toBe(Number(stopReason.slice(5)))
      expect(output.results[0]?.selected_model).toBeNull()

      // 首失败即停：仅已批准数量的请求（1 次认证 + 1 次 /auto）
      const requests = run.record?.requests ?? []
      expect(requests).toHaveLength(2)
      expect(
        requests.filter(
          (request) => request.url === `${run.upstreamBase}/auto`,
        ),
      ).toHaveLength(1)
    })
  }

  test("token exchange HTTP failure keeps the actual status and sends nothing", () => {
    const run = runVarietyCli(["--variety"], "auth403")
    const output = parseOutput(run)

    expect(output.complete).toBe(false)
    expect(output.stop_reason).toBe("http_403")
    expect(output.auto_requests).toBe(0)
    expect(output.results).toHaveLength(0)

    // 仅 1 次认证请求，保留实际 HTTP 状态，/auto 零请求
    const requests = run.record?.requests ?? []
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(EXCHANGE_URL)
    expect(run.record?.responses).toEqual([{ url: EXCHANGE_URL, status: 403 }])
  })

  test("malformed model selection is not reported as success", () => {
    const run = runVarietyCli(["--variety"], "malformed")
    const output = parseOutput(run)

    expect(output.complete).toBe(false)
    expect(output.stop_reason).toBe("malformed_model")
    expect(output.results[0]?.status).toBe(200)
    expect(output.results[0]?.error).toBe("malformed_model")
    expect(output.results[0]?.selected_model).toBeNull()
    expect(output.results[0]?.supported_endpoints).toBeNull()
    const requests = run.record?.requests ?? []
    expect(
      requests.filter((request) => request.url.includes("/auto")),
    ).toHaveLength(1)
  })

  test("omitted supported_endpoints keeps observing models and completes all 12", () => {
    const run = runVarietyCli(["--variety"], "noEndpoints")
    expect(run.exitCode).toBe(0)
    const output = parseOutput(run)

    expect(output.complete).toBe(true)
    expect(output.stop_reason).toBeNull()
    expect(output.auto_requests).toBe(12)
    expect(output.results).toHaveLength(12)
    for (const result of output.results) {
      expect(result.status).toBe(200)
      expect(typeof result.selected_model).toBe("string")
      // 缺失字段报告为 null，不当失败、不截断观测
      expect(result.supported_endpoints).toBeNull()
    }
    expect(output.observed_models).toContain("unknown-exp-model-9")
    expect(output.observed_models.length).toBeGreaterThanOrEqual(2)

    const requests = run.record?.requests ?? []
    expect(
      requests.filter((request) => request.url === `${run.upstreamBase}/auto`),
    ).toHaveLength(12)
  })

  for (const scenario of [
    "badEndpointsNull",
    "badEndpointsString",
    "badEndpointsArray",
  ] as const) {
    test(`${scenario} stops as malformed_model without leaking the payload`, () => {
      const run = runVarietyCli(["--variety"], scenario)
      const output = parseOutput(run)

      expect(output.complete).toBe(false)
      expect(output.stop_reason).toBe("malformed_model")
      expect(output.auto_requests).toBe(1)
      expect(output.results[0]?.status).toBe(200)
      expect(output.results[0]?.error).toBe("malformed_model")
      expect(output.results[0]?.selected_model).toBeNull()
      expect(output.results[0]?.supported_endpoints).toBeNull()

      // 首失败即停：1 次 /auto，且 stdout 不携带错误字段内容
      const requests = run.record?.requests ?? []
      expect(
        requests.filter((request) => request.url.includes("/auto")),
      ).toHaveLength(1)
      for (const stream of [run.stdout, run.stderr]) {
        expect(stream).not.toContain(FIXTURE_SESSION_TOKEN)
        expect(stream).not.toContain("/chat/completions")
      }
    })
  }

  test("empty model id is rejected as malformed_model", () => {
    const run = runVarietyCli(["--variety"], "emptyId")
    const output = parseOutput(run)

    expect(output.complete).toBe(false)
    expect(output.stop_reason).toBe("malformed_model")
    expect(output.auto_requests).toBe(1)
    expect(output.results[0]?.error).toBe("malformed_model")
    expect(output.results[0]?.selected_model).toBeNull()
    const requests = run.record?.requests ?? []
    expect(
      requests.filter((request) => request.url.includes("/auto")),
    ).toHaveLength(1)
  })

  test("deadline aborts the in-flight request and sends nothing further", () => {
    const run = runVarietyCli(["--variety"], "hang")
    // preload 仅在 /auto 挂起后 10ms 触发 CLI 自己的整轮截止回调；运行应远快于真实 60s
    expect(run.elapsedMs).toBeLessThan(20_000)
    const output = parseOutput(run)

    expect(output.complete).toBe(false)
    expect(output.stop_reason).toBe("deadline")
    expect(output.auto_requests).toBe(1)
    expect(output.results[0]?.status).toBeNull()
    expect(output.results[0]?.error).toBe("AbortError")
    expect(output.results[0]?.selected_model).toBeNull()

    // 真实认证先完成，随后 1 次被中止的 /auto；signal 中止后零后续请求
    const requests = run.record?.requests ?? []
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe(EXCHANGE_URL)
    expect(
      requests.filter((request) => request.url === `${run.upstreamBase}/auto`),
    ).toHaveLength(1)
  })

  for (const extraArgs of [
    ["--prompt", "hello"],
    ["--tier", "fast"],
    ["--with-inference"],
    ["--show-headers"],
  ] as const) {
    test(`--variety rejects ${extraArgs[0]} before any network`, () => {
      const run = runVarietyCli(["--variety", ...extraArgs], "ok")
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr).not.toBe("")
      expect(run.record?.requests).toHaveLength(0)
    })
  }

  test("--help exits 0 with zero auth and zero network", () => {
    const run = runVarietyCli(["--help"], "ok")
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toBe("")
    expect(run.stderr).toContain("Usage")
    expect(run.record?.requests).toHaveLength(0)
  })
})

describe("createVarietyCases source sampling", () => {
  // 带 marker 的最小夹具（各 2 行且 <100 行，保证 sample-target.ts 是唯一可采样片段源；
  // 只提供全文/边界输入，不模拟真实模块逻辑）
  const REQUEST_AUTH_FIXTURE = `// fixture-auth-marker
export const authMarker = "fixture-auth-marker-value"
`
  const SERVER_FIXTURE = `// fixture-server-marker
export const serverMarker = "fixture-server-marker-value"
`
  const CONFIG_FIXTURE = `// fixture-config-marker
export const configMarker = "fixture-config-marker-value"
`
  const REQUEST_AUTH_TEST_FIXTURE = `// fixture-auth-test-marker
export const authTestMarker = "fixture-auth-test-marker-value"
`

  const writeContextFixtures = (
    root: string,
    options: { withTestFile?: boolean } = {},
  ): { srcDir: string; testsDir: string } => {
    const srcDir = path.join(root, "src")
    const testsDir = path.join(root, "tests")
    fs.mkdirSync(path.join(srcDir, "lib"), { recursive: true })
    fs.mkdirSync(testsDir, { recursive: true })
    fs.writeFileSync(
      path.join(srcDir, "lib", "request-auth.ts"),
      REQUEST_AUTH_FIXTURE,
    )
    fs.writeFileSync(path.join(srcDir, "server.ts"), SERVER_FIXTURE)
    fs.writeFileSync(path.join(srcDir, "lib", "config.ts"), CONFIG_FIXTURE)
    if (options.withTestFile !== false) {
      fs.writeFileSync(
        path.join(testsDir, "request-auth.test.ts"),
        REQUEST_AUTH_TEST_FIXTURE,
      )
    }
    return { srcDir, testsDir }
  }

  const writeSnippetSource = (srcDir: string): void => {
    const lines = Array.from(
      { length: 100 },
      (_, index) =>
        `export const line${index} = ${JSON.stringify(
          index === 0 ? "variety-marker-alpha"
          : index === 99 ? "variety-marker-omega"
          : `filler-${index}`,
        )}`,
    )
    fs.writeFileSync(path.join(srcDir, "sample-target.ts"), lines.join("\n"))
  }

  test("samples real text and pins cross-file context metadata", async () => {
    const tempDir = autoVarietyTempDir()
    const { srcDir, testsDir } = writeContextFixtures(tempDir)
    writeSnippetSource(srcDir)

    const cases = await createVarietyCases({ sourceRoot: srcDir })
    expect(cases).toHaveLength(12)

    // 全部 case 带可复核 prompt_sha256
    for (const c of cases) {
      expect(c.prompt_sha256).toBe(sha256Hex(c.prompt))
    }

    // hard case：真实 100 行片段照常，完整上下文不影响硬题来源
    const hardCases = cases.filter((c) => c.id.startsWith("hard-"))
    expect(hardCases).toHaveLength(4)
    for (const c of hardCases) {
      expect(c.prompt).toContain("variety-marker-alpha")
      expect(c.prompt).toContain("variety-marker-omega")
      expect(c.prompt.endsWith(`\n\n${HARD_QUESTION}`)).toBe(true)
      if (c.source === undefined) {
        throw new Error(`case ${c.id} missing source`)
      }
      expect(c.source.startLine).toBe(0)
      expect(c.source.lineCount).toBe(100)
      expect(path.isAbsolute(c.source.file)).toBe(false)
      expect(path.resolve(cwd, c.source.file)).toBe(
        path.join(srcDir, "sample-target.ts"),
      )
    }

    // 任务 case：完整跨文件上下文（4 文件全文），sources 可回溯
    const fixtureFiles = [
      path.join(srcDir, "lib", "request-auth.ts"),
      path.join(srcDir, "server.ts"),
      path.join(srcDir, "lib", "config.ts"),
      path.join(testsDir, "request-auth.test.ts"),
    ]
    const expectedFiles = fixtureFiles.map((file) =>
      path.relative(cwd, file).split(path.sep).join("/"),
    )
    const fixtureTexts = fixtureFiles.map((file) =>
      fs.readFileSync(file, "utf8"),
    )
    const taskCases = cases.filter((c) => c.id.startsWith("task-"))
    expect(taskCases).toHaveLength(4)
    const taskTails = new Set<string>()
    for (const c of taskCases) {
      expect("source" in c).toBe(false)
      if (c.sources === undefined) {
        throw new Error(`case ${c.id} missing sources`)
      }
      expect(c.sources.map((entry) => entry.file)).toEqual(expectedFiles)
      for (const [index, entry] of c.sources.entries()) {
        const text = fixtureTexts[index]
        if (text === undefined) {
          throw new Error(`case ${c.id} missing fixture text`)
        }
        expect(entry.startLine).toBe(0)
        expect(entry.lineCount).toBe(lineCountOf(text))
        // 关键消费行为：prompt 嵌入每个文件完整原文，无截断
        expect(c.prompt).toContain(text)
      }
      const tail = c.prompt.slice(c.prompt.lastIndexOf("\n") + 1)
      expect(c.prompt).not.toContain("Task: Task:")
      expect(tail).toBe(TASK_TAILS[c.id])
      taskTails.add(tail)
    }
    expect(taskTails.size).toBe(4)
  })

  test("throws the snippet error when context files exist but no eligible 100-line file does", async () => {
    const tempDir = autoVarietyTempDir()
    const { srcDir } = writeContextFixtures(tempDir)
    // .test.ts 与 .d.ts 被真实采样规则排除，不能充当片段来源
    const longLines = Array.from(
      { length: 150 },
      (_, index) => `export const x${index} = ${index}`,
    )
    fs.writeFileSync(path.join(srcDir, "sample.test.ts"), longLines.join("\n"))
    fs.writeFileSync(path.join(srcDir, "sample.d.ts"), longLines.join("\n"))

    const outcome = await createVarietyCases({ sourceRoot: srcDir }).catch(
      (cause: unknown) => cause,
    )
    expect(outcome).toBeInstanceOf(Error)
    if (!(outcome instanceof Error)) {
      throw new Error("expected createVarietyCases to reject with an Error")
    }
    expect(outcome.message).toBe(SNIPPET_ERROR_MESSAGE)
  })

  test("throws when a required cross-file context is missing", async () => {
    const tempDir = autoVarietyTempDir()
    // 片段可采样，但 tests/request-auth.test.ts 缺失
    const { srcDir, testsDir } = writeContextFixtures(tempDir, {
      withTestFile: false,
    })
    writeSnippetSource(srcDir)

    const outcome = await createVarietyCases({ sourceRoot: srcDir }).catch(
      (cause: unknown) => cause,
    )
    expect(outcome).toBeInstanceOf(Error)
    if (!(outcome instanceof Error)) {
      throw new Error("expected createVarietyCases to reject with an Error")
    }
    expect(outcome.message).toBe(
      `auto-variety: unable to read ${path.join(testsDir, "request-auth.test.ts")}`,
    )
  })

  test("throws when both the snippet source and context files are missing", async () => {
    const emptyDir = autoVarietyTempDir()
    const outcome = await createVarietyCases({
      sourceRoot: emptyDir,
    }).catch((cause: unknown) => cause)
    // 片段采样与上下文读取并发，任一失败即拒绝，绝无部分 case
    expect(outcome).toBeInstanceOf(Error)
  })
})
