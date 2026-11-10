import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  getAutoSessionForModel,
  invalidateAutoSession,
  prewarmAutoSession,
  stopProbeScheduler,
  whenProbeSchedulerIdle,
} from "../src/lib/auto-session"
import { getConfig } from "../src/lib/config-store"
import { state } from "../src/lib/state"
import type * as AutoSessionModule from "../src/lib/auto-session"

const config = getConfig()
const originalTargets = config.autoDiscovery
const originalToken = state.copilotToken
const originalFetch = globalThis.fetch

beforeEach(() => {
  invalidateAutoSession()
  state.copilotToken = undefined
  config.autoDiscovery = { models: ["configured-target"] }
})

afterEach(async () => {
  stopProbeScheduler()
  await whenProbeSchedulerIdle()
  invalidateAutoSession()
  config.autoDiscovery = originalTargets
  state.copilotToken = originalToken
  globalThis.fetch = originalFetch
})

describe("configured Auto miss without credentials", () => {
  test("cold configured miss cannot obtain an Auto token without credentials", async () => {
    expect(
      (
        await getAutoSessionForModel({
          model: "configured-target",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBeUndefined()
  })

  test("invalid target configuration fails before startup can contact upstream", async () => {
    config.autoDiscovery = { models: [""] }
    const error = await prewarmAutoSession().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message).toBe(
      "autoDiscovery.models must contain nonempty model IDs",
    )
  })
})

test("waitForDiscovery false returns a cold miss immediately but leaves real background acquisition running", async () => {
  // Static imports cannot provide a fresh scheduler after another test stops it.
  const mod = (await import(
    `../src/lib/auto-session?miss=${Date.now()}-${Math.random()}`
  )) as typeof AutoSessionModule
  state.copilotToken = "nonblocking-miss-auth"
  const response = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  let autoCalls = 0
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith("/model/fusion"))
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "model_pool_not_eligible" } }),
          { status: 403 },
        ),
      )
    if (!url.endsWith("/auto")) throw new Error("unexpected selection endpoint")
    autoCalls++
    started.resolve()
    return response.promise
  }) as unknown as typeof fetch
  try {
    mod.resumeAutoSessionDiscoveryAfterRotation()
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "configured-target",
          endpoint: "/responses",
          waitForDiscovery: false,
        })
      )?.sessionToken,
    ).toBeUndefined()
    await started.promise
    expect(autoCalls).toBe(1)
    response.resolve(
      new Response(
        JSON.stringify({
          selected_model: {
            id: "configured-target",
            supported_endpoints: ["/responses"],
          },
          session_token: "background-auto",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    )
    await mod.whenProbeSchedulerIdle()
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "configured-target",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("background-auto")
  } finally {
    mod.stopProbeScheduler()
    response.resolve(new Response(null, { status: 400 }))
    await mod.whenProbeSchedulerIdle()
  }
})
