import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createVarietyCases } from "../.agents/skills/copilot-backend-tester/scripts/auto-variety-prompts.mjs"
import { openProbeHistory } from "../src/lib/auto-probe-history"
import { createProbeCondition } from "../src/lib/auto-probe-prompts"

const varietyCases = await createVarietyCases()
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
  condition_id: string
  tier: string
  status: number | null
  attempts: number
  selected_model: string | null
  models: Array<string>
  supported_endpoints: Array<string> | null
  hydra_scores: Record<string, number> | null
  discounted_costs: Record<string, number> | null
  source?: VarietySource
  sources?: Array<VarietySource>
  prompt_sha256?: string
  error?: string
}

interface VarietyOutput {
  observed_at: string
  proxy_url: string
  upstream: string
  instance_id: string
  history_writer?: string
  account: string
  account_source: string
  complete: boolean
  stop_reason: string | null
  identity_halt: boolean
  auto_requests: number
  generation_requests: number
  results: Array<VarietyResult>
  observed_models: Array<string>
  expected_cases: number
  coverage: {
    wanted: Array<string>
    observed: Array<string>
    missing: Array<string>
    extra: Array<string>
  }
  generation_observations: Array<Record<string, unknown>>
  date_comparison: {
    previous_date: string
    today: string
    conditions: Array<{
      condition_id: string
      previous_models: Array<string>
      today_models: Array<string>
      added: Array<string>
      removed: Array<string>
      changed: boolean | null
      previous_outcome: string
      today_outcome: string
    }>
  }
}

