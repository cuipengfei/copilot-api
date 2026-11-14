// Shared output helpers for copilot-backend-tester probe scripts.

const SENSITIVE_JSON_KEYS = new Set([
  "token",
  "session_token",
  "copilot_token",
  "access_token",
  "refresh_token",
  "authorization",
  "signature",
  "encrypted_content",
])

const SENSITIVE_STRING_KEYS = [...SENSITIVE_JSON_KEYS, "proxy-authorization"].join("|")
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `(["']?\\b(?:${SENSITIVE_STRING_KEYS})\\b["']?\\s*[:=]\\s*(?:(?:bearer|token|basic)\\s+)?)(?:"[^"]*"|'[^']*'|[^\\s,;&}]+)`,
  "gi",
)
const BEARER_TOKEN_PATTERN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi

const SENSITIVE_HEADER_PATTERN = /^(authorization|copilot-session-token|set-cookie)$/i

export function missingValue(flag) {
  throw new Error(`Missing value for ${flag}`)
}

export function sanitizeJson(body, options = {}) {
  const secrets = (options.secrets ?? [])
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .sort((a, b) => b.length - a.length)

  const visit = (value) => {
    if (typeof value === "string") {
      let sanitized = value
      for (const secret of secrets) {
        sanitized = sanitized.replaceAll(secret, "[REDACTED]")
      }
      return sanitized
        .replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1[REDACTED]")
        .replace(BEARER_TOKEN_PATTERN, "$1[REDACTED]")
    }
    if (Array.isArray(value)) {
      return value.map(visit)
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !SENSITIVE_JSON_KEYS.has(key.toLowerCase()))
          .map(([key, item]) => [key, visit(item)]),
      )
    }
    return value
  }

  return visit(body)
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
