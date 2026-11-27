import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"

import { createProbeCondition } from "~/lib/auto-probe-prompts"
import {
  getAutoSessionForModel,
  invalidateAutoSession,
  prewarmAutoSession,
  registerAutoSelection,
  stopProbeScheduler,
  whenProbeSchedulerIdle,
} from "~/lib/auto-session"
import { getConfig } from "~/lib/config/config-store"
import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"
import { getAutoSelection } from "~/services/copilot/get-auto-selection"

const originalDiscovery = getConfig().autoDiscovery
const originalState = {
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  copilotTelemetryEnabled: state.copilotTelemetryEnabled,
  vsCodeVersion: state.vsCodeVersion,
  accountType: state.accountType,
  forceAgent: state.forceAgent,
  models: state.models,
}
const model = "fixture-discount-model"
const standardToken = "fixture-standard-session"
const generatedRequests: Array<{ model: string; token: string | null }> = []
let standardSelections = 0
let stopUpstream: (() => Promise<void>) | undefined

afterEach(async () => {
  getConfig().autoDiscovery = undefined
  invalidateAutoSession()
  await whenProbeSchedulerIdle()
  await stopUpstream?.()
  stopUpstream = undefined
  getConfig().autoDiscovery = originalDiscovery
  Object.assign(state, originalState)
})

afterAll(async () => {
  stopProbeScheduler()
  await whenProbeSchedulerIdle()
})

beforeEach(() => {
  generatedRequests.length = 0
  standardSelections = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/model/fusion") {
        return Response.json(
          { error: { code: "model_pool_not_eligible" } },
          { status: 403 },
        )
      }
      if (path === "/auto") {
        const body = (await request.json()) as { fusion?: boolean }
        if (body.fusion) standardSelections += 1
        return Response.json({
          selected_model: { id: model, supported_endpoints: ["/responses"] },
          session_token: body.fusion ? standardToken : "fixture-auto-session",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        })
      }
      if (path === "/responses") {
        const body = (await request.json()) as { model: string }
        generatedRequests.push({
          model: body.model,
          token: request.headers.get("Copilot-Session-Token"),
        })
        return Response.json({
          id: "resp-standard-discount",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          model,
          status: "completed",
          output: [],
          output_text: "hi",
          usage: null,
          error: null,
          incomplete_details: null,
        })
      }
      return new Response("Unexpected local test endpoint", { status: 404 })
    },
  })
  stopUpstream = () => upstream.stop(true)
  invalidateAutoSession()
  state.copilotApiUrl = upstream.url.origin
  state.copilotToken = "fixture-copilot-token"
  state.copilotTelemetryEnabled = false
  state.vsCodeVersion = "1.0.0"
  state.accountType = "business"
  state.forceAgent = false
  state.models = {
    object: "list",
    data: [
      {
        id: model,
        name: "fixture",
        capabilities: {
          family: "fixture",
          limits: {},
          object: "capabilities",
          supports: {
            adaptive_thinking: false,
            tool_calls: true,
            streaming: true,
          },
          tokenizer: "o200k_base",
          type: "chat",
        },
        model_picker_enabled: true,
        object: "model",
        preview: false,
        supported_endpoints: ["/responses"],
        vendor: "fixture",
        version: "1",
      },
    ],
  }
  getConfig().autoDiscovery = undefined
})

test("Responses uses Standard's 30% token after High and Max permission rejection", async () => {
  getConfig().autoDiscovery = { models: [model] }
  await prewarmAutoSession()
  await whenProbeSchedulerIdle()
  const selection = await getAutoSessionForModel({
    model,
    endpoint: "/responses",
    authToken: state.copilotToken,
    waitForDiscovery: false,
  })
  expect(selection).toMatchObject({
    source: "fusion",
    sessionToken: standardToken,
  })
  const response = await createResponses(
    { model, input: "Reply with exactly: hi", max_output_tokens: 64 },
    { vision: false, initiator: "agent", transport: "http" },
  )

  expect(response).toMatchObject({
    id: "resp-standard-discount",
    status: "completed",
    output_text: "hi",
  })
  expect(standardSelections).toBeGreaterThan(0)
  expect(generatedRequests).toEqual([{ model, token: standardToken }])
}, 15_000)

test("Standard sessions verified as 10% remain usable as Auto fallback", async () => {
  const condition = createProbeCondition({
    source: "auto",
    tier: "balance",
    fusion: true,
    expectedDiscount: 10,
    prompt: "hello",
  })
  const selection = await getAutoSelection(condition.prompt, {
    tier: "balance",
    fusion: true,
  })
  expect(registerAutoSelection(selection, condition)).toBe(true)

  const session = await getAutoSessionForModel({
    model,
    endpoint: "/responses",
    authToken: state.copilotToken,
    waitForDiscovery: false,
  })
  expect(session).toMatchObject({ source: "auto", sessionToken: standardToken })

  const response = await createResponses(
    { model, input: "Reply with exactly: hi", max_output_tokens: 64 },
    { vision: false, initiator: "agent", transport: "http" },
  )
  expect(response).toMatchObject({
    id: "resp-standard-discount",
    status: "completed",
    output_text: "hi",
  })
  expect(generatedRequests).toEqual([{ model, token: standardToken }])
}, 15_000)
