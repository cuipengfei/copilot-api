import { createHash } from "node:crypto"
import { describe, expect, mock, test } from "bun:test"

const config: { autoDiscovery?: unknown } = {}
await mock.module("~/lib/config-store", () => ({ getConfig: () => config }))
// Load after installing the config boundary mock so tests never read user configuration.

const {
  createProbeCondition,
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
    ]
    expect(new Set(conditions.map(({ id }) => id)).size).toBe(6)
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
          .filter((condition) => condition.source === "auto")
          .map((condition) =>
            condition.source === "auto" ? condition.tier : undefined,
          ),
      ).toEqual(["efficiency", "balance", "intelligence", "fast"])
      expect(
        modes
          .filter((condition) => condition.source === "fusion")
          .map((condition) =>
            condition.source === "fusion" ? condition.planVersion : undefined,
          ),
      ).toEqual(["1", "2"])
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
