import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  getAutoSessionTokenForModel,
  invalidateAutoSession,
  prewarmAutoSession,
  stopProbeScheduler,
  whenProbeSchedulerIdle,
} from "../src/lib/auto-session"
import { getConfig } from "../src/lib/config-store"
import { state } from "../src/lib/state"

const config = getConfig()
const originalTargets = config.autoDiscovery
const originalToken = state.copilotToken

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
})

describe("configured Auto miss without credentials", () => {
  test("cold configured miss cannot obtain an Auto token without credentials", async () => {
    expect(
      await getAutoSessionTokenForModel("configured-target", "/responses"),
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
