// Probe POST /auto (VS Code Auto V2 path): one-shot model selection.
// Returns selected_model, session_token, expires_at, discounted_costs
// and hydra_scores in a single response.
//
// The shared auth module reads the X-GitHub-Api-Version value from
// src/lib/api-config.ts at runtime, so upstream version bumps never require
// edits here.
//
// --variety runs the fixed 12-case model-variety probe: one POST /auto per
// case, sequential, no retries, a single 60s AbortSignal spanning token
// exchange and all requests, and exactly one sanitized JSON report on stdout.
//
// Identity headers (EDITOR_DEVICE_ID, VSCODE_SESSION_ID, VSCODE_MACHINE_ID)
// can be pinned via environment variables for controlled A/B probing;
// fresh synthetic UUIDs are generated per run otherwise.
//
// Run: bun .agents/skills/copilot-backend-tester/scripts/test-auto-select.mjs [options]

import { join } from "node:path"

import { copilotAuthInit, copilotCommonHeaders } from "./copilot-auth.mjs"
import { createVarietyCases } from "./auto-variety-prompts.mjs"
import { missingValue, printBody, printHeaders } from "./probe-common.mjs"

const DEFAULT_PROMPT =
  "Write a TypeScript function that normalizes URL paths, with tests for root, duplicate slashes, and trailing slashes."
const ALL_TIERS = ["efficiency", "balance", "intelligence", "fast"]
const VARIETY_CASE_COUNT = 12
const VARIETY_TIMEOUT_MS = 60_000
const VARIETY_SOURCE_ROOT = join(import.meta.dirname, "../../../../src")

const HELP_TEXT = `Usage: test-auto-select.mjs [options]

Probes POST /auto on the upstream returned by token exchange.

Options:
  --proxy-url <url>    Local proxy URL to borrow credentials from (default: http://localhost:4141)
  --business           Expect a business account upstream (api.business.githubcopilot.com)
  --tier <name>        efficiency | balance | intelligence | fast | all (default: balance)
  --prompt <text>      Prompt used for model selection
  --with-inference     Also send a minimal request to the selected model's first
                       non-websocket endpoint using the same session token.
                       This performs real billed generation.
  --variety            Run the fixed 12-case variety probe: one POST /auto per case,
                       sequential, no retries, whole run capped at 60s, with a single
                       sanitized JSON report on stdout. Mutually exclusive with
                       --prompt, --tier, --with-inference and --show-headers.
  --show-headers       Print sanitized response headers
  -h, --help           Show this help

Environment:
  EDITOR_DEVICE_ID     Pin the editor device identity (default: synthetic UUID per run)
  VSCODE_SESSION_ID    Pin the VS Code session identity (default: synthetic UUID per run)
  VSCODE_MACHINE_ID    Pin the VS Code machine identity (default: synthetic UUID per run)`

function parseArgs(argv) {
  const options = {
    proxyUrl: process.env.COPILOT_PROXY_URL ?? "http://localhost:4141",
    business: false,
    tier: "balance",
    tierExplicit: false,
    prompt: DEFAULT_PROMPT,
    promptExplicit: false,
    withInference: false,
    showHeaders: false,
    variety: false,
  }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--proxy-url":
        options.proxyUrl = argv[++i] ?? missingValue("--proxy-url")
        break
      case "--business":
        options.business = true
        break
      case "--tier": {
        const value = argv[++i] ?? missingValue("--tier")
        if (ALL_TIERS.includes(value) || value === "all") {
          options.tier = value
          options.tierExplicit = true
        } else {
          throw new Error(`Unknown tier: ${value} (expected ${ALL_TIERS.join("|")}|all)`)
        }
        break
      }
      case "--prompt":
        options.prompt = argv[++i] ?? missingValue("--prompt")
        options.promptExplicit = true
        break
      case "--with-inference":
        options.withInference = true
        break
      case "--variety":
        options.variety = true
        break
      case "--show-headers":
        options.showHeaders = true
        break
      case "-h":
      case "--help":
        console.error(HELP_TEXT)
        process.exit(0)
      default:
        throw new Error(`Unknown option: ${argv[i]}`)
    }
  }

  if (options.variety) {
    const conflicts = []
    if (options.promptExplicit) conflicts.push("--prompt")
    if (options.tierExplicit) conflicts.push("--tier")
    if (options.withInference) conflicts.push("--with-inference")
    if (options.showHeaders) conflicts.push("--show-headers")
    if (conflicts.length > 0) {
      throw new Error(`--variety is mutually exclusive with ${conflicts.join(", ")}`)
    }
  }

  return options
}

