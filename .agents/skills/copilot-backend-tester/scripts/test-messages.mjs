// Test GitHub Copilot /v1/messages directly.
// Run: bun .agents/skills/copilot-backend-tester/scripts/test-messages.mjs LIVE_MODEL_ID [options]

import { copilotAuthInit, copilotCommonHeaders } from "./copilot-auth.mjs"
import {
  conversationHeaders,
  missingValue,
  printBody,
  printHeaders,
  printStream,
} from "./probe-common.mjs"

const HELP_TEXT = `Usage: test-messages.mjs LIVE_MODEL_ID [options]

  --proxy-url URL    Select the running copilot-api instance
  --business         Require a business token endpoint
  --prompt TEXT      Prompt
  --initiator VALUE  X-Initiator value
  --adaptive         Use adaptive thinking
  --effort VALUE     Set output effort
  --thinking N       Set thinking budget
  --stream           Request streaming output
  --show-headers     Print response headers without Authorization`

function parseArgs(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  const model = argv[0]
  if (model === undefined) {
    throw new Error("provide a live model ID as the first argument")
  }

  const options = {
    model,
    proxyUrl: process.env.COPILOT_PROXY_URL ?? "http://localhost:4141",
    business: false,
    prompt: "What is 2+2? Answer in one word.",
    initiator: "agent",
    adaptive: false,
    effort: "",
    thinkingBudget: "",
    stream: false,
    showHeaders: false,
  }

  for (let i = 1; i < argv.length; i++) {
    switch (argv[i]) {
      case "--proxy-url":
        options.proxyUrl = argv[++i] ?? missingValue("--proxy-url")
        break
      case "--business":
        options.business = true
        break
      case "--prompt":
        options.prompt = argv[++i] ?? missingValue("--prompt")
        break
      case "--initiator":
        options.initiator = argv[++i] ?? missingValue("--initiator")
        break
      case "--adaptive":
        options.adaptive = true
        break
      case "--effort":
        options.effort = argv[++i] ?? missingValue("--effort")
        break
      case "--thinking":
        options.thinkingBudget = argv[++i] ?? missingValue("--thinking")
        break
      case "--stream":
        options.stream = true
        break
      case "--show-headers":
        options.showHeaders = true
        break
      default:
        throw new Error(`Unknown option: ${argv[i]}`)
    }
  }

  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const auth = await copilotAuthInit(
    options.proxyUrl,
    options.business ? "business" : "individual",
  )

  let thinking
  if (options.adaptive) {
    thinking = { type: "adaptive" }
  } else if (options.thinkingBudget !== "") {
    thinking = { type: "enabled", budget_tokens: Number(options.thinkingBudget) }
  }

  const body = {
    model: options.model,
    max_tokens: 1024,
    stream: options.stream,
    thinking,
    output_config: options.effort === "" ? undefined : { effort: options.effort },
    temperature: 1,
    messages: [{ role: "user", content: options.prompt }],
  }
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) {
      delete body[key]
    }
  }

  const headers = conversationHeaders(
    copilotCommonHeaders(auth),
    options.initiator,
    `messages-${crypto.randomUUID()}`,
  )

  console.log("=== Request ===")
  console.log(JSON.stringify(body, null, 2))
  console.log("=== Response ===")

  const response = await fetch(`${auth.base}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  if (options.showHeaders) {
    console.log("=== Response Headers ===")
    printHeaders(response.headers)
  }

  if (options.stream) {
    await printStream(response)
  } else {
    printBody(await response.json())
  }

  process.exit(response.ok ? 0 : 1)
}

await main()
