import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as timersPromises from "node:timers/promises"

import { getConfig } from "../src/lib/config-store"
import { state } from "../src/lib/state"
import type * as AutoSession from "../src/lib/auto-session"
import type { Model } from "../src/lib/types/models"
import {
  createProbeCondition,
  TARGET_CODE_PROMPT,
} from "../src/lib/auto-probe-prompts"
import { openProbeHistory } from "../src/lib/auto-probe-history"

type AutoSessionModule = typeof AutoSession
type Source = AutoSession.AutoSessionSource

interface Timer {
  at: number
  callback: () => void
  cancelled: boolean
  unref: () => void
}

const originalTimerPromises = { ...timersPromises }
const nextTurn = originalTimerPromises.setImmediate
const originalFetch = globalThis.fetch
const originalToken = state.copilotToken
const originalModels = state.models
const originalDiscovery = getConfig().autoDiscovery
const modules: Array<AutoSessionModule> = []
let sourceRoot: string
let now: number
let timers: Array<Timer>

const schedule = (callback: () => void, ms: number): Timer => {
  const timer = { at: now + ms, callback, cancelled: false, unref() {} }
  timers.push(timer)
  return timer
}

const nextTimer = (until = Number.POSITIVE_INFINITY): Timer | undefined => {
  let next: Timer | undefined
  for (const timer of timers) {
    if (
      !timer.cancelled
      && timer.at <= until
      && (next === undefined || timer.at < next.at)
    )
      next = timer
  }
  return next
}

const advanceBy = async (ms: number): Promise<void> => {
  const until = now + ms
  await nextTurn()
  for (let fired = 0; ; fired++) {
    const timer = nextTimer(until)
    if (timer === undefined) break
    if (fired >= 128) throw new Error("unbounded temporal discovery timers")
    now = timer.at
    timer.cancelled = true
    timer.callback()
    await nextTurn()
  }
  now = until
  await nextTurn()
}

const finishCurrentRound = async (mod: AutoSessionModule): Promise<void> => {
  let idle = false
  const pending = mod.whenProbeSchedulerIdle().then(() => {
    idle = true
  })
  await nextTurn()
  for (let fired = 0; !idle; fired++) {
    if (fired >= 128) throw new Error("discovery round did not become idle")
    const timer = nextTimer()
    if (timer === undefined || timer.at - now > 3_000) {
      await pending
      break
    }
    await advanceBy(timer.at - now)
  }
  await pending
}

const loadModule = async (): Promise<AutoSessionModule> => {
  // Static imports share stopped schedulers and pairings between these cases.
  const mod = (await import(
    `../src/lib/auto-session?temporal=${now}-${Math.random()}`
  )) as AutoSessionModule
  modules.push(mod)
  return mod
}

const selectionResponse = ({
  source,
  model,
  token,
  lifetime = 86400,
}: {
  source: Source
  model: string
  token: string
  lifetime?: number
}): Response => {
  const expiresAt = Math.floor(now / 1000) + lifetime
  return new Response(
    JSON.stringify(
      source === "auto" ?
        {
          selected_model: { id: model, supported_endpoints: ["/responses"] },
          session_token: token,
          expires_at: expiresAt,
        }
      : {
          fusion_pattern: "solo",
          steps: [{ model_id: model }],
          session: { token, expires_at: expiresAt },
        },
    ),
  )
}

beforeEach(async () => {
  now = Date.parse("2026-11-30T23:59:00Z")
  timers = []
  sourceRoot = await mkdtemp(path.join(os.tmpdir(), "auto-temporal-"))
  state.copilotToken = "temporal-auth"
  getConfig().autoDiscovery = { models: ["wanted-model"] }
  state.models = {
    object: "list",
    data: ["wanted-model", "extra-model"].map((id): Model => ({
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
    })),
  }
  spyOn(Date, "now").mockImplementation(() => now)
  spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    ms = 0,
  ) => schedule(callback, ms)) as unknown as typeof setTimeout)
  spyOn(globalThis, "clearTimeout").mockImplementation((timer: unknown) => {
    const captured = timers.find((candidate) => candidate === timer)
    if (captured) captured.cancelled = true
  })
  await mock.module("node:timers/promises", () => ({
    ...originalTimerPromises,
    setTimeout: <T = void>(
      ms = 0,
      value?: T,
      { signal }: { signal?: AbortSignal } = {},
    ): Promise<T> => {
      const { promise, resolve, reject } = Promise.withResolvers<T>()
      const abort = () => {
        timer.cancelled = true
        reject(new DOMException("Timer aborted", "AbortError"))
      }
      const timer = schedule(() => {
        signal?.removeEventListener("abort", abort)
        resolve(value)
      }, ms)
      if (signal?.aborted) abort()
      else signal?.addEventListener("abort", abort, { once: true })
      return promise
    },
  }))
})

