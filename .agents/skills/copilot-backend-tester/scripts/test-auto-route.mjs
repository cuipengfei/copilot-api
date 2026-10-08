// Probe /models/session, optionally /models/session/intent and the final request.
// Use --list-models for the Auto model set only.
// Run: bun .agents/skills/copilot-backend-tester/scripts/test-auto-route.mjs [options]

import { copilotAuthInit, copilotCommonHeaders } from "./copilot-auth.mjs"
import { missingValue, printBody, printHeaders } from "./probe-common.mjs"

const HELP_TEXT = `Usage: test-auto-route.mjs [options]

  --proxy-url URL    Select the running copilot-api instance
  --business         Require a business token endpoint
  --list-models      Stop after /models/session and print available_models
  --skip-final       Run session + intent, but do not send the final request
  --show-headers     Print response headers (never prints Authorization)
  --prompt TEXT      Prompt used for intent/final probes
  --max-output N     Final response output limit`

function parseArgs(argv) {
  const options = {
    proxyUrl: process.env.COPILOT_PROXY_URL ?? "http://localhost:4141",
    business: false,
    listModels: false,
    skipFinal: false,
    showHeaders: false,
    prompt: "Reply with exactly: hi",
    maxOutput: 256,
  }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--proxy-url":
        options.proxyUrl = argv[++i] ?? missingValue("--proxy-url")
        break
      case "--business":
        options.business = true
        break
      case "--list-models":
        options.listModels = true
        options.skipFinal = true
        break
      case "--skip-final":
        options.skipFinal = true
        break
      case "--show-headers":
        options.showHeaders = true
        break
      case "--prompt":
        options.prompt = argv[++i] ?? missingValue("--prompt")
        break
      case "--max-output":
        options.maxOutput = Number(argv[++i] ?? missingValue("--max-output"))
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

function extractSummary(body) {
  if (body?.content) {
    const text = (body.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part?.text ?? "")
      .join("")
    return { endpoint: "messages", text }
  }
  if (body?.choices) {
    return { endpoint: "chat/completions", text: body.choices[0]?.message?.content }
  }
  const texts = [
    body?.output_text,
    ...(body?.output ?? [])
      .filter((item) => item?.type === "message")
      .flatMap((item) => item?.content ?? [])
      .filter((part) => part?.type === "output_text")
      .map((part) => part?.text),
  ].filter((text) => text != null && text !== "")
  return {
    endpoint: "responses",
    text: [...new Set(texts)].join("\n"),
    incomplete_reason: body?.incomplete_details?.reason,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const expectedAccount = options.business ? "business" : "individual"

  const auth = await copilotAuthInit(options.proxyUrl, expectedAccount)
  const common = copilotCommonHeaders(auth)
  const requestIdBase = `auto-${crypto.randomUUID()}`

  console.log("=== Probe Metadata ===")
  console.log(
    JSON.stringify(
      {
        observed_at: new Date().toISOString(),
        proxy_url: options.proxyUrl,
        upstream: auth.base,
        account: expectedAccount,
      },
      null,
      2,
    ),
  )

  const sessionResponse = await fetch(`${auth.base}/models/session`, {
    method: "POST",
    headers: {
      ...common,
      "openai-intent": "model-access",
      "x-interaction-type": "model-access",
      "x-request-id": `${requestIdBase}-session`,
    },
    body: JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
  })
  const sessionBody = await sessionResponse.json()

  console.log("=== Session Response ===")
  if (options.showHeaders) {
    printHeaders(sessionResponse.headers)
  }
  printBody(sessionBody)

  const availableModels = sessionBody?.available_models
  if (!Array.isArray(availableModels)) {
    throw new Error("session response did not contain an available_models array")
  }

  console.log("=== Auto Models (raw order) ===")
  for (const model of availableModels) {
    console.log(model)
  }
  console.log()
  console.log("=== Auto Models (sorted unique) ===")
  for (const model of [...new Set(availableModels)].sort()) {
    console.log(model)
  }
  console.log()
  console.log(
    JSON.stringify(
      {
        count: availableModels.length,
        selected_model: sessionBody?.selected_model ?? null,
        expires_at: sessionBody?.expires_at ?? null,
      },
      null,
      2,
    ),
  )

  if (options.listModels) {
    process.exit(sessionResponse.ok ? 0 : 1)
  }

  const sessionToken = sessionBody?.session_token
  if (!sessionToken) {
    throw new Error("session response did not contain a session_token")
  }

  const intentBody = {
    prompt: options.prompt,
    available_models: availableModels,
    turn_number: 1,
    prompt_char_count: options.prompt.length,
  }
  const intentResponse = await fetch(`${auth.base}/models/session/intent`, {
    method: "POST",
    headers: {
      ...common,
      "openai-intent": "conversation-agent",
      "x-interaction-type": "conversation-agent",
      "Copilot-Session-Token": sessionToken,
      "x-request-id": `${requestIdBase}-intent`,
    },
    body: JSON.stringify(intentBody),
  })
  const intentJson = await intentResponse.json()

  console.log()
  console.log("=== Intent Response ===")
  if (options.showHeaders) {
    printHeaders(intentResponse.headers)
  }
  printBody(intentJson)

  const chosenModel = intentJson?.chosen_model
  if (!chosenModel) {
    throw new Error("intent response did not contain a chosen_model")
  }

  if (options.skipFinal) {
    process.exit(intentResponse.ok ? 0 : 1)
  }

  let finalUrl
  let finalBody
  if (chosenModel.startsWith("claude-")) {
    finalUrl = `${auth.base}/v1/messages`
    finalBody = {
      model: chosenModel,
      max_tokens: options.maxOutput,
      stream: false,
      messages: [{ role: "user", content: options.prompt }],
    }
  } else if (chosenModel.startsWith("gpt-5")) {
    finalUrl = `${auth.base}/responses`
    finalBody = {
      model: chosenModel,
      input: options.prompt,
      max_output_tokens: options.maxOutput,
      stream: false,
    }
  } else {
    finalUrl = `${auth.base}/chat/completions`
    finalBody = {
      model: chosenModel,
      max_tokens: options.maxOutput,
      stream: false,
      messages: [{ role: "user", content: options.prompt }],
    }
  }

  console.log()
  console.log("=== Final Request ===")
  console.log(JSON.stringify(finalBody, null, 2))

  const finalResponse = await fetch(finalUrl, {
    method: "POST",
    headers: {
      ...common,
      "openai-intent": "conversation-agent",
      "x-interaction-type": "conversation-agent",
      "Copilot-Session-Token": sessionToken,
      "x-request-id": `${requestIdBase}-final`,
    },
    body: JSON.stringify(finalBody),
  })
  const finalJson = await finalResponse.json()

  console.log()
  console.log("=== Final Response ===")
  if (options.showHeaders) {
    printHeaders(finalResponse.headers)
  }
  printBody(finalJson)

  console.log("=== Extracted Summary ===")
  console.log(JSON.stringify(extractSummary(finalJson), null, 2))

  process.exit(finalResponse.ok ? 0 : 1)
}

await main()
