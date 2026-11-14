import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createVarietyCases } from "../.agents/skills/copilot-backend-tester/scripts/auto-variety-prompts.mjs"
import { openProbeHistory } from "../src/lib/auto-probe-history"
import {
  createProbeCondition,
  getProbeConditions,
  HARD_QUESTION,
} from "../src/lib/auto-probe-prompts"

const varietyCases = await createVarietyCases()
const fusionPrompts = [
  ...new Set(varietyCases.map((varietyCase) => varietyCase.prompt)),
]
const runtimeSeedPrompts = [
  ...new Set(
    getProbeConditions()
      .filter(
        (condition) =>
          condition.source === "fusion" && condition.planVersion === "2",
      )
      .map((condition) => condition.prompt),
  ),
].slice(0, 4)

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

interface FusionResult {
  prompt_id: string
  condition_id: string
  plan_version: string
  status: number | null
  attempts: number
  selected_model: string | null
  models: Array<string>
  steps: Array<{ model_id: string; role?: string }>
  fusion_pattern: string | null
  expires_at: string | null
  hydra_scores: Record<string, number> | null
  prompt_sha256: string
  error?: string
  source?: { file: string; startLine: number; lineCount: number }
}

interface FusionOutput {
  source: string
  proxy_url: string
  upstream: string | null
  instance_id: string
  history_writer?: string
  account: string
  account_source: string
  complete: boolean
  stop_reason: string | null
  identity_halt: boolean
  fusion_requests: number
  generation_requests: number
  results: Array<FusionResult>
  observed_models: Array<string>
  expected_cases: number
  plan_versions: Array<string>
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
  requests: Array<RecordedRequest>
  upstreamBase: string
  proxyUrl: string
  homeDir: string
  elapsedMs: number
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const cliPath = path.join(
  cwd,
  ".agents/skills/copilot-backend-tester/scripts/test-fusion-select.mjs",
)
const preloadPath = path.join(
  cwd,
  "tests/fixtures/backend-auto-variety-preload.ts",
)
const fixtureGithubToken = "fake-github-token-for-fusion-tests"
const fixtureSessionToken = "fake-session-token-for-variety-tests"
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

const randomLocalPort = (): number =>
  40_000 + Math.floor(Math.random() * 20_000)

const fusionTempDir = (): string => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backend-fusion-"))
  tempDirs.push(tempDir)
  return tempDir
}

const runFusionCli = (
  args: Array<string>,
  scenario: string,
  options: { homeDir?: string; proxyUrl?: string } = {},
): CliRun => {
  const tempDir = options.homeDir ?? fusionTempDir()
  const recordPath = path.join(tempDir, "record.json")
  const upstreamBase = `http://127.0.0.1:${randomLocalPort()}`
  const proxyUrl = options.proxyUrl ?? `http://127.0.0.1:${randomLocalPort()}`
  const configPath = path.join(tempDir, "config.json")
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        autoDiscovery: { models: ["gpt-5.6-sol", "wanted-but-missing"] },
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
      COPILOT_API_GITHUB_TOKEN: fixtureGithubToken,
      BACKEND_AUTO_VARIETY_RECORD: recordPath,
      BACKEND_AUTO_VARIETY_SCENARIO: scenario,
      BACKEND_AUTO_VARIETY_UPSTREAM_PORT: upstreamBase.replace(
        "http://127.0.0.1:",
        "",
      ),
    },
  })
  const requests =
    fs.existsSync(recordPath) ?
      (
        JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
          requests: Array<RecordedRequest>
        }
      ).requests
    : []
  return {
    exitCode: result.exitCode ?? -1,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
    requests,
    upstreamBase,
    proxyUrl,
    homeDir: tempDir,
    elapsedMs: Date.now() - startedAt,
  }
}

const parseOutput = (run: CliRun): FusionOutput =>
  JSON.parse(run.stdout) as FusionOutput

const fusionBodies = (run: CliRun): Array<Record<string, unknown>> =>
  run.requests
    .filter((request) => request.url === `${run.upstreamBase}/model/fusion`)
    .map((request) => request.body as Record<string, unknown>)

