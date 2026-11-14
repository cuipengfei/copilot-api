import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import {
  createProbeCondition,
  parseAutoDiscoveryModels,
} from "../src/lib/auto-probe-prompts"
import consola from "consola"

import { getConfig } from "../src/lib/config-store"
import { state } from "../src/lib/state"
import type { Model } from "../src/lib/types/models"
import type * as AutoSession from "../src/lib/auto-session"

test("omitted and empty Auto targets add no models", () => {
  expect(parseAutoDiscoveryModels(undefined)).toEqual([])
  expect(parseAutoDiscoveryModels({})).toEqual([])
  expect(parseAutoDiscoveryModels({ models: [] })).toEqual([])
})

test("duplicate Auto target IDs share one discovery slot", () => {
  expect(
    parseAutoDiscoveryModels({
      models: ["gpt-6-luna", "gpt-6-sol", "gpt-6-luna"],
    }),
  ).toEqual(["gpt-6-luna", "gpt-6-sol"])
})

test("malformed Auto targets fail at the configuration boundary", () => {
  for (const invalid of [
    null,
    "gpt-6-luna",
    [],
    { models: null },
    { models: "gpt-6-luna" },
    { models: ["gpt-6-luna", " "] },
  ]) {
    expect(() => parseAutoDiscoveryModels(invalid)).toThrow(TypeError)
  }
})

type AutoSessionModule = typeof AutoSession
const modules: Array<AutoSessionModule> = []
const originalFetch = globalThis.fetch
const originalToken = state.copilotToken
const originalModels = state.models
const originalDiscovery = getConfig().autoDiscovery

const loadModule = async (): Promise<AutoSessionModule> => {
  // A fresh module instance is required to isolate its pairing and scheduler state.
  const module = (await import(
    `../src/lib/auto-session?targets=${Date.now()}-${Math.random()}`
  )) as AutoSessionModule
  modules.push(module)
  return module
}

beforeEach(() => {
  state.copilotToken = "target-test-auth"
  getConfig().autoDiscovery = undefined
  state.models = {
    object: "list",
    data: ["wanted-model", "other-model", "catalog-only-model"].map(
      (id): Model => ({
        id,
        name: id,
        object: "model",
        model_picker_enabled: true,
        preview: false,
        vendor: "test",
        version: "test",
        capabilities: {
          family: "test",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "test",
          type: "chat",
        },
        supported_endpoints: ["/responses"],
      }),
    ),
  }
})

afterEach(async () => {
  for (const module of modules.splice(0)) {
    module.stopProbeScheduler()
    await module.whenProbeSchedulerIdle()
  }
  globalThis.fetch = originalFetch
  state.copilotToken = originalToken
  state.models = originalModels
  getConfig().autoDiscovery = originalDiscovery
  mock.restore()
})

