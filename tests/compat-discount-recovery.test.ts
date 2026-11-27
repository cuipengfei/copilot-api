import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import type { Server } from "bun"

import {
  invalidateAutoSession,
  registerAutoSelection,
  registerFusionSelection,
  stopProbeScheduler,
  whenProbeSchedulerIdle,
} from "~/lib/auto-session"
import { createProbeCondition } from "~/lib/auto-probe-prompts"
import { getConfig } from "~/lib/config/config-store"
import { state } from "~/lib/state"
import type { ResponsesPayload } from "~/lib/types/responses"
import { attachAutoSessionToken } from "~/services/copilot/auto-session-retry"
import {
  sendWithSignatureRetry,
  type EnhancedMessagesPayload,
} from "~/services/copilot/messages-compat"
import { sendResponsesRequestWithReasoningReplay } from "~/services/copilot/responses-compat"

const MODEL = "compat-discount-model"
const AUTH_TOKEN = "compat-discount-auth"
const GITHUB_TOKEN = "compat-discount-github"
const FUSION_TOKEN = "compat-fusion-token"
const AUTO_TOKEN = "compat-auto-token"
const transportConfig = {
  headersTimeoutMs: 5_000,
  streamInactivityTimeoutMs: 5_000,
}

interface CapturedRequest {
  path: string
  body: unknown
  sessionToken: string | null
  authorization: string | null
}

let server: Server<undefined>
let sessionRejectionStatus: 400 | 401 = 400
const requests: Array<CapturedRequest> = []
const originalCopilotToken = state.copilotToken
const originalGithubToken = state.githubToken
const originalModels = state.models
const originalDiscovery = getConfig().autoDiscovery

const countFor = (path: string): number =>
  requests.filter((request) => request.path === path).length

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body: unknown = await request.json()
      requests.push({
        path,
        body,
        sessionToken: request.headers.get("Copilot-Session-Token"),
        authorization: request.headers.get("Authorization"),
      })

      if (countFor(path) === 1) {
        if (path === "/responses") {
          return Response.json(
            { error: { message: "input item ID does not belong here" } },
            { status: 400 },
          )
        }
        if (path === "/v1/messages") {
          const payload = body as EnhancedMessagesPayload
          if (payload.output_config) {
            return Response.json(
              {
                error: {
                  code: "invalid_reasoning_effort",
                  message: "unsupported effort, supported values: [low]",
                },
              },
              { status: 400 },
            )
          }
          return Response.json(
            {
              error: {
                message: "thinking blocks cannot be modified",
              },
            },
            { status: 400 },
          )
        }
      }
      if (countFor(path) === 2) {
        return Response.json(
          { error: { message: "Invalid session token" } },
          { status: sessionRejectionStatus },
        )
      }
      return Response.json({ id: "compat-recovery-success" })
    },
  })
})

beforeEach(() => {
  invalidateAutoSession()
  requests.length = 0
  sessionRejectionStatus = 400
  getConfig().autoDiscovery = undefined
  state.copilotToken = AUTH_TOKEN
  state.githubToken = GITHUB_TOKEN
  state.models = {
    object: "list",
    data: [
      {
        id: MODEL,
        supported_endpoints: ["/responses"],
      },
    ],
  } as typeof state.models
})

afterEach(() => {
  invalidateAutoSession()
  state.copilotToken = originalCopilotToken
  state.githubToken = originalGithubToken
  state.models = originalModels
  getConfig().autoDiscovery = originalDiscovery
})

afterAll(async () => {
  await server.stop(true)
  stopProbeScheduler()
  await whenProbeSchedulerIdle()
})

const registerAutoPairing = (endpoint: "/responses" | "/v1/messages"): void => {
  expect(
    registerAutoSelection(
      {
        selected_model: {
          id: MODEL,
          supported_endpoints: [endpoint],
        },
        session_token: AUTO_TOKEN,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    ),
  ).toBe(true)
}

const registerResponsesPairings = (includeAuto: boolean): void => {
  if (includeAuto) registerAutoPairing("/responses")
  expect(
    registerFusionSelection(
      {
        planVersion: "2",
        fusionPattern: "solo",
        steps: [{ modelId: MODEL }],
        sessionToken: FUSION_TOKEN,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      createProbeCondition({
        source: "fusion",
        planVersion: "2",
        fusionMode: "hydrafusion",
        prompt: "hello",
      }),
    ),
  ).toBe(true)
}

const sessionHeaders = async (
  endpoint: "/responses" | "/v1/messages",
): Promise<Record<string, string>> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "x-request-id": "compat-discount-request",
  }
  await attachAutoSessionToken(headers, MODEL, endpoint)
  return headers
}

