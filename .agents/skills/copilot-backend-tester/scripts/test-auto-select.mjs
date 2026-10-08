// Probe POST /auto (VS Code Auto V2 path): one-shot model selection.
// Returns selected_model, session_token, expires_at, discounted_costs
// and hydra_scores in a single response.
//
// As of 2026-10-07 probing, upstream rejects /auto with 404
// "bad request: error: invalid apiVersion?" unless the request carries
// X-GitHub-Api-Version: 2026-08-01. The shared auth module reads the current
// value from src/lib/api-config.ts, which is already 2026-08-01.
//
// Identity headers (EDITOR_DEVICE_ID, VSCODE_SESSION_ID, VSCODE_MACHINE_ID)
// can be pinned via environment variables for controlled A/B probing;
// fresh synthetic UUIDs are generated per run otherwise.
//
// Run: bun .agents/skills/copilot-backend-tester/scripts/test-auto-select.mjs [options]

import { copilotAuthInit, copilotCommonHeaders } from "./copilot-auth.mjs"
import { missingValue, printBody, printHeaders } from "./probe-common.mjs"

const DEFAULT_PROMPT =
  "Write a TypeScript function that normalizes URL paths, with tests for root, duplicate slashes, and trailing slashes."
const ALL_TIERS = ["efficiency", "balance", "intelligence", "fast"]

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
    prompt: DEFAULT_PROMPT,
    withInference: false,
    showHeaders: false,
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
        } else {
          throw new Error(`Unknown tier: ${value} (expected ${ALL_TIERS.join("|")}|all)`)
        }
        break
      }
      case "--prompt":
        options.prompt = argv[++i] ?? missingValue("--prompt")
        break
      case "--with-inference":
        options.withInference = true
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
  console.log(JSON.stringify(body, null, 2))
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

async function main() {
  const options = parseArgs(process.argv.slice(2))
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
        prompt: options.prompt,
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