function printSummary(tier, body) {
  const model = body?.selected_model
  const summary = {
    tier,
    selected_model: model?.id ?? null,
    vendor: model?.vendor ?? null,
    supported_endpoints: model?.supported_endpoints ?? null,
    limits: model?.capabilities?.limits ?? null,
    discounted_costs: body?.discounted_costs ?? null,
    multi_turn_mode: body?.multi_turn_mode ?? null,
    expires_at:
      typeof body?.expires_at === "number"
        ? new Date(body.expires_at * 1000).toISOString()
        : null,
    hydra_scores: body?.hydra_scores ?? null,
  }
  console.log("--- Summary ---")
  console.log(JSON.stringify(summary, null, 2))
  console.log()
}

// Replace any exact occurrence of the prompt in a printable request body with
// a length note, so transcripts never carry source-code prompts.
function redactPrompt(value, prompt) {
  if (value === prompt) {
    return `<prompt: ${prompt.length} chars>`
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPrompt(item, prompt))
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactPrompt(item, prompt)]),
    )
  }
  return value
}

async function probeInference(ctx, sessionToken, modelId, endpoint) {
  let body
  if (endpoint.endsWith("/responses")) {
    body = { model: modelId, input: ctx.options.prompt, max_output_tokens: 64 }
  } else if (endpoint.endsWith("/chat/completions")) {
    body = {
      model: modelId,
      messages: [{ role: "user", content: ctx.options.prompt }],
      max_tokens: 64,
    }
  } else if (endpoint.endsWith("/messages")) {
    body = {
      model: modelId,
      max_tokens: 64,
      messages: [{ role: "user", content: ctx.options.prompt }],
    }
  } else {
    throw new Error(`Unsupported endpoint for inference: ${endpoint}`)
  }

  console.log(`=== Inference Request (${endpoint}) ===`)
  console.log(JSON.stringify(redactPrompt(body, ctx.options.prompt), null, 2))
  console.log()

  const response = await fetch(`${ctx.auth.base}${endpoint}`, {
    method: "POST",
    headers: {
      ...ctx.headers,
      "Copilot-Session-Token": sessionToken,
      "x-request-id": `${ctx.requestIdBase}-inference`,
    },
    body: JSON.stringify(body),
  })

  console.log(`=== Inference Response (HTTP ${response.status}) ===`)
  if (ctx.options.showHeaders) {
    printHeaders(response.headers)
    console.log()
  }
  printBody(await response.json())
  return response.ok
}

async function probeTier(ctx, tier) {
  const response = await fetch(`${ctx.auth.base}/auto`, {
    method: "POST",
    headers: {
      ...ctx.headers,
      "VScode-SessionId": ctx.vscodeSessionId,
      "VScode-MachineId": ctx.vscodeMachineId,
      "x-request-id": `${ctx.requestIdBase}-${tier}`,
    },
    body: JSON.stringify({ prompt: ctx.options.prompt, tier }),
  })

  const body = await response.json()

  console.log(`=== Tier: ${tier} (HTTP ${response.status}) ===`)
  if (ctx.options.showHeaders) {
    printHeaders(response.headers)
    console.log()
  }
  printBody(body)

  if (!response.ok) {
    return false
  }

  printSummary(tier, body)

  if (ctx.options.withInference) {
    const sessionToken = body?.session_token
    const modelId = body?.selected_model?.id
    const endpoint = body?.selected_model?.supported_endpoints?.find(
      (candidate) => !candidate.startsWith("ws:"),
    )
    if (!sessionToken || !modelId || !endpoint) {
      throw new Error(
        "--with-inference requires session_token, selected_model.id and a non-websocket endpoint",
      )
    }
    return await probeInference(ctx, sessionToken, modelId, endpoint)
  }

  return true
}