afterEach(async () => {
  for (const mod of modules.splice(0)) {
    mod.stopProbeScheduler()
    await mod.whenProbeSchedulerIdle()
  }
  globalThis.fetch = originalFetch
  state.copilotToken = originalToken
  state.models = originalModels
  getConfig().autoDiscovery = originalDiscovery
  mock.restore()
  await mock.module("node:timers/promises", () => originalTimerPromises)
  await rm(sourceRoot, { recursive: true, force: true })
})

test.each(["auto", "fusion"] as const)(
  "missing wanted %s coverage resumes after cooldown without another consumer request",
  async (missingSource) => {
    const mod = await loadModule()
    const otherSource: Source = missingSource === "auto" ? "fusion" : "auto"
    const calls = { auto: 0, fusion: 0 }
    let recovered = false
    const fetchMock = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        const source: Source = url.endsWith("/model/fusion") ? "fusion" : "auto"
        if (source === "auto" && !url.endsWith("/auto"))
          throw new Error(`unexpected upstream request ${url}`)
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer temporal-auth",
        )
        calls[source]++
        const model =
          source === missingSource ?
            recovered ? "wanted-model"
            : "extra-model"
          : calls[source] % 2 === 1 ? "wanted-model"
          : "extra-model"
        return Promise.resolve(
          selectionResponse({
            source,
            model,
            token: `${source}-${model}-${recovered ? "recovered" : "initial"}`,
          }),
        )
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    state.copilotToken = undefined
    expect(
      await mod.getAutoSessionForModel({ model: "wanted-model" }),
    ).toBeUndefined()
    expect(fetchMock.mock.calls).toHaveLength(0)
    state.copilotToken = "temporal-auth"
    await mod.prewarmAutoSession({ sourceRoot })
    await finishCurrentRound(mod)
    expect(
      await mod.getAutoSessionForModel({
        model: "wanted-model",
        endpoint: "/responses",
        excludedSources: new Set([otherSource]),
        waitForDiscovery: false,
      }),
    ).toBeUndefined()
    expect(
      await mod.getAutoSessionForModel({
        model: "wanted-model",
        endpoint: "/responses",
        excludedSources: new Set([missingSource]),
      }),
    ).toEqual({
      sessionToken: `${otherSource}-wanted-model-initial`,
      source: otherSource,
      expectedDiscount: otherSource === "fusion" ? 30 : 10,
    })
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "extra-model",
          endpoint: "/responses",
          excludedSources: new Set([otherSource]),
        })
      )?.sessionToken,
    ).toBe(`${missingSource}-extra-model-initial`)
    expect(
      await mod.getAutoSessionForModel({
        model: "extra-model",
        authToken: "different-auth",
      }),
    ).toBeUndefined()
    const beforeCooldown = calls[missingSource]
    recovered = true
    await advanceBy(89_999)
    expect(calls[missingSource]).toBe(beforeCooldown)
    await advanceBy(1)
    expect(
      await mod.getAutoSessionForModel({
        model: "wanted-model",
        endpoint: "/responses",
        excludedSources: new Set([otherSource]),
        waitForDiscovery: false,
      }),
    ).toEqual({
      sessionToken: `${missingSource}-wanted-model-recovered`,
      source: missingSource,
      expectedDiscount: missingSource === "fusion" ? 30 : 10,
    })
  },
)