const expectSanitized = (run: CliRun): void => {
  expect(run.stdout).not.toContain(fixtureGithubToken)
  expect(run.stdout).not.toContain(fixtureSessionToken)
  expect(run.stderr).not.toContain(fixtureSessionToken)
  for (const body of fusionBodies(run)) {
    if (typeof body.prompt === "string") {
      expect(run.stdout).not.toContain(body.prompt)
      expect(run.stderr).not.toContain(body.prompt)
    }
  }
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

describe("backend Fusion variety CLI", () => {
  test("v2 sends the merged shared profile and reports solo scores", () => {
    const run = runFusionCli(["--plan-version", "2"], "fusionOk")
    const output = parseOutput(run)
    expect(run.exitCode).toBe(0)
    expect(output.complete).toBe(true)
    expect(output.expected_cases).toBe(fusionPrompts.length)
    expect(output.fusion_requests).toBe(fusionPrompts.length)
    expect(output.results).toHaveLength(fusionPrompts.length)
    expect(
      new Set(output.results.map((result) => result.condition_id)).size,
    ).toBe(fusionPrompts.length)
    expect(output.plan_versions).toEqual(["2"])
    expect(output.observed_models).toEqual([
      "gpt-5.6-sol",
      "gpt-6-luna",
      "gpt-6-sol",
    ])
    expect(output.coverage.missing).toEqual(["wanted-but-missing"])
    expect(output.coverage.extra).toEqual(["gpt-6-luna", "gpt-6-sol"])
    expect(run.requests).toHaveLength(fusionPrompts.length + 1)

    const bodies = fusionBodies(run)
    for (const [index, body] of bodies.entries()) {
      const result = output.results[index]
      expect(body).toMatchObject({
        fusion_mode: "hydrafusion",
        plan_version: "2",
      })
      expect(result?.status).toBe(200)
      expect(result?.fusion_pattern).toBe("solo")
      expect(result?.steps).toHaveLength(1)
      if (result?.selected_model == null) throw new Error("missing v2 model")
      expect(result.models).toEqual([result.selected_model])
      expect(result?.hydra_scores).toEqual({
        code_gen: 0.595,
        debugging: 0.024,
        reasoning: 0.4154,
        tool_use: 0.2693,
      })
      expect(result?.prompt_sha256).toBe(
        createHash("sha256").update(String(body.prompt)).digest("hex"),
      )
      const source = result?.source
      if (source) {
        const sourceText = fs
          .readFileSync(path.join(cwd, source.file), "utf8")
          .split("\n")
          .slice(source.startLine, source.startLine + source.lineCount)
          .join("\n")
        expect(body.prompt).toBe(`${sourceText}\n\n${HARD_QUESTION}`)
      }
    }
    expectSanitized(run)
  })

  test("both versions share one budget and v1 preserves every ordered repeated role", () => {
    const run = runFusionCli([], "fusionOk")
    const output = parseOutput(run)
    expect(run.exitCode).toBe(0)
    expect(output.plan_versions).toEqual(["1", "2"])
    expect(output.expected_cases).toBe(fusionPrompts.length * 2)
    expect(output.fusion_requests).toBe(fusionPrompts.length * 2)
    expect(
      new Set(output.results.map((result) => result.condition_id)).size,
    ).toBe(fusionPrompts.length * 2)
    const v1 = output.results.filter((result) => result.plan_version === "1")
    const v2 = output.results.filter((result) => result.plan_version === "2")
    expect(v1).toHaveLength(fusionPrompts.length)
    expect(v2).toHaveLength(fusionPrompts.length)
    for (const result of v1) {
      expect(result.fusion_pattern).toBe("cascade")
      expect(result.selected_model).toBeNull()
      expect(result.steps).toEqual([
        { model_id: "gpt-6-luna", role: "draft" },
        { model_id: "gpt-6.1-sol", role: "escalation" },
        { model_id: "gpt-6-luna", role: "revision" },
      ])
      expect(result.models).toEqual(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-luna"])
    }
    expect(output.observed_models).toContain("gpt-6.1-sol")
    expect(fusionBodies(run)[0]?.plan_version).toBe("1")
    expect(fusionBodies(run)[1]?.plan_version).toBe("2")
    expectSanitized(run)
  })

  test("runtime seeds come from shared conditions", () => {
    const run = runFusionCli(
      ["--plan-version", "2", "--runtime-seeds"],
      "fusionOk",
    )
    const output = parseOutput(run)
    expect(run.exitCode).toBe(0)
    expect(output.expected_cases).toBe(4)
    expect(output.results.map((result) => result.prompt_id)).toEqual([
      "seed:0",
      "seed:1",
      "seed:2",
      "seed:3",
    ])
    for (const [index, body] of fusionBodies(run).entries()) {
      expect(body).toEqual({
        prompt: runtimeSeedPrompts[index],
        fusion_mode: "hydrafusion",
        plan_version: "2",
      })
    }
  })

  test("dated v1 replay generates once per ordered step with a no-token control", async () => {
    const homeDir = fusionTempDir()
    const proxyUrl = `http://127.0.0.1:${randomLocalPort()}`
    const instanceId = `listen-${new URL(proxyUrl).port}`
    const root = path.join(homeDir, "probe-history")
    const condition = createProbeCondition({
      source: "fusion",
      planVersion: "1",
      fusionMode: "hydrafusion",
      prompt: "Replay the complete v1 plan without executing its cascade text.",
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
    await history.record({
      condition: createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "Other source historical prompt",
      }),
      observedAt: `${previousDate}T12:00:00.000Z`,
      outcome: "selected",
      modelIds: ["auto-only-historical"],
    })
    await history.flush()

    const run = runFusionCli(
      ["--replay-date", previousDate, "--with-inference"],
      "fusionInference",
      { homeDir, proxyUrl },
    )
    const output = parseOutput(run)
    expect(run.exitCode).toBe(0)
    expect(output.complete).toBe(true)
    expect(output.expected_cases).toBe(1)
    expect(output.fusion_requests).toBe(1)
    expect(output.generation_requests).toBe(6)
    expect(fusionBodies(run)[0]?.prompt).toBe(condition.prompt)
    expect(output.results[0]?.steps.map((step) => step.role)).toEqual([
      "draft",
      "escalation",
      "revision",
    ])
    expect(output.generation_observations.map((row) => row.model_id)).toEqual([
      "gpt-6-luna",
      "gpt-6.1-sol",
      "gpt-6-luna",
    ])
    expect(output.generation_observations.map((row) => row.step_index)).toEqual(
      [0, 1, 2],
    )
    for (const observation of output.generation_observations) {
      expect(observation).toMatchObject({
        accepted: true,
        control_accepted: true,
        expected_discount_percent: 30,
      })
      expect(observation.measured_discount_percent).toBeCloseTo(30, 10)
    }
    expect(output.date_comparison.conditions[0]).toMatchObject({
      condition_id: condition.id,
      previous_models: ["gpt-old"],
      changed: true,
    })
    expect(output.date_comparison.conditions).toHaveLength(1)

    const generations = run.requests.filter(
      (request) => request.url === `${run.upstreamBase}/responses`,
    )
    expect(generations).toHaveLength(6)
    for (let index = 0; index < generations.length; index += 2) {
      const withToken = generations[index]
      const control = generations[index + 1]
      expect(withToken?.body).toEqual(control?.body)
      expect(withToken?.body).toMatchObject({
        input: "Reply with exactly: hi",
        max_output_tokens: 64,
      })
      expect(withToken?.headers["copilot-session-token"]).toBe(
        fixtureSessionToken,
      )
      expect(control?.headers["copilot-session-token"]).toBeUndefined()
    }
    expect(output.history_writer).not.toBe("tester-previous")
    const persisted = fs.readFileSync(
      path.join(
        root,
        instanceId,
        output.history_writer ?? "",
        "conditions.json",
      ),
      "utf8",
    )
    expect(persisted).toContain(condition.prompt)
    expect(persisted).not.toContain(fixtureSessionToken)
    expectSanitized(run)
  })

  test("generation 401 stops before the control and preserves selection history", () => {
    const run = runFusionCli(
      ["--plan-version", "2", "--with-inference"],
      "generation401",
    )
    const output = parseOutput(run)
    expect(run.exitCode).toBe(1)
    expect(output.complete).toBe(false)
    expect(output.stop_reason).toBe("identity_halt")
    expect(output.identity_halt).toBe(true)
    expect(output.fusion_requests).toBe(1)
    expect(output.generation_requests).toBe(1)
    expect(output.results).toHaveLength(1)
    expect(output.generation_observations[0]).toMatchObject({
      accepted: false,
      control_accepted: null,
      with_token_status: 401,
      without_token_status: null,
      measured_discount_percent: null,
    })
    const today = output.date_comparison.today
    const runHistory = fs.readFileSync(
      path.join(
        run.homeDir,
        "probe-history",
        output.instance_id,
        output.history_writer ?? "",
        "runs",
        `${today}.jsonl`,
      ),
      "utf8",
    )
    expect(runHistory).toContain('"outcome":"selected"')
    expect(runHistory).not.toContain(fixtureSessionToken)
    expectSanitized(run)
  })

  test("generation HTTP failure is visible and prevents later conditions", () => {
    const run = runFusionCli(
      ["--plan-version", "2", "--with-inference"],
      "generation400",
    )
    const output = parseOutput(run)
    expect(run.exitCode).toBe(1)
    expect(output.complete).toBe(false)
    expect(output.stop_reason).toBe("generation_failed")
    expect(output.fusion_requests).toBe(1)
    expect(output.generation_requests).toBe(2)
    expect(output.results).toHaveLength(1)
    expect(output.generation_observations[0]).toMatchObject({
      accepted: false,
      control_accepted: true,
      with_token_status: 400,
      without_token_status: 200,
      expected_discount_percent: 30,
      measured_discount_percent: null,
    })
    expectSanitized(run)
  })

  test("a shared request budget covers both plan versions", () => {
    const run = runFusionCli(["--max-requests", "3"], "fusionOk")
    const output = parseOutput(run)
    expect(run.exitCode).toBe(1)
    expect(output.expected_cases).toBe(fusionPrompts.length * 2)
    expect(output.fusion_requests).toBe(3)
    expect(output.results).toHaveLength(3)
    expect(output.stop_reason).toBe("request_budget")
  })

  for (const scenario of ["fusionHttp401", "fusionHttp403"] as const) {
    test(`${scenario} halts identity without retries`, () => {
      const run = runFusionCli([], scenario)
      const output = parseOutput(run)
      expect(run.exitCode).toBe(1)
      expect(output.stop_reason).toBe("identity_halt")
      expect(output.identity_halt).toBe(true)
      expect(output.fusion_requests).toBe(1)
      expectSanitized(run)
    })
  }

  test("Fusion HTTP 429 retries once and does not report success", () => {
    const run = runFusionCli([], "fusionHttp429")
    const output = parseOutput(run)
    expect(run.exitCode).toBe(1)
    expect(output.stop_reason).toBe("http_429")
    expect(output.fusion_requests).toBe(2)
    expect(output.results[0]?.attempts).toBe(2)
    expectSanitized(run)
  })

  for (const scenario of [
    "fusionMalformed",
    "fusionEmptyModel",
    "fusionInvalidJson",
  ] as const) {
    test(`${scenario} is rejected before recording a model`, () => {
      const run = runFusionCli([], scenario)
      const output = parseOutput(run)
      expect(run.exitCode).toBe(1)
      expect(output.stop_reason).toBe("malformed_model")
      expect(output.results[0]?.models).toEqual([])
      expect(output.observed_models).toEqual([])
      expectSanitized(run)
    })
  }

  test("token exchange failure sends no Fusion selection", () => {
    const run = runFusionCli([], "auth403")
    const output = parseOutput(run)
    expect(output.stop_reason).toBe("http_403")
    expect(output.upstream).toBeNull()
    expect(output.fusion_requests).toBe(0)
    expect(output.results).toEqual([])
    expectSanitized(run)
  })

  test("deadline aborts a hung Fusion response", () => {
    const run = runFusionCli([], "hang")
    const output = parseOutput(run)
    expect(output.stop_reason).toBe("deadline")
    expect(output.fusion_requests).toBe(1)
    expect(output.results[0]?.error).toBe("AbortError")
    expect(run.elapsedMs).toBeLessThan(5_000)
    expectSanitized(run)
  })
})
