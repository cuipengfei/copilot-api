// Probe POST /auto (VS Code Auto V2 path): one-shot model selection.
// Returns selected_model, session_token, expires_at, discounted_costs
// and hydra_scores in a single response.
//
// The shared auth module reads the X-GitHub-Api-Version value from
// src/lib/api-config.ts at runtime, so upstream version bumps never require
// edits here.
//
// Identity headers (EDITOR_DEVICE_ID, VSCODE_SESSION_ID, VSCODE_MACHINE_ID)
// can be pinned via environment variables for controlled A/B probing;
// fresh synthetic UUIDs are generated per run otherwise.
//
// Run: bun .agents/skills/copilot-backend-tester/scripts/test-auto-select.mjs [options]

import {
  copilotAuthInit,
  copilotCommonHeaders,
  copilotSelectionHeaders,
} from "./copilot-auth.mjs"
import { missingValue, printHeaders, sanitizeJson } from "./probe-common.mjs"
import {
  isoDate,
  positiveInteger,
  runSelectionVariety,
  safeUrl,
  VARIETY_DEFAULTS,
} from "./selection-variety.mjs"

const DEFAULT_PROMPT =
  "Write a TypeScript function that normalizes URL paths, with tests for root, duplicate slashes, and trailing slashes."
const ALL_TIERS = ["efficiency", "balance", "intelligence", "fast"]

const HELP_TEXT = `Usage: test-auto-select.mjs [options]

Probes POST /auto on the upstream returned by token exchange.

Options:
  --proxy-url <url>       Local proxy URL used for credentials and instance identity
                          (default: http://localhost:4141)
  --business              Expect a business account upstream
  --tier <name>           efficiency | balance | intelligence | fast | all (default: balance)
  --prompt <text>         Prompt used for single-tier model selection
  --variety               Run shared and real-source conditions with one JSON report
  --with-inference        Generate once in single mode; run billed token controls in variety
  --repeat <n>            Repeat the selected conditions (default: 1)
  --interval-ms <n>       Delay between conditions (default: 0)
  --budget-ms <n>         Whole-run deadline including authentication (default: 60000)
  --max-requests <n>      Shared selection and generation request budget (default: 128)
  --replay                Replay saved prompts instead of constructing new conditions
  --replay-date <date>    Replay only conditions observed on this UTC YYYY-MM-DD
  --history-root <path>   Read and write probe history below this root
  --show-headers          Print sanitized response headers in single-tier mode
  -h, --help              Show this help

Environment:
  EDITOR_DEVICE_ID        Pin the editor device identity
  VSCODE_SESSION_ID       Pin the VS Code session identity
  VSCODE_MACHINE_ID       Pin the VS Code machine identity`

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
    replay: false,
    replayDate: null,
    historyRoot: undefined,
    ...VARIETY_DEFAULTS,
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
      case "--repeat":
        options.repeat = positiveInteger(argv[++i] ?? missingValue("--repeat"), "--repeat")
        break
      case "--interval-ms":
        options.intervalMs = positiveInteger(
          argv[++i] ?? missingValue("--interval-ms"),
          "--interval-ms",
          { allowZero: true },
        )
        break
      case "--budget-ms":
        options.budgetMs = positiveInteger(argv[++i] ?? missingValue("--budget-ms"), "--budget-ms")
        break
      case "--max-requests":
        options.maxRequests = positiveInteger(
          argv[++i] ?? missingValue("--max-requests"),
          "--max-requests",
        )
        break
      case "--replay":
        options.replay = true
        options.variety = true
        break
      case "--replay-date":
        options.replayDate = isoDate(argv[++i] ?? missingValue("--replay-date"))
        options.replay = true
        options.variety = true
        break
      case "--history-root":
        options.historyRoot = argv[++i] ?? missingValue("--history-root")
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
    if (options.showHeaders) conflicts.push("--show-headers")
    if (conflicts.length > 0) {
      throw new Error(`--variety is mutually exclusive with ${conflicts.join(", ")}`)
    }
  } else if (options.replay || options.repeat !== 1 || options.intervalMs !== 0
    || options.budgetMs !== VARIETY_DEFAULTS.budgetMs
    || options.maxRequests !== VARIETY_DEFAULTS.maxRequests || options.historyRoot !== undefined) {
    throw new Error("history, repeat, interval and budget options require --variety")
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

function printSafeBody(ctx, body) {
  console.log(JSON.stringify(sanitizeJson(body, { secrets: ctx.secrets }), null, 2))
  console.log()
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
      ...(endpoint.endsWith("/messages") ? { "anthropic-version": "2023-06-01" } : {}),
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
  printSafeBody(ctx, await response.json())
  return response.ok
}

async function probeTier(ctx, tier) {
  const requestId = `${ctx.requestIdBase}-${tier}`
  const response = await fetch(`${ctx.auth.base}/auto`, {
    method: "POST",
    headers: {
      ...copilotSelectionHeaders(ctx.auth, requestId),
      "VScode-SessionId": ctx.vscodeSessionId,
      "VScode-MachineId": ctx.vscodeMachineId,
    },
    body: JSON.stringify({ prompt: ctx.options.prompt, tier }),
  })

  const body = await response.json()
  if (typeof body?.session_token === "string") ctx.secrets.push(body.session_token)

  console.log(`=== Tier: ${tier} (HTTP ${response.status}) ===`)
  if (ctx.options.showHeaders) {
    printHeaders(response.headers)
    console.log()
  }
  printSafeBody(ctx, body)

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


async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.variety) {
    process.exitCode = await runSelectionVariety({
      ...options,
      source: "auto",
      planVersions: [],
      runtimeSeeds: false,
    })
    return
  }
  const expectedAccount = options.business ? "business" : "individual"

  const auth = await copilotAuthInit(options.proxyUrl, expectedAccount)
  const headers = copilotCommonHeaders(auth)

  const ctx = {
    auth,
    headers,
    secrets: [auth.token],
    requestIdBase: `auto-v2-${crypto.randomUUID()}`,
    vscodeSessionId: process.env.VSCODE_SESSION_ID ?? crypto.randomUUID(),
    vscodeMachineId: process.env.VSCODE_MACHINE_ID ?? crypto.randomUUID(),
    options,
  }

  const tiers = options.tier === "all" ? [...ALL_TIERS] : [options.tier]

  console.log("=== Probe Metadata ===")
  console.log(
    JSON.stringify(
      sanitizeJson({
        observed_at: new Date().toISOString(),
        proxy_url: safeUrl(options.proxyUrl),
        upstream: safeUrl(auth.base),
        account: expectedAccount,
        prompt_chars: options.prompt.length,
        identity_pinned: {
          editor_device_id: process.env.EDITOR_DEVICE_ID ?? null,
          vscode_session_id: process.env.VSCODE_SESSION_ID ?? null,
          vscode_machine_id: process.env.VSCODE_MACHINE_ID ?? null,
        },
      }, { secrets: ctx.secrets }),
      null,
      2,
    ),
  )
  console.log()

  let failed = false
  for (const tier of tiers) {
    try {
      const ok = await probeTier(ctx, tier)
      if (!ok) failed = true
    } catch (error) {
      failed = true
      const status = Number.isInteger(error?.status) ? ` HTTP ${error.status}` : ""
      console.error(`Tier ${tier} failed: ${error?.name ?? "Error"}${status}`)
    }
    console.log()
  }

  process.exit(failed ? 1 : 0)
}

await main()