interface CliRun {
  exitCode: number
  stdout: string
  stderr: string
  record: RecordFile | null
  upstreamBase: string
  proxyUrl: string
  homeDir: string
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

const runVarietyCli = (
  args: Array<string>,
  scenario: string,
  options: { homeDir?: string; proxyUrl?: string } = {},
): CliRun => {
  const tempDir = options.homeDir ?? autoVarietyTempDir()
  const recordPath = path.join(tempDir, "record.json")
  const upstreamBase = `http://127.0.0.1:${randomLocalPort()}`
  const proxyUrl = options.proxyUrl ?? `http://127.0.0.1:${randomLocalPort()}`
  const configPath = path.join(tempDir, "config.json")
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        autoDiscovery: { models: ["gpt-5.1-codex", "wanted-but-missing"] },
      }),
    )
  }
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
    homeDir: tempDir,
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
  test("runs shared and real-source cases with scores, coverage and sanitized output", () => {
    const run = runVarietyCli(["--variety"], "ok")
    expect(run.exitCode).toBe(0)
    const output = parseOutput(run)
    const expected = varietyCases.length

    expect(output.expected_cases).toBe(expected)
    expect(expected).toBeGreaterThan(12)
    expect(output.complete).toBe(true)
    expect(output.stop_reason).toBeNull()
    expect(output.account).toBe("individual")
    expect(output.account_source).toBe("expectation")
    expect(output.proxy_url).toBe(run.proxyUrl)
    expect(output.upstream).toBe(run.upstreamBase)
    expect(output.instance_id).toBe(`listen-${new URL(run.proxyUrl).port}`)
    expect(output.auto_requests).toBe(expected)
    expect(
      new Set(output.results.map((result) => result.condition_id)).size,
    ).toBe(expected)
    expect(output.generation_requests).toBe(0)
    expect(output.results).toHaveLength(expected)
    expect(output.results[0]?.prompt_id).toBe("intelligence-verified")
    expect(output.results[0]?.tier).toBe("intelligence")
    for (const result of output.results) {
      expect(result.status).toBe(200)
      expect(result.attempts).toBe(1)
      expect(typeof result.selected_model).toBe("string")
      expect(result.hydra_scores).toEqual({
        code_gen: 0.5,
        debugging: 0.25,
        reasoning: 0.75,
        tool_use: 0.125,
      })
      expect(result.discounted_costs).toEqual({
        [result.selected_model ?? ""]: 0.1,
      })
    }

    const requests = run.record?.requests ?? []
    expect(requests).toHaveLength(expected + 1)
    expect(
      requests.filter((request) => request.url === EXCHANGE_URL),
    ).toHaveLength(1)
    const autoRequests = requests.filter(
      (request) => request.url === `${run.upstreamBase}/auto`,
    )
    expect(autoRequests).toHaveLength(expected)
    for (const request of autoRequests) {
      expect(request.headers["openai-intent"]).toBe("model-access")
      expect(request.headers["x-interaction-type"]).toBe("model-access")
      expect(request.headers["x-request-id"]).toBe(
        request.headers["x-agent-task-id"],
      )
    }

    const bodies = autoBodies(run)
    const hardResults = output.results.filter((result) =>
      result.prompt_id.startsWith("hard-"),
    )
    expect(hardResults).toHaveLength(4)
    for (const result of hardResults) {
      const body = bodies[output.results.indexOf(result)]
      const source = result.source
      if (!source || !body) throw new Error("missing hard source or request")
      expect(source.lineCount).toBe(100)
      expect(path.isAbsolute(source.file)).toBe(false)
      expect(body.prompt.startsWith(sourceText(source))).toBe(true)
    }

    const taskResults = output.results.filter((result) =>
      result.prompt_id.startsWith("task-"),
    )
    expect(taskResults).toHaveLength(4)
    for (const result of taskResults) {
      const sources = result.sources
      const body = bodies[output.results.indexOf(result)]
      if (!sources || !body) throw new Error("missing task sources or request")
      expect(sources.map((entry) => entry.file)).toEqual([
        ...TASK_CONTEXT_FILES,
      ])
      for (const source of sources) {
        const text = fs.readFileSync(path.join(cwd, source.file), "utf8")
        expect(source.lineCount).toBe(lineCountOf(text))
        expect(body.prompt).toContain(text)
      }
    }
    for (const [index, result] of output.results.entries()) {
      expect(result.prompt_sha256).toBe(sha256Hex(bodies[index]?.prompt ?? ""))
    }

    expect(new Set(output.results.map((result) => result.tier))).toEqual(
      new Set(ALL_TIERS),
    )
    expect(output.observed_models).toContain("unknown-exp-model-9")
    expect(output.coverage.wanted).toEqual([
      "gpt-5.1-codex",
      "wanted-but-missing",
    ])
    expect(output.coverage.observed).toEqual(output.observed_models)
    expect(output.coverage.missing).toEqual(["wanted-but-missing"])
    expect(output.coverage.extra).toContain("unknown-exp-model-9")
    expect(output.history_writer).toMatch(/^tester-/)
    for (const stream of [run.stdout, run.stderr]) {
      expect(stream).not.toContain(FIXTURE_GITHUB_TOKEN)
      expect(stream).not.toContain(FIXTURE_SESSION_TOKEN)
      for (const body of bodies) expect(stream).not.toContain(body.prompt)
    }
  })

  test("omitted supported_endpoints does not truncate current observations", () => {
    const run = runVarietyCli(["--variety"], "noEndpoints")
    const output = parseOutput(run)
    expect(run.exitCode).toBe(0)
    expect(output.complete).toBe(true)
    expect(output.results).toHaveLength(varietyCases.length)
    for (const result of output.results) {
      expect(result.supported_endpoints).toBeNull()
      expect(typeof result.selected_model).toBe("string")
    }
  })

  test("missing generation endpoints retain a specific error and valid selection", () => {
    const run = runVarietyCli(["--variety", "--with-inference"], "noEndpoints")
    const output = parseOutput(run)
    expect(run.exitCode).toBe(1)
    expect(output.complete).toBe(false)
    expect(output.stop_reason).toBe("generation_error")
    expect(output.auto_requests).toBe(1)
    expect(output.generation_requests).toBe(0)
    expect(output.results[0]?.selected_model).toBe("gpt-5.1-codex")
    expect(output.results[0]?.error).toBe("unsupported_generation_endpoint")
    expect(output.generation_observations[0]).toMatchObject({
      accepted: false,
      error: "no_supported_endpoint",
    })
  })

  for (const scenario of ["http401", "http403"] as const) {
    test(`${scenario} halts identity without retrying`, () => {
      const run = runVarietyCli(["--variety"], scenario)
      const output = parseOutput(run)
      expect(run.exitCode).toBe(1)
      expect(output.complete).toBe(false)
      expect(output.stop_reason).toBe("identity_halt")
      expect(output.identity_halt).toBe(true)
      expect(output.auto_requests).toBe(1)
      expect(output.results).toHaveLength(1)
      expect(output.results[0]?.attempts).toBe(1)
    })
  }

  test("HTTP 429 uses one bounded retry and remains a failure", () => {
    const run = runVarietyCli(["--variety"], "http429")
    const output = parseOutput(run)
    expect(run.exitCode).toBe(1)
    expect(output.stop_reason).toBe("http_429")
    expect(output.identity_halt).toBe(false)
    expect(output.auto_requests).toBe(2)
    expect(output.results).toHaveLength(1)
    expect(output.results[0]?.attempts).toBe(2)
  })

  test("token exchange failure preserves status and sends no selection", () => {
    const run = runVarietyCli(["--variety"], "auth403")
    const output = parseOutput(run)
    expect(output.stop_reason).toBe("http_403")
    expect(output.auto_requests).toBe(0)
    expect(output.results).toHaveLength(0)
    expect(run.record?.responses).toEqual([{ url: EXCHANGE_URL, status: 403 }])
  })

  for (const scenario of [
    "malformed",
    "emptyId",
    "badEndpointsNull",
    "badEndpointsString",
    "badEndpointsArray",
  ] as const) {
    test(`${scenario} is not reported as a successful selection`, () => {
      const run = runVarietyCli(["--variety"], scenario)
      const output = parseOutput(run)
      expect(run.exitCode).toBe(1)
      expect(output.stop_reason).toBe("malformed_model")
      expect(output.auto_requests).toBe(1)
      expect(output.results[0]?.selected_model).toBeNull()
      expect(output.results[0]?.models).toEqual([])
      expect(run.stdout).not.toContain(FIXTURE_SESSION_TOKEN)
    })
  }

  test("deadline aborts the in-flight selection and sends nothing further", () => {
    const run = runVarietyCli(["--variety"], "hang")
    const output = parseOutput(run)
    expect(run.elapsedMs).toBeLessThan(20_000)
    expect(output.stop_reason).toBe("deadline")
    expect(output.auto_requests).toBe(1)
    expect(output.results[0]?.error).toBe("AbortError")
    expect(run.record?.requests).toHaveLength(2)
  })
  test("rejects reflected prompt text inside discounted costs before reporting", () => {
    const run = runVarietyCli(["--variety"], "badDiscountedCosts")
    const output = parseOutput(run)
    expect(run.exitCode).toBe(1)
    expect(output.stop_reason).toBe("malformed_model")
    expect(output.results[0]?.models).toEqual([])
    const prompt = autoBodies(run)[0]?.prompt
    if (typeof prompt !== "string")
      throw new Error("missing actual selection prompt")
    expect(run.stdout).not.toContain(prompt)
    expect(run.stderr).not.toContain(prompt)
  })

  test("interval deadline retains current selection coverage", () => {
    const run = runVarietyCli(
      ["--variety", "--interval-ms", "60000"],
      "intervalHang",
    )
    const output = parseOutput(run)
    expect(run.elapsedMs).toBeLessThan(20_000)
    expect(output.stop_reason).toBe("deadline")
    expect(output.auto_requests).toBe(1)
    expect(output.results).toHaveLength(1)
    expect(output.observed_models).toEqual(output.results[0]?.models)
    expect(output.coverage.observed).toEqual(output.results[0]?.models)
    expect(output.date_comparison.conditions[0]?.today_outcome).toBe("selected")
  })

  test("request budget bounds the run and repeat multiplies planned conditions", () => {
    const run = runVarietyCli(
      ["--variety", "--repeat", "2", "--max-requests", "3"],
      "ok",
    )
    const output = parseOutput(run)
    expect(run.exitCode).toBe(1)
    expect(output.expected_cases).toBe(varietyCases.length * 2)
    expect(output.auto_requests).toBe(3)
    expect(output.results).toHaveLength(3)
    expect(output.stop_reason).toBe("request_budget")
  })

  test("dated replay sends the saved prompt and measures generation rates separately", async () => {
    const homeDir = autoVarietyTempDir()
    const proxyUrl = `http://127.0.0.1:${randomLocalPort()}`
    const instanceId = `listen-${new URL(proxyUrl).port}`
    const root = path.join(homeDir, "probe-history")
    const condition = createProbeCondition({
      source: "auto",
      tier: "balance",
      prompt: "Replay this exact prompt without replacement.",
    })
    const previousDate = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10)
    const history = await openProbeHistory({
      instanceId,
      writer: "tester-previous",
      root,
    })
    await history.record({
      condition,
      observedAt: `${previousDate}T12:00:00.000Z`,
      outcome: "selected",
      modelIds: ["gpt-old"],
    })
    await history.flush()

    const run = runVarietyCli(
      ["--replay-date", previousDate, "--repeat", "2", "--with-inference"],
      "autoInference",
      { homeDir, proxyUrl },
    )
    const output = parseOutput(run)
    expect(run.exitCode).toBe(0)
    expect(output.complete).toBe(true)
    expect(output.expected_cases).toBe(2)
    expect(output.auto_requests).toBe(2)
    expect(output.generation_requests).toBe(4)
    expect(autoBodies(run).map((body) => body.prompt)).toEqual([
      condition.prompt,
      condition.prompt,
    ])
    expect(output.results.map((result) => result.condition_id)).toEqual([
      condition.id,
      condition.id,
    ])
    expect(output.date_comparison.previous_date).toBe(previousDate)
    expect(output.date_comparison.conditions[0]).toMatchObject({
      condition_id: condition.id,
      previous_models: ["gpt-old"],
      today_models: ["gpt-5.1-codex"],
      added: ["gpt-5.1-codex"],
      removed: ["gpt-old"],
      changed: true,
    })
    expect(output.observed_models).not.toContain("gpt-old")
    expect(output.generation_observations).toHaveLength(2)
    expect(output.generation_observations[0]).toMatchObject({
      model_id: "gpt-5.1-codex",
      accepted: true,
      control_accepted: true,
      expected_discount_percent: 10,
    })
    expect(
      output.generation_observations[0].measured_discount_percent,
    ).toBeCloseTo(10, 10)

    const generations = (run.record?.requests ?? []).filter(
      (request) => request.url === `${run.upstreamBase}/chat/completions`,
    )
    expect(generations).toHaveLength(4)
    for (let index = 0; index < generations.length; index += 2) {
      expect(generations[index]?.body).toEqual(generations[index + 1]?.body)
      expect(generations[index]?.body).toMatchObject({
        model: "gpt-5.1-codex",
        max_tokens: 64,
      })
      expect(generations[index]?.headers["copilot-session-token"]).toBe(
        FIXTURE_SESSION_TOKEN,
      )
      expect(
        generations[index + 1]?.headers["copilot-session-token"],
      ).toBeUndefined()
    }
    expect(output.history_writer).not.toBe("tester-previous")
    const writerRoot = path.join(root, instanceId, output.history_writer ?? "")
    const conditionsText = fs.readFileSync(
      path.join(writerRoot, "conditions.json"),
      "utf8",
    )
    expect(conditionsText).toContain(condition.prompt)
    expect(conditionsText).not.toContain(FIXTURE_SESSION_TOKEN)
    expect(run.stdout).not.toContain(condition.prompt)
    expect(run.stdout).not.toContain(FIXTURE_SESSION_TOKEN)
  })

  test("budget-limited replay marks unprobed history instead of reporting model loss", async () => {
    const homeDir = autoVarietyTempDir()
    const proxyUrl = `http://127.0.0.1:${randomLocalPort()}`
    const instanceId = `listen-${new URL(proxyUrl).port}`
    const root = path.join(homeDir, "probe-history")
    const previousDate = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10)
    const conditions = ["first", "second"].map((name) =>
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: `Replay ${name} exact prompt`,
      }),
    )
    const history = await openProbeHistory({
      instanceId,
      writer: "tester-previous",
      root,
    })
    for (const condition of conditions) {
      await history.record({
        condition,
        observedAt: `${previousDate}T12:00:00.000Z`,
        outcome: "selected",
        modelIds: [`old-${condition.prompt}`],
      })
    }
    await history.flush()

    const run = runVarietyCli(
      ["--replay-date", previousDate, "--max-requests", "1"],
      "ok",
      { homeDir, proxyUrl },
    )
    const output = parseOutput(run)
    expect(output.expected_cases).toBe(2)
    expect(output.auto_requests).toBe(1)
    expect(output.stop_reason).toBe("request_budget")
    const unprobed = output.date_comparison.conditions.find(
      (entry) => entry.today_outcome === "not_observed",
    )
    expect(unprobed).toMatchObject({
      previous_outcome: "selected",
      changed: null,
      added: [],
      removed: [],
      today_models: [],
    })
  })

  for (const extraArgs of [
    ["--prompt", "hello"],
    ["--tier", "fast"],
    ["--show-headers"],
  ] as const) {
    test(`--variety rejects ${extraArgs[0]} before any network`, () => {
      const run = runVarietyCli(["--variety", ...extraArgs], "ok")
      expect(run.exitCode).not.toBe(0)
      expect(run.record?.requests).toHaveLength(0)
    })
  }

  test("--help exits without authentication", () => {
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

    const cases = await createVarietyCases({
      sourceRoot: srcDir,
      includeShared: false,
    })
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
    }
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