// Fail before any network when the case profile is unusable (construction
// error, wrong count, missing fields, or an unusable source reference).
function validateVarietyCases(cases) {
  if (!Array.isArray(cases) || cases.length !== VARIETY_CASE_COUNT) {
    throw new Error(`variety case profile must define exactly ${VARIETY_CASE_COUNT} cases`)
  }
  for (const varietyCase of cases) {
    if (
      typeof varietyCase?.id !== "string" ||
      varietyCase.id === "" ||
      typeof varietyCase?.prompt !== "string" ||
      varietyCase.prompt === "" ||
      !ALL_TIERS.includes(varietyCase?.tier)
    ) {
      throw new Error("variety case profile contains an invalid case")
    }
    const source = varietyCase.source
    if (
      source !== undefined &&
      (typeof source?.file !== "string" ||
        !Number.isInteger(source?.startLine) ||
        !Number.isInteger(source?.lineCount))
    ) {
      throw new Error("variety case profile contains an invalid source reference")
    }
    if (
      varietyCase.prompt_sha256 !== undefined &&
      (typeof varietyCase.prompt_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(varietyCase.prompt_sha256))
    ) {
      throw new Error("variety case profile contains an invalid prompt_sha256")
    }
    const sources = varietyCase.sources
    if (
      sources !== undefined &&
      (!Array.isArray(sources) ||
        sources.length === 0 ||
        sources.some(
          (entry) =>
            typeof entry?.file !== "string" ||
            entry.file === "" ||
            !Number.isInteger(entry?.startLine) ||
            !Number.isInteger(entry?.lineCount),
        ))
    ) {
      throw new Error("variety case profile contains an invalid sources reference")
    }
  }
  return cases
}