const expectRecovered = (expectedTokens: Array<string | null>): void => {
  expect(requests.map((request) => request.sessionToken)).toEqual(
    expectedTokens,
  )
  for (const request of requests) {
    expect(request.authorization).toBe(`Bearer ${AUTH_TOKEN}`)
  }
}

const responsesPayload = (): ResponsesPayload => ({
  model: MODEL,
  input: [
    { role: "user", content: "keep this input" },
    {
      type: "reasoning",
      id: "reasoning-compat",
      summary: [],
      encrypted_content: "encrypted-compat",
    },
  ],
})

const effortPayload = (): EnhancedMessagesPayload => ({
  model: MODEL,
  max_tokens: 1024,
  messages: [{ role: "user", content: "keep this input" }],
  temperature: 1,
  output_config: { effort: "high" },
})

const thinkingPayload = (): EnhancedMessagesPayload => ({
  model: MODEL,
  max_tokens: 1024,
  messages: [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning", signature: "sig" },
        { type: "text", text: "answer" },
      ],
    },
  ],
  temperature: 1,
})

describe("compatibility retries recover rejected discount sessions", () => {
  test.each([true, false])(
    "Responses reasoning replay falls back after rejection (Auto available: %s)",
    async (includeAuto) => {
      registerResponsesPairings(includeAuto)
      const headers = await sessionHeaders("/responses")

      const response = await sendResponsesRequestWithReasoningReplay(
        new URL("/responses", server.url).href,
        { headers, payload: responsesPayload(), transportConfig },
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        id: "compat-recovery-success",
      })
      expectRecovered([
        FUSION_TOKEN,
        FUSION_TOKEN,
        includeAuto ? AUTO_TOKEN : null,
      ])
      const bodies = requests.map((request) => request.body) as Array<{
        input: Array<Record<string, unknown>>
      }>
      expect(bodies[0].input[1]).toHaveProperty(
        "encrypted_content",
        "encrypted-compat",
      )
      expect(bodies[1].input[1]).not.toHaveProperty("encrypted_content")
      expect(bodies[2]).toEqual(bodies[1])
    },
  )

  test.each([400, 401])(
    "Messages effort fallback reaches full price after Auto session rejection (%s)",
    async (rejectionStatus) => {
      sessionRejectionStatus = rejectionStatus
      registerAutoPairing("/v1/messages")
      const headers = await sessionHeaders("/v1/messages")

      const response = await sendWithSignatureRetry(
        new URL("/v1/messages", server.url).href,
        { headers, enhancedPayload: effortPayload() },
      )

      expect(response.status).toBe(200)
      expectRecovered([AUTO_TOKEN, AUTO_TOKEN, null])
      const bodies = requests.map((request) => request.body) as Array<{
        output_config: { effort: string }
      }>
      expect(bodies.map((body) => body.output_config.effort)).toEqual([
        "high",
        "low",
        "low",
      ])
      expect(bodies[2]).toEqual(bodies[1])
    },
  )

  test.each([400, 401])(
    "Messages thinking fallback reaches full price after Auto session rejection (%s)",
    async (rejectionStatus) => {
      sessionRejectionStatus = rejectionStatus
      registerAutoPairing("/v1/messages")
      const headers = await sessionHeaders("/v1/messages")

      const response = await sendWithSignatureRetry(
        new URL("/v1/messages", server.url).href,
        { headers, enhancedPayload: thinkingPayload() },
      )

      expect(response.status).toBe(200)
      expectRecovered([AUTO_TOKEN, AUTO_TOKEN, null])
      const bodies = requests.map((request) => request.body) as Array<{
        messages: Array<{ content: Array<{ type: string }> }>
      }>
      expect(
        bodies.map((body) =>
          body.messages[0].content.map((block) => block.type),
        ),
      ).toEqual([["thinking", "text"], ["text"], ["text"]])
      expect(bodies[2]).toEqual(bodies[1])
    },
  )
})