test("wanted remains configuration-owned while obtained and missing are the valid source union", async () => {
  const mod = await loadModule()
  const configured = { models: ["wanted-model", "other-model"] }
  getConfig().autoDiscovery = configured
  mod.registerAutoSelection(
    {
      selected_model: {
        id: "wanted-model",
        supported_endpoints: ["/responses"],
      },
      session_token: "auto-wanted",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
    createProbeCondition({ source: "auto", tier: "balance", prompt: "hello" }),
  )
  expect(mod.getMissingAutoDiscoveryModels(configured.models)).toEqual([
    "other-model",
  ])
  mod.registerFusionSelection(
    {
      planVersion: "2" as const,
      fusionPattern: "solo",
      steps: [{ modelId: "other-model" }],
      sessionToken: "fusion-other",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
    createProbeCondition({
      source: "fusion",
      planVersion: "2",
      fusionMode: "hydrafusion",
      prompt: "hello",
    }),
  )
  expect(mod.getMissingAutoDiscoveryModels(configured.models)).toEqual([])
  expect(getConfig().autoDiscovery).toBe(configured)
  expect(configured).toEqual({ models: ["wanted-model", "other-model"] })
  getConfig().autoDiscovery = { models: ["catalog-only-model"] }
  expect(mod.getMissingAutoDiscoveryModels(["catalog-only-model"])).toEqual([
    "catalog-only-model",
  ])
  expect(mod.isModelAutoCovered("wanted-model")).toBe(true)
  expect(mod.isModelAutoCovered("other-model")).toBe(true)
})

test("an empty wanted list does not scan the model catalog and reports both actual sources", async () => {
  const mod = await loadModule()
  const configured = { models: [] }
  getConfig().autoDiscovery = configured
  let fusionCalls = 0
  const info = spyOn(consola, "info")
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    if (url.endsWith("/model/fusion")) {
      fusionCalls++
      return Promise.resolve(
        new Response(
          JSON.stringify({
            fusion_pattern: "solo",
            steps: [{ model_id: "wanted-model" }],
            session: { token: "fusion-discovered", expires_at: expiresAt },
          }),
        ),
      )
    }
    if (!url.endsWith("/auto")) throw new Error("unexpected selection endpoint")
    return Promise.resolve(
      new Response(
        JSON.stringify({
          selected_model: {
            id: "wanted-model",
            supported_endpoints: ["/responses"],
          },
          session_token: "auto-discovered",
          expires_at: expiresAt,
        }),
      ),
    )
  }) as unknown as typeof fetch
  await mod.prewarmAutoSession()
  await mod.whenProbeSchedulerIdle()
  expect(fusionCalls).toBe(4)
  expect(getConfig().autoDiscovery).toBe(configured)
  const lines = info.mock.calls.map((call) => String(call[0]))
  expect(lines.some((line) => line.includes("wanted=[]"))).toBe(true)
  const result = lines.findLast((line) => line.includes("discovery result"))
  expect(result).toContain('obtained=["wanted-model"]')
  expect(result).toContain('fusion_obtained=["wanted-model"]')
  expect(result).toContain('auto_obtained=["wanted-model"]')
  expect(result).not.toContain("catalog-only-model")
  expect(mod.isModelAutoCovered("catalog-only-model")).toBe(false)
})

test("an Auto-covered wanted model still obtains Fusion and logs the upgrade without changing the union", async () => {
  const mod = await loadModule()
  getConfig().autoDiscovery = { models: ["wanted-model"] }
  const fusion = Promise.withResolvers<void>()
  const autoSeen = Promise.withResolvers<void>()
  const info = spyOn(consola, "info")
  let autoCalls = 0
  let fusionCalls = 0
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith("/model/fusion")) {
      fusionCalls++
      return fusion.promise.then(
        () =>
          new Response(
            JSON.stringify({
              fusion_pattern: "solo",
              steps: [{ model_id: "wanted-model" }],
              session: {
                token: "fusion-upgrade",
                expires_at: Math.floor(Date.now() / 1000) + 3600,
              },
            }),
          ),
      )
    }
    if (!url.endsWith("/auto")) throw new Error("unexpected selection endpoint")
    autoCalls++
    autoSeen.resolve()
    return Promise.resolve(
      new Response(
        JSON.stringify({
          selected_model: {
            id: "wanted-model",
            supported_endpoints: ["/responses"],
          },
          session_token: "auto-before-upgrade",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    )
  }) as unknown as typeof fetch
  try {
    // This small real budget exercises startup's platform-timer race, not a guessed settle delay.
    await mod.prewarmAutoSession({ startupBudgetMs: 20 })
    await autoSeen.promise
    expect(autoCalls).toBeGreaterThan(0)
    expect(fusionCalls).toBe(4)
    expect(mod.getMissingAutoDiscoveryModels(["wanted-model"])).toEqual([])
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "wanted-model",
          endpoint: "/responses",
        })
      )?.source,
    ).toBe("auto")
    const snapshot = info.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("discovery snapshot"))
    expect(snapshot).toContain('auto_obtained=["wanted-model"]')
    expect(snapshot).toContain('fusion_missing=["wanted-model"]')
    expect(snapshot).toContain("auto_missing=[]")
    fusion.resolve()
    await mod.whenProbeSchedulerIdle()
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "wanted-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("fusion-upgrade")
    expect(mod.getMissingAutoDiscoveryModels(["wanted-model"])).toEqual([])
    const lines = info.mock.calls.map((call) => String(call[0]))
    expect(
      lines.some(
        (line) =>
          line.includes("upgraded")
          && line.includes("source=fusion")
          && line.includes("previous_discount=10%")
          && line.includes("expected_discount=30%"),
      ),
    ).toBe(true)
    const result = lines.findLast(
      (line) =>
        line.includes("target discovery result")
        && line.includes("source=fusion"),
    )
    expect(result).toContain('added=["wanted-model"]')
    expect(result).toContain("missing=[]")
    expect(result).not.toContain("auto_obtained")
    expect(result).not.toContain("fusion_obtained")
  } finally {
    mod.stopProbeScheduler()
    fusion.resolve()
    await mod.whenProbeSchedulerIdle()
  }
})