// Variety run: exactly one sanitized JSON report on stdout and nothing else.
// Prompts, sampled source code, tokens and upstream error bodies never appear
// in the output; errors are reduced to an HTTP category or an Error.name.
async function runVariety(options) {
  const expectedAccount = options.business ? "business" : "individual"
  const report = {
    observed_at: new Date().toISOString(),
    proxy_url: options.proxyUrl,
    upstream: null,
    account: expectedAccount,
    account_source: "expectation",
    complete: false,
    stop_reason: null,
    auto_requests: 0,
    results: [],
    observed_models: [],
    expected_cases: VARIETY_CASE_COUNT,
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, VARIETY_TIMEOUT_MS)

  try {
    let cases
    try {
      cases = validateVarietyCases(
        await createVarietyCases({ sourceRoot: VARIETY_SOURCE_ROOT }),
      )
    } catch (error) {
      report.stop_reason = "case_profile_failed"
      report.error = error?.name ?? "Error"
      return 1
    }
    if (timedOut) {
      // The 60s budget elapsed while building cases; do not start auth.
      report.stop_reason = "deadline"
      return 1
    }

    let auth
    try {
      auth = await copilotAuthInit(options.proxyUrl, {
        expectedAccount,
        signal: controller.signal,
      })
    } catch (error) {
      report.error = error?.name ?? "Error"
      if (timedOut) {
        report.stop_reason = "deadline"
      } else if (Number.isInteger(error?.status)) {
        report.stop_reason = `http_${error.status}`
      } else {
        report.stop_reason = "auth_failed"
      }
      return 1
    }
    report.upstream = auth.base

    const headers = copilotCommonHeaders(auth)
    const vscodeSessionId = process.env.VSCODE_SESSION_ID ?? crypto.randomUUID()
    const vscodeMachineId = process.env.VSCODE_MACHINE_ID ?? crypto.randomUUID()
    const requestIdBase = `auto-variety-${crypto.randomUUID()}`

    let stopReason = null
    for (let i = 0; i < cases.length; i++) {
      if (timedOut) {
        stopReason = "deadline"
        break
      }
      const varietyCase = cases[i]
      const row = {
        prompt_id: varietyCase.id,
        tier: varietyCase.tier,
        status: null,
        selected_model: null,
        supported_endpoints: null,
      }
      if (varietyCase.source !== undefined) {
        row.source = varietyCase.source
      }
      if (varietyCase.sources !== undefined) {
        row.sources = varietyCase.sources
      }
      if (varietyCase.prompt_sha256 !== undefined) {
        row.prompt_sha256 = varietyCase.prompt_sha256
      }
      report.auto_requests += 1
      try {
        const response = await fetch(`${auth.base}/auto`, {
          method: "POST",
          headers: {
            ...headers,
            "VScode-SessionId": vscodeSessionId,
            "VScode-MachineId": vscodeMachineId,
            "x-request-id": `${requestIdBase}-${i}`,
          },
          body: JSON.stringify({ prompt: varietyCase.prompt, tier: varietyCase.tier }),
          signal: controller.signal,
        })
        if (!response.ok) {
          row.status = response.status
          row.error = `http_${response.status}`
          report.results.push(row)
          stopReason = row.error
          break
        }
        row.status = response.status
        let body
        try {
          body = await response.json()
        } catch {
          body = null
        }
        const modelId = body?.selected_model?.id
        const supportedEndpoints = body?.selected_model?.supported_endpoints
        const endpointsMalformed =
          supportedEndpoints !== undefined &&
          (!Array.isArray(supportedEndpoints) ||
            !supportedEndpoints.every(
              (endpoint) => typeof endpoint === "string",
            ))
        if (typeof modelId !== "string" || modelId === "" || endpointsMalformed) {
          row.error = "malformed_model"
          report.results.push(row)
          stopReason = "malformed_model"
          break
        }
        row.selected_model = modelId
        row.supported_endpoints = supportedEndpoints ?? null
        report.results.push(row)
      } catch (error) {
        row.error = error?.name ?? "Error"
        report.results.push(row)
        stopReason = timedOut ? "deadline" : "network_error"
        break
      }
    }

    report.stop_reason = stopReason
    report.observed_models = [
      ...new Set(
        report.results
          .filter((row) => row.selected_model !== null)
          .map((row) => row.selected_model),
      ),
    ].sort()
    report.complete = stopReason === null
    return report.complete ? 0 : 1
  } finally {
    clearTimeout(timer)
    console.log(JSON.stringify(report, null, 2))
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.variety) {
    process.exitCode = await runVariety(options)
    return
  }
  const expectedAccount = options.business ? "business" : "individual"

  const auth = await copilotAuthInit(options.proxyUrl, expectedAccount)
  const headers = copilotCommonHeaders(auth)

  // CAPI 0.5.x client identity headers: pin via environment variables for
  // controlled A/B probing, fresh synthetic UUIDs per run otherwise.
  const ctx = {
    auth,
    headers,
    requestIdBase: `auto-v2-${crypto.randomUUID()}`,
    vscodeSessionId: process.env.VSCODE_SESSION_ID ?? crypto.randomUUID(),
    vscodeMachineId: process.env.VSCODE_MACHINE_ID ?? crypto.randomUUID(),
    options,
  }

  const tiers = options.tier === "all" ? [...ALL_TIERS] : [options.tier]

  console.log("=== Probe Metadata ===")
  console.log(
    JSON.stringify(
      {
        observed_at: new Date().toISOString(),
        proxy_url: options.proxyUrl,
        upstream: auth.base,
        account: expectedAccount,
        prompt_chars: options.prompt.length,
        identity_pinned: {
          editor_device_id: process.env.EDITOR_DEVICE_ID ?? null,
          vscode_session_id: process.env.VSCODE_SESSION_ID ?? null,
          vscode_machine_id: process.env.VSCODE_MACHINE_ID ?? null,
        },
      },
      null,
      2,
    ),
  )
  console.log()

  let failed = false
  for (const tier of tiers) {
    try {
      const ok = await probeTier(ctx, tier)
      if (!ok) {
        failed = true
      }
    } catch (error) {
      failed = true
      console.error(`Tier ${tier} failed: ${error.message}`)
    }
    console.log()
  }

  process.exit(failed ? 1 : 0)
}

await main()
