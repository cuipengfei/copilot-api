// Shared output helpers for copilot-backend-tester probe scripts.

const SENSITIVE_JSON_KEYS = [
  "token",
  "session_token",
  "copilot_token",
  "access_token",
  "refresh_token",
]

const SENSITIVE_HEADER_PATTERN = /^(authorization|copilot-session-token|set-cookie)$/i

export function missingValue(flag) {
  throw new Error(`Missing value for ${flag}`)
}

export function sanitizeJson(body) {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const copy = { ...body }
    for (const key of SENSITIVE_JSON_KEYS) {
      delete copy[key]
    }
    return copy
  }
  return body
}

export function printHeaders(headers) {
  headers.forEach((value, name) => {
    if (!SENSITIVE_HEADER_PATTERN.test(name)) {
      console.log(`${name}: ${value}`)
    }
  })
}

export function printBody(body) {
  console.log(JSON.stringify(sanitizeJson(body), null, 2))
  console.log()
}

// Request headers for conversation-style probes, matching the bash scripts'
// header set: repo-derived common headers plus conversation intent headers.
export function conversationHeaders(common, initiator, requestId) {
  return {
    ...common,
    "openai-intent": "conversation-agent",
    "x-interaction-type": "conversation-agent",
    "X-Initiator": initiator,
    "x-request-id": requestId,
  }
}

// Streams a response body to stdout verbatim (SSE chunks).
export async function printStream(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    process.stdout.write(decoder.decode(value, { stream: true }))
  }
}