test("a formerly successful condition selecting an extra model does not cover an expired wanted model", async () => {
  const mod = await loadModule()
  let phase: "initial" | "drifted" | "recovered" = "initial"
  globalThis.fetch = mock(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      const source: Source = url.endsWith("/model/fusion") ? "fusion" : "auto"
      if (source === "auto" && !url.endsWith("/auto"))
        throw new Error(`unexpected upstream request ${url}`)
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer temporal-auth",
      )
      return Promise.resolve(
        selectionResponse({
          source,
          model: phase === "drifted" ? "extra-model" : "wanted-model",
          token: `${source}-${phase}`,
          lifetime: phase === "initial" ? 600 : 86400,
        }),
      )
    },
  ) as unknown as typeof fetch
  await mod.prewarmAutoSession({ sourceRoot })
  await finishCurrentRound(mod)
  expect(
    (await mod.getAutoSessionForModel({ model: "wanted-model" }))?.sessionToken,
  ).toBe("fusion-initial")
  phase = "drifted"
  await advanceBy(601_000)
  expect(mod.isModelAutoCovered("wanted-model")).toBe(false)
  for (const source of ["auto", "fusion"] as const) {
    const otherSource: Source = source === "auto" ? "fusion" : "auto"
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "extra-model",
          endpoint: "/responses",
          excludedSources: new Set([otherSource]),
        })
      )?.sessionToken,
    ).toBe(`${source}-drifted`)
  }
  expect(
    await mod.getAutoSessionForModel({
      model: "wanted-model",
      endpoint: "/responses",
      waitForDiscovery: false,
    }),
  ).toBeUndefined()
  await finishCurrentRound(mod)
  expect(mod.getMissingAutoDiscoveryModels(["wanted-model"])).toEqual([
    "wanted-model",
  ])
  expect(getConfig().autoDiscovery).toEqual({ models: ["wanted-model"] })
  phase = "recovered"
  await advanceBy(90_000)
  expect(
    (
      await mod.getAutoSessionForModel({
        model: "wanted-model",
        endpoint: "/responses",
        excludedSources: new Set(["fusion"]),
        waitForDiscovery: false,
      })
    )?.sessionToken,
  ).toBe("auto-recovered")
})