test("a Fusion-covered wanted model still completes independent Auto fallback discovery", async () => {
  const mod = await loadModule()
  getConfig().autoDiscovery = { models: ["wanted-model"] }
  const auto = Promise.withResolvers<void>()
  const info = spyOn(consola, "info")
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith("/model/fusion"))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            fusion_pattern: "solo",
            steps: [{ model_id: "wanted-model" }],
            session: {
              token: "fusion-first",
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            },
          }),
        ),
      )
    if (!url.endsWith("/auto")) throw new Error("unexpected selection endpoint")
    return auto.promise.then(
      () =>
        new Response(
          JSON.stringify({
            selected_model: {
              id: "wanted-model",
              supported_endpoints: ["/responses"],
            },
            session_token: "auto-fallback",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
        ),
    )
  }) as unknown as typeof fetch
  try {
    // The short real budget observes Fusion completion while Auto's HTTP boundary remains gated.
    await mod.prewarmAutoSession({ startupBudgetMs: 20 })
    expect(mod.getMissingAutoDiscoveryModels(["wanted-model"])).toEqual([])
    const snapshot = info.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("discovery snapshot"))
    expect(snapshot).toContain('fusion_obtained=["wanted-model"]')
    expect(snapshot).toContain('auto_missing=["wanted-model"]')
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "wanted-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("fusion-first")
    auto.resolve()
    await mod.whenProbeSchedulerIdle()
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "wanted-model",
          endpoint: "/responses",
          excludedSources: new Set(["fusion"]),
        })
      )?.sessionToken,
    ).toBe("auto-fallback")
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "wanted-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("fusion-first")
  } finally {
    mod.stopProbeScheduler()
    auto.resolve()
    await mod.whenProbeSchedulerIdle()
  }
})

test("v1 registers all eligible distinct step models even when its first step cannot use Responses", async () => {
  const mod = await loadModule()
  const configured = { models: ["wanted-model"] }
  getConfig().autoDiscovery = configured
  const condition = createProbeCondition({
    source: "fusion",
    planVersion: "1",
    fusionMode: "hydrafusion",
    prompt: "multi-step fixture",
  })
  expect(
    mod.registerFusionSelection(
      {
        planVersion: "1",
        fusionPattern: "multi-step",
        steps: [
          { modelId: "unknown-catalog-model", role: "planner" },
          { modelId: "wanted-model", role: "executor" },
          { modelId: "other-model", role: "critic" },
          { modelId: "wanted-model", role: "finalizer" },
        ],
        sessionToken: "multi-step-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      condition,
    ),
  ).toBe(true)
  for (const model of ["wanted-model", "other-model"]) {
    expect(
      await mod.getAutoSessionForModel({ model, endpoint: "/responses" }),
    ).toEqual({
      sessionToken: "multi-step-token",
      source: "fusion",
      expectedDiscount: 30,
    })
  }
  expect(mod.isModelAutoCovered("unknown-catalog-model")).toBe(false)
  expect(getConfig().autoDiscovery).toBe(configured)
})
