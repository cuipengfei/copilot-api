import { createHash } from "node:crypto"
import { describe, expect, mock, test } from "bun:test"

const config: { autoDiscovery?: unknown } = {}
await mock.module("~/lib/config/config-store", () => ({
  getConfig: () => config,
}))
// Load after installing the config boundary mock so tests never read user configuration.

const {
  createProbeCondition,
  createProbeConditionsForPrompt,
  pairingSourceForProbe,
  getProbeConditions,
  getWantedModels,
  getIntelligenceProbePrompt,
  PREWARM_PROMPT,
  TARGET_CODE_PROMPT,
} = await import("~/lib/auto-probe-prompts")

describe("shared probe conditions", () => {
  test("hashes the complete request tuple without altering prompt bytes", () => {
    const prompt = "  hello\r\nworld\n"
    const condition = createProbeCondition({
      source: "auto",
      tier: "balance",
      prompt,
    })
    const expected = createHash("sha256")
      .update(JSON.stringify(["auto", "balance", prompt]))
      .digest("hex")
    expect(condition.id).toBe(expected)
    expect(condition.prompt).toBe(prompt)
    expect(
      createProbeCondition({ prompt, tier: "balance", source: "auto" }),
    ).toEqual(condition)
    expect(
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: prompt.trim(),
      }).id,
    ).not.toBe(condition.id)
    const fusion = createProbeCondition({
      source: "fusion",
      fusionMode: "hydrafusion",
      planVersion: "1",
      prompt,
    })
    expect(fusion.id).toBe(
      createHash("sha256")
        .update(JSON.stringify(["fusion", "hydrafusion", "1", prompt]))
        .digest("hex"),
    )
    const standard = createProbeCondition({
      source: "auto",
      tier: "balance",
      prompt,
      fusion: true,
      expectedDiscount: 30,
    })
    const standard10 = createProbeCondition({
      source: "auto",
      tier: "balance",
      prompt,
      fusion: true,
      expectedDiscount: 10,
    })
    const high10 = createProbeCondition({
      source: "fusion",
      fusionMode: "hydrafusion",
      planVersion: "1",
      prompt,
      expectedDiscount: 10,
    })
    const max = createProbeCondition({
      source: "fusion",
      fusionMode: "hydrafusion-max",
      planVersion: "1",
      prompt,
      expectedDiscount: 30,
    })
    expect(standard.id).toBe(
      createHash("sha256")
        .update(JSON.stringify(["auto", "balance", prompt, true, 30]))
        .digest("hex"),
    )
    expect(standard10.id).toBe(
      createHash("sha256")
        .update(JSON.stringify(["auto", "balance", prompt, true, 10]))
        .digest("hex"),
    )
    expect(high10.id).toBe(
      createHash("sha256")
        .update(JSON.stringify(["fusion", "hydrafusion", "1", prompt, 10]))
        .digest("hex"),
    )
    expect(max.id).toBe(
      createHash("sha256")
        .update(JSON.stringify(["fusion", "hydrafusion-max", "1", prompt, 30]))
        .digest("hex"),
    )
    for (const id of [standard.id, standard10.id, high10.id, max.id]) {
      expect(id).not.toBe(condition.id)
      expect(id).not.toBe(fusion.id)
    }
    expect(new Set([standard.id, standard10.id, high10.id, max.id]).size).toBe(
      4,
    )
    for (const probe of [condition, standard10, high10]) {
      expect(pairingSourceForProbe(probe)).toBe("auto")
    }
    for (const probe of [standard, fusion, max]) {
      expect(pairingSourceForProbe(probe)).toBe("fusion")
    }
  })

  test("rejects unsupported public probe conditions", () => {
    expect(() =>
      createProbeCondition({
        source: "auto",
        tier: "efficiency",
        prompt: "hello",
        fusion: true,
        expectedDiscount: 30,
      } as never),
    ).toThrow()
    expect(() =>
      createProbeCondition({
        source: "fusion",
        fusionMode: "hydrafusion-max",
        planVersion: "2",
        prompt: "hello",
        expectedDiscount: 30,
      } as never),
    ).toThrow()
  })

  test("builds every route for a prompt without creating efficiency Standard", () => {
    const conditions = createProbeConditionsForPrompt("hello", [
      "efficiency",
      "balance",
    ])
    expect(
      conditions
        .filter(
          (condition) =>
            condition.source === "auto" && condition.fusion !== true,
        )
        .map((condition) =>
          condition.source === "auto" ? condition.tier : undefined,
        ),
    ).toEqual(["efficiency", "balance"])
    expect(
      conditions
        .filter(
          (condition) =>
            condition.source === "auto" && condition.fusion === true,
        )
        .map((condition) =>
          condition.source === "auto" ? condition.tier : undefined,
        ),
    ).toEqual(["balance"])
    expect(
      conditions
        .filter(
          (condition) =>
            condition.source === "fusion"
            && condition.fusionMode === "hydrafusion",
        )
        .map((condition) =>
          condition.source === "fusion" ? condition.planVersion : undefined,
        ),
    ).toEqual(["1", "2"])
    expect(
      conditions
        .filter(
          (condition) =>
            condition.source === "fusion"
            && condition.fusionMode === "hydrafusion-max",
        )
        .map((condition) =>
          condition.source === "fusion" ? condition.planVersion : undefined,
        ),
    ).toEqual(["1"])
  })

  test("isolates source, tier and Fusion version for identical prompts", () => {
    const prompt = "hello"
    const conditions = [
      ...(["efficiency", "balance", "intelligence", "fast"] as const).map(
        (tier) => createProbeCondition({ source: "auto", tier, prompt }),
      ),
      ...(["1", "2"] as const).map((planVersion) =>
        createProbeCondition({
          source: "fusion",
          fusionMode: "hydrafusion",
          planVersion,
          prompt,
        }),
      ),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt,
        fusion: true,
        expectedDiscount: 30,
      }),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt,
        fusion: true,
        expectedDiscount: 10,
      }),
      createProbeCondition({
        source: "fusion",
        fusionMode: "hydrafusion-max",
        planVersion: "1",
        prompt,
        expectedDiscount: 30,
      }),
      createProbeCondition({
        source: "fusion",
        fusionMode: "hydrafusion",
        planVersion: "1",
        prompt,
        expectedDiscount: 10,
      }),
    ]
    expect(new Set(conditions.map(({ id }) => id)).size).toBe(10)
  })

  test("shares fixed seed, intelligence and varied real task prompts across every request mode", () => {
    const conditions = getProbeConditions()
    expect(new Set(conditions.map(({ id }) => id)).size).toBe(conditions.length)
    const prompts = new Set(conditions.map(({ prompt }) => prompt))
    expect(prompts.has(PREWARM_PROMPT)).toBe(true)
    expect(prompts.has(TARGET_CODE_PROMPT)).toBe(true)
    for (let index = 0; index < 3; index += 1) {
      expect(prompts.has(getIntelligenceProbePrompt(index))).toBe(true)
    }
    expect(
      [...prompts].some((prompt) => prompt.includes("reads a CSV file")),
    ).toBe(true)
    expect(
      [...prompts].some((prompt) => prompt.includes("production C++ process")),
    ).toBe(true)
    expect(
      [...prompts].some((prompt) => prompt.includes("finite integral domain")),
    ).toBe(true)
    for (const prompt of prompts) {
      const modes = conditions.filter(
        (condition) => condition.prompt === prompt,
      )
      expect(
        modes
          .filter(
            (condition) =>
              condition.source === "auto" && condition.fusion !== true,
          )
          .map((condition) =>
            condition.source === "auto" ? condition.tier : undefined,
          ),
      ).toEqual(["efficiency", "balance", "intelligence", "fast"])
      expect(
        modes
          .filter(
            (condition) =>
              condition.source === "auto" && condition.fusion === true,
          )
          .map((condition) =>
            condition.source === "auto" ? condition.tier : undefined,
          ),
      ).toEqual(["balance", "intelligence", "fast"])
      expect(
        modes
          .filter(
            (condition) =>
              condition.source === "fusion"
              && condition.fusionMode === "hydrafusion",
          )
          .map((condition) =>
            condition.source === "fusion" ? condition.planVersion : undefined,
          ),
      ).toEqual(["1", "2"])
      expect(
        modes
          .filter(
            (condition) =>
              condition.source === "fusion"
              && condition.fusionMode === "hydrafusion-max",
          )
          .map((condition) =>
            condition.source === "fusion" ? condition.planVersion : undefined,
          ),
      ).toEqual(["1"])
    }
    const first = getProbeConditions()
    first[0].prompt = "caller mutation"
    first.splice(1)
    expect(getProbeConditions()).toEqual(conditions)
  })

  test("retains the configured wanted order and never appends discovery extras", () => {
    config.autoDiscovery = {
      models: ["old-model", "mai-model", "old-model", "gpt-model"],
    }
    expect(getWantedModels()).toEqual(["old-model", "mai-model", "gpt-model"])
    const wanted = getWantedModels()
    wanted.push("extra-model")
    expect(getWantedModels()).toEqual(["old-model", "mai-model", "gpt-model"])
    config.autoDiscovery = { models: ["replacement-model"] }
    expect(getWantedModels()).toEqual(["replacement-model"])
    config.autoDiscovery = undefined
    expect(getWantedModels()).toEqual([])
    config.autoDiscovery = {}
    expect(getWantedModels()).toEqual([])
  })

  test("rejects malformed configured targets rather than silently narrowing them", () => {
    for (const autoDiscovery of [
      null,
      [],
      "model",
      { models: "model" },
      { models: [""] },
      { models: ["  "] },
      { models: [1] },
    ]) {
      config.autoDiscovery = autoDiscovery
      expect(() => getWantedModels()).toThrow(TypeError)
    }
    config.autoDiscovery = undefined
  })
})