test("restart replays exact conditions, records every Fusion step once, and never learns a stale identity", async () => {
  const instanceId = "restart-fixture"
  const root = path.join(sourceRoot, ".probe-history")
  const autoCondition = createProbeCondition({
    source: "auto",
    tier: "fast",
    prompt: "  historical task\nkeep exact whitespace\n",
  })
  const fusionCondition = createProbeCondition({
    source: "fusion",
    planVersion: "1",
    fusionMode: "hydrafusion",
    prompt: "  historical multi-step task\nkeep exact whitespace\n",
  })
  const history = await openProbeHistory({
    instanceId,
    root,
    writer: "tester-replay",
  })
  for (const condition of [autoCondition, fusionCondition]) {
    await history.record({
      condition,
      observedAt: "2026-11-29T08:00:00.000Z",
      outcome: "selected",
      modelIds: ["wanted-model", "extra-model"],
      pairedModelIds: ["wanted-model"],
    })
  }
  await history.flush()
  const importedPath = path.join(
    root,
    instanceId,
    "tester-replay",
    "runs",
    "2026-11-29.jsonl",
  )
  const imported = await readFile(importedPath, "utf8")
  let phase: "initial" | "drifted" = "initial"
  let authToken = "temporal-auth"
  const calls: Array<{
    source: Source
    prompt: string
    tier?: string
    plan_version?: string
  }> = []
  const late = Promise.withResolvers<Response>()
  const latePrompt = "stale identity must not enter history"
  globalThis.fetch = mock(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      const source: Source = url.endsWith("/model/fusion") ? "fusion" : "auto"
      if (source === "auto" && !url.endsWith("/auto"))
        throw new Error("unexpected upstream endpoint")
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${authToken}`,
      )
      if (typeof init?.body !== "string")
        throw new Error("expected complete selection parameters")
      const body = JSON.parse(init.body) as {
        prompt: string
        tier?: string
        plan_version?: string
      }
      calls.push({ source, ...body })
      if (body.prompt === latePrompt) return late.promise
      const historical =
        body.prompt
        === (source === "auto" ? autoCondition.prompt : fusionCondition.prompt)
      const model =
        phase === "initial" ?
          historical ? "wanted-model"
          : "extra-model"
        : body.prompt === TARGET_CODE_PROMPT ? "wanted-model"
        : "extra-model"
      const token = `${source}-${phase}-${now}`
      if (source === "fusion" && historical)
        return Promise.resolve(
          Response.json({
            fusion_pattern: "multi-step",
            steps: [
              { model_id: model, role: "planner" },
              { model_id: "extra-model", role: "executor" },
              { model_id: model, role: "critic" },
            ],
            session: { token, expires_at: Math.floor(now / 1000) + 86400 },
            hydra_scores: { reasoning: 0.25 },
          }),
        )
      if (source === "auto")
        return Promise.resolve(
          Response.json({
            selected_model: { id: model, supported_endpoints: ["/responses"] },
            session_token: token,
            expires_at: Math.floor(now / 1000) + 86400,
            hydra_scores: { code_gen: 0.5 },
          }),
        )
      return Promise.resolve(selectionResponse({ source, model, token }))
    },
  ) as unknown as typeof fetch

  const first = await loadModule()
  expect(first.isModelAutoCovered("wanted-model")).toBe(false)
  await first.prewarmAutoSession({ sourceRoot, instanceId })
  await finishCurrentRound(first)
  expect(calls).toContainEqual({
    source: "auto",
    prompt: autoCondition.prompt,
    tier: "fast",
  })
  expect(
    calls.some(
      (call) =>
        call.source === "fusion"
        && call.prompt === fusionCondition.prompt
        && call.plan_version === "1",
    ),
  ).toBe(true)
  expect(first.isModelAutoCovered("extra-model")).toBe(true)
  expect(
    (
      await first.getAutoSessionForModel({
        model: "wanted-model",
        endpoint: "/responses",
      })
    )?.source,
  ).toBe("fusion")
  const observed = await openProbeHistory({ instanceId, root })
  expect(
    observed.observations.some(
      (observation) =>
        observation.condition.id === fusionCondition.id
        && observation.observedAt.startsWith("2026-11-30")
        && JSON.stringify(observation.modelIds)
          === JSON.stringify(["wanted-model", "extra-model"])
        && JSON.stringify(observation.pairedModelIds)
          === JSON.stringify(["wanted-model", "extra-model"])
        && observation.scores?.reasoning === 0.25,
    ),
  ).toBe(true)
  expect(
    observed.observations.some(
      (observation) =>
        observation.condition.id === autoCondition.id
        && observation.scores?.code_gen === 0.5,
    ),
  ).toBe(true)

  const staleCondition = createProbeCondition({
    source: "auto",
    tier: "fast",
    prompt: latePrompt,
  })
  const staleProbe = first.runProbePoint("fast", "target", latePrompt, false, 1)
  authToken = "temporal-auth-b"
  state.copilotToken = authToken
  late.resolve(
    selectionResponse({
      source: "auto",
      model: "stale-only-model",
      token: "stale-token",
    }),
  )
  expect(await staleProbe).toBeUndefined()
  first.stopProbeScheduler()
  await first.whenProbeSchedulerIdle()
  const afterRotation = await openProbeHistory({ instanceId, root })
  expect(
    afterRotation.observations.some(
      (observation) => observation.condition.id === staleCondition.id,
    ),
  ).toBe(false)
  const dayPath = path.join(
    root,
    instanceId,
    "runtime",
    "runs",
    "2026-11-30.jsonl",
  )
  const journal = await readFile(dayPath, "utf8")
  for (const secret of [
    "temporal-auth",
    "stale-token",
    `fusion-initial-${now}`,
    `auto-initial-${now}`,
  ])
    expect(journal).not.toContain(secret)

  phase = "drifted"
  now += 86_400_000
  calls.length = 0
  const restarted = await loadModule()
  expect(restarted.isModelAutoCovered("wanted-model")).toBe(false)
  expect(
    await restarted.getAutoSessionForModel({
      model: "wanted-model",
      waitForDiscovery: false,
    }),
  ).toBeUndefined()
  expect(calls).toHaveLength(0)
  await restarted.prewarmAutoSession({ sourceRoot, instanceId })
  await finishCurrentRound(restarted)
  expect(calls.some((call) => call.prompt === autoCondition.prompt)).toBe(true)
  expect(
    calls.some(
      (call) =>
        call.prompt === fusionCondition.prompt && call.plan_version === "1",
    ),
  ).toBe(true)
  expect(
    (
      await restarted.getAutoSessionForModel({
        model: "wanted-model",
        endpoint: "/responses",
        excludedSources: new Set(["fusion"]),
      })
    )?.sessionToken,
  ).toBe(`auto-drifted-${now}`)
  expect(getConfig().autoDiscovery).toEqual({ models: ["wanted-model"] })
  const current = await openProbeHistory({ instanceId, root })
  for (const condition of [autoCondition, fusionCondition]) {
    expect(
      current.observations.some(
        (observation) =>
          observation.condition.id === condition.id
          && observation.observedAt.startsWith("2026-12-01")
          && !observation.modelIds.includes("wanted-model")
          && observation.modelIds.includes("extra-model"),
      ),
    ).toBe(true)
  }
  expect(await readFile(importedPath, "utf8")).toBe(imported)
})

test.each(["auto", "fusion"] as const)(
  "%s rounds stay bounded, deduplicate conditions, and advance the cooldown cursor",
  async (source) => {
    const mod = await loadModule()
    mod.resumeAutoSessionDiscoveryAfterRotation()
    const calls: Array<{ id: string; tier?: string; planVersion?: string }> = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        expect(
          url.endsWith(source === "auto" ? "/auto" : "/model/fusion"),
        ).toBe(true)
        if (typeof init?.body !== "string")
          throw new Error("expected selection body")
        const body = JSON.parse(init.body) as {
          prompt: string
          tier: "efficiency" | "balance" | "intelligence" | "fast"
          plan_version: "1" | "2"
        }
        const condition =
          source === "auto" ?
            createProbeCondition({
              source,
              tier: body.tier,
              prompt: body.prompt,
            })
          : createProbeCondition({
              source,
              planVersion: body.plan_version,
              fusionMode: "hydrafusion",
              prompt: body.prompt,
            })
        calls.push({
          id: condition.id,
          ...(condition.source === "auto" ?
            { tier: condition.tier }
          : { planVersion: condition.planVersion }),
        })
        return Promise.resolve(
          selectionResponse({
            source,
            model: "extra-model",
            token: `${source}-extra-${calls.length}`,
          }),
        )
      },
    ) as unknown as typeof fetch
    const expiresAt = Math.floor(now / 1000) + 86400
    if (source === "auto")
      mod.registerFusionSelection(
        {
          planVersion: "2",
          fusionPattern: "solo",
          steps: [{ modelId: "wanted-model" }],
          sessionToken: "other-source",
          expiresAt,
        },
        createProbeCondition({
          source: "fusion",
          planVersion: "2",
          fusionMode: "hydrafusion",
          prompt: "hello",
        }),
      )
    else
      mod.registerAutoSelection(
        {
          selected_model: {
            id: "wanted-model",
            supported_endpoints: ["/responses"],
          },
          session_token: "other-source",
          expires_at: expiresAt,
        },
        createProbeCondition({
          source: "auto",
          tier: "balance",
          prompt: "hello",
        }),
      )
    await mod.getAutoSessionForModel({
      model: "wanted-model",
      waitForDiscovery: false,
    })
    await finishCurrentRound(mod)
    const budget = source === "auto" ? 40 : 10
    expect(calls).toHaveLength(budget)
    expect(new Set(calls.map((call) => call.id)).size).toBe(budget)
    if (source === "auto") {
      for (const tier of ["intelligence", "efficiency", "balance", "fast"])
        expect(calls.filter((call) => call.tier === tier)).toHaveLength(10)
      expect(calls.slice(0, 4).map((call) => call.tier)).toEqual([
        "intelligence",
        "efficiency",
        "balance",
        "fast",
      ])
    } else {
      expect(calls.map((call) => call.planVersion)).toEqual(
        Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? "1" : "2")),
      )
    }
    const first = calls[0].id
    await advanceBy(90_000)
    await finishCurrentRound(mod)
    expect(calls).toHaveLength(budget * 2)
    const second = calls.slice(budget)
    expect(new Set(second.map((call) => call.id)).size).toBe(budget)
    expect(second[0].id).not.toBe(first)
    if (source === "auto")
      for (const tier of ["intelligence", "efficiency", "balance", "fast"])
        expect(second.filter((call) => call.tier === tier)).toHaveLength(10)
    expect(getConfig().autoDiscovery).toEqual({ models: ["wanted-model"] })
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "extra-model",
          endpoint: "/responses",
        })
      )?.source,
    ).toBe(source)
  },
)

test("different actual prompts stay independent and rotating flights join only their current condition", async () => {
  getConfig().autoDiscovery = { models: [] }
  const mod = await loadModule()
  const gates = new Map<string, PromiseWithResolvers<Response>>()
  const calls: Array<{ authorization: string | null; prompt: string }> = []
  const betaRotated = Promise.withResolvers<void>()
  const resolveGate = (key: string, model: string, token: string) => {
    const gate = gates.get(key)
    if (gate === undefined) throw new Error("missing actual probe request")
    gate.resolve(selectionResponse({ source: "auto", model, token }))
  }
  globalThis.fetch = mock(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      expect(url.endsWith("/auto")).toBe(true)
      if (typeof init?.body !== "string")
        throw new Error("expected actual probe parameters")
      const { prompt } = JSON.parse(init.body) as { prompt: string }
      const authorization = new Headers(init?.headers).get("authorization")
      const key = `${authorization}|${prompt}`
      const gate = Promise.withResolvers<Response>()
      gates.set(key, gate)
      calls.push({ authorization, prompt })
      if (authorization === "Bearer temporal-auth-b" && prompt === "beta task")
        betaRotated.resolve()
      return gate.promise
    },
  ) as unknown as typeof fetch
  try {
    const alpha = mod.runProbePoint("balance", "easy", "alpha task")
    expect(mod.runProbePoint("balance", "easy", "alpha task")).toBe(alpha)
    const beta = mod.runProbePoint("balance", "easy", "beta task")
    expect(calls).toHaveLength(2)
    state.copilotToken = "temporal-auth-b"
    mod.resumeAutoSessionDiscoveryAfterRotation()
    const newAlpha = mod.runProbePoint("balance", "easy", "alpha task")
    expect(newAlpha).not.toBe(alpha)
    expect(calls).toHaveLength(3)
    resolveGate(
      "Bearer temporal-auth|alpha task",
      "stale-alpha",
      "stale-alpha-token",
    )
    resolveGate(
      "Bearer temporal-auth|beta task",
      "stale-beta",
      "stale-beta-token",
    )
    await betaRotated.promise
    const newBeta = mod.runProbePoint("balance", "easy", "beta task")
    expect(newBeta).toBe(beta)
    expect(calls).toHaveLength(4)
    resolveGate(
      "Bearer temporal-auth-b|alpha task",
      "alpha-model",
      "fresh-alpha",
    )
    resolveGate("Bearer temporal-auth-b|beta task", "beta-model", "fresh-beta")
    expect(await Promise.all([alpha, beta, newAlpha, newBeta])).toEqual([
      "alpha-model",
      "beta-model",
      "alpha-model",
      "beta-model",
    ])
    expect(calls).toHaveLength(4)
    expect(mod.isModelAutoCovered("stale-alpha")).toBe(false)
    expect(mod.isModelAutoCovered("stale-beta")).toBe(false)
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "alpha-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("fresh-alpha")
    expect(
      (
        await mod.getAutoSessionForModel({
          model: "beta-model",
          endpoint: "/responses",
        })
      )?.sessionToken,
    ).toBe("fresh-beta")
  } finally {
    mod.stopProbeScheduler()
    for (const gate of gates.values())
      gate.resolve(new Response(null, { status: 400 }))
    await mod.whenProbeSchedulerIdle()
  }
})
