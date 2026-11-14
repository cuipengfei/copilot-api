import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { z } from "zod"

import type { ProbeObservation } from "~/lib/auto-probe-history"

const config = {
  autoDiscovery: { models: ["wanted-a", "wanted-b", "wanted-a"] },
}
await mock.module("~/lib/config-store", () => ({ getConfig: () => config }))
// Load after installing the config boundary mock so tests never read user configuration.
const { createProbeCondition, getWantedModels } =
  await import("~/lib/auto-probe-prompts")
const { openProbeHistory, getRankedProbeConditions } =
  await import("~/lib/auto-probe-history")

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-probe-history-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const auto = (prompt: string, tier: "balance" | "fast" = "balance") =>
  createProbeCondition({ source: "auto", tier, prompt })
const fusion = (prompt: string, planVersion: "1" | "2" = "2") =>
  createProbeCondition({
    source: "fusion",
    fusionMode: "hydrafusion",
    planVersion,
    prompt,
  })
const selected = (
  condition: ProbeObservation["condition"],
  modelIds = ["wanted-a"],
  observedAt = "2026-11-13T17:18:27.984Z",
): ProbeObservation => ({
  condition,
  observedAt,
  outcome: "selected",
  modelIds,
})
const directory = (writer = "runtime", instance = "listen-4142") =>
  path.join(root, instance, writer)
const open = (writer = "runtime", instanceId = "listen-4142") =>
  openProbeHistory({ instanceId, writer, root })

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function rejection(pending: Promise<unknown>): Promise<Error> {
  const error = await pending.then(
    () => undefined,
    (failure: unknown) => failure,
  )
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) {
    throw new Error("Expected promise to reject with Error")
  }
  return error
}

describe("probe history publication", () => {
  test("opens a missing namespace as an empty library without creating files", async () => {
    const store = await open()
    expect(store.conditions).toEqual([])
    expect(store.observations).toEqual([])
    await store.flush()
    expect(await exists(directory())).toBe(false)
  })

  test("records concurrent observations without losing runs or prompt variants", async () => {
    const store = await open()
    const inputs = Array.from({ length: 24 }, (_, index) =>
      selected(
        auto(`full prompt ${index}\r\nsource text\n`),
        [index % 2 === 0 ? "wanted-a" : "extra-model"],
        `2026-11-13T17:18:${String(index).padStart(2, "0")}.000Z`,
      ),
    )
    await Promise.all(inputs.map((input) => store.record(input)))
    await store.flush()
    expect(store.conditions).toHaveLength(24)
    expect(store.observations).toHaveLength(24)
    const reopened = await open()
    expect(reopened.conditions.map(({ prompt }) => prompt).sort()).toEqual(
      inputs.map(({ condition }) => condition.prompt).sort(),
    )
    expect(reopened.observations).toHaveLength(24)
    const lines = (
      await fs.readFile(path.join(directory(), "runs/2026-11-13.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
    expect(lines).toHaveLength(24)
    const journalSchema = z.object({ conditionId: z.string() })
    expect(
      new Set(
        lines.map(
          (line) =>
            journalSchema.parse(JSON.parse(line) as unknown).conditionId,
        ),
      ).size,
    ).toBe(24)
  })

  test("keeps complete probe source files private to the current user", async () => {
    const store = await open()
    await store.record(selected(auto("private complete source text")))
    for (const [filePath, mode] of [
      [directory(), 0o700],
      [path.join(directory(), "runs"), 0o700],
      [path.join(directory(), "conditions.json"), 0o600],
      [path.join(directory(), "runs/2026-11-13.jsonl"), 0o600],
    ] as const) {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(mode)
    }
  })

  test("replays complete conditions across dates with UTC journals and no live credentials", async () => {
    const store = await open()
    const condition = fusion("  exact replay\r\nbody\n", "1")
    await store.record({
      ...selected(
        condition,
        ["wanted-a", "extra-model"],
        "2026-11-13T23:30:00-02:00",
      ),
      pairedModelIds: ["extra-model"],
      scores: { debugging: 0.8 },
      generation: [
        { modelId: "extra-model", accepted: true, discountPercent: 30 },
      ],
    })
    await store.record(
      selected(condition, ["wanted-b"], "2026-11-15T01:00:00.000Z"),
    )
    const reopened = await open()
    expect(reopened.conditions).toEqual([condition])
    expect(reopened.observations.map(({ observedAt }) => observedAt)).toEqual([
      "2026-11-14T01:30:00.000Z",
      "2026-11-15T01:00:00.000Z",
    ])
    expect(reopened.observations[0].generation).toEqual([
      { modelId: "extra-model", accepted: true, discountPercent: 30 },
    ])
    expect(await exists(path.join(directory(), "runs/2026-11-13.jsonl"))).toBe(
      false,
    )
    const journal = await fs.readFile(
      path.join(directory(), "runs/2026-11-14.jsonl"),
      "utf8",
    )
    expect(journal).not.toContain("exact replay")
    expect(journal).not.toContain("sessionToken")
    expect(journal).not.toContain("prompt")
  })

  test("isolates writers and instances while merging deduplicated observations", async () => {
    const runtime = await open()
    const tester = await open("tester-fixture-one")
    const other = await open("runtime", "listen-4143")
    const condition = auto("shared condition")
    const observation = selected(condition)
    await Promise.all([
      runtime.record(observation),
      tester.record({
        ...observation,
        scores: { reasoning: 0.7, debugging: 0.5 },
      }),
      tester.record({
        ...observation,
        scores: { debugging: 0.5, reasoning: 0.7 },
      }),
      other.record(selected(auto("other instance"))),
    ])
    const merged = await open("tester-fixture-two")
    expect(merged.conditions).toEqual([condition])
    expect(merged.observations).toHaveLength(2)
    expect((await open("runtime", "listen-4143")).conditions).toEqual([
      auto("other instance"),
    ])
    const runtimeFile = await fs.readFile(
      path.join(directory(), "conditions.json"),
      "utf8",
    )
    await merged.record(selected(auto("new tester condition")))
    expect(
      await fs.readFile(path.join(directory(), "conditions.json"), "utf8"),
    ).toBe(runtimeFile)
    const ownFile = z
      .object({ conditions: z.array(z.unknown()) })
      .parse(
        JSON.parse(
          await fs.readFile(
            path.join(directory("tester-fixture-two"), "conditions.json"),
            "utf8",
          ),
        ) as unknown,
      )
    expect(ownFile.conditions).toEqual([auto("new tester condition")])
    expect((await open()).conditions).toHaveLength(2)
  })

  test("keeps identical prompt source, tier and version histories separate", async () => {
    const store = await open()
    const conditions = [
      auto("hello"),
      auto("hello", "fast"),
      fusion("hello", "1"),
      fusion("hello", "2"),
    ]
    await Promise.all(
      conditions.map((condition) => store.record(selected(condition))),
    )
    const reopened = await open()
    expect(reopened.conditions).toHaveLength(4)
    expect(
      new Set(reopened.observations.map(({ condition }) => condition.id)).size,
    ).toBe(4)
  })

  test("never overwrites corrupted conditions or malformed hashes on reload", async () => {
    const store = await open()
    await store.record(selected(auto("original prompt")))
    const filePath = path.join(directory(), "conditions.json")
    for (const [corrupt, errorType, message] of [
      [
        "{incomplete ghp_abcdefghijklmno",
        Error,
        `Invalid probe history file: ${filePath}`,
      ],
      [
        JSON.stringify({
          schemaVersion: 1,
          conditions: [
            { ...auto("original prompt"), prompt: "tampered prompt" },
          ],
        }),
        TypeError,
        "Probe history condition hash mismatch",
      ],
      [
        JSON.stringify({
          schemaVersion: 1,
          conditions: [{ ...auto("original prompt"), tier: "unknown" }],
        }),
        Error,
        `Invalid probe history file: ${filePath}`,
      ],
    ] as const) {
      await fs.writeFile(filePath, corrupt)
      const error = await rejection(open())
      expect(error).toBeInstanceOf(errorType)
      expect(error.message).toBe(message)
      expect(await fs.readFile(filePath, "utf8")).toBe(corrupt)
    }
  })

  test("stops an open writer if its conditions file is changed underneath it", async () => {
    const store = await open()
    await store.record(selected(auto("original prompt")))
    const filePath = path.join(directory(), "conditions.json")
    await fs.writeFile(filePath, "{externally-corrupted")
    const error = await rejection(store.record(selected(auto("new prompt"))))
    expect(error.message).toContain("changed")
    expect(await rejection(store.flush())).toBe(error)
    expect(await fs.readFile(filePath, "utf8")).toBe("{externally-corrupted")
  })

  test("reports damaged journals and missing condition references without changing evidence", async () => {
    const store = await open()
    await store.record(selected(auto("prompt")))
    const journalPath = path.join(directory(), "runs/2026-11-13.jsonl")
    for (const corrupt of [
      "{truncated\n",
      JSON.stringify({
        conditionId: auto("absent prompt").id,
        observedAt: "2026-11-13T12:00:00.000Z",
        outcome: "selected",
        modelIds: ["wanted-a"],
      }) + "\n",
      JSON.stringify({
        conditionId: auto("prompt").id,
        observedAt: "2026-11-14T12:00:00.000Z",
        outcome: "selected",
        modelIds: ["wanted-a"],
      }) + "\n",
    ]) {
      await fs.writeFile(journalPath, corrupt)
      const error = await rejection(open())
      expect(error.message).toBe(`Invalid probe history file: ${journalPath}`)
      expect(await fs.readFile(journalPath, "utf8")).toBe(corrupt)
    }
  })

  test("refuses current secrets before creating files and follows the caller's rotating secret list", async () => {
    const secrets = ["active-credential-one"]
    const store = await openProbeHistory({
      instanceId: "listen-4142",
      root,
      secrets,
    })
    secrets[0] = "active-credential-two"
    const error = await rejection(
      store.record(selected(auto("source active-credential-two source"))),
    )
    expect(error.message).toContain("credential")
    expect(await exists(directory())).toBe(false)
    await store.flush()
    await store.record(
      selected(auto('headers: { authorization: "Bearer admin-key" }')),
    )
    expect((await open()).conditions[0].prompt).toBe(
      'headers: { authorization: "Bearer admin-key" }',
    )
    for (const prompt of [
      "ghp_abcdefghijklmno",
      "tid=123;exp=1234567890;sku=business:signature",
    ]) {
      const fresh = await open("tester-secret-check")
      const credentialError = await rejection(
        fresh.record(selected(auto(prompt))),
      )
      expect(credentialError.message).toContain("credential")
      expect(await exists(directory("tester-secret-check"))).toBe(false)
    }
  })

  test("rejects an unsafe observation without poisoning valid queued history", async () => {
    const store = await openProbeHistory({
      instanceId: "listen-4142",
      root,
      secrets: ["active-private-value"],
    })
    const valid = selected(
      auto("complete source with an example Bearer admin-key"),
    )
    await store.record(valid)
    const error = await rejection(
      store.record(selected(auto("active-private-value"))),
    )
    expect(error).toBeInstanceOf(TypeError)
    await store.record(selected(auto("valid next prompt")))
    await store.flush()
    expect((await open()).conditions.map(({ prompt }) => prompt)).toEqual([
      valid.condition.prompt,
      "valid next prompt",
    ])
  })

  test("checks newly known credentials before a queued publication", async () => {
    const secrets: Array<string> = []
    const store = await openProbeHistory({
      instanceId: "listen-4142",
      root,
      secrets,
    })
    const pending = store.record(selected(auto("queued-private-value")))
    secrets.push("queued-private-value")
    expect(await rejection(pending)).toBeInstanceOf(TypeError)
    await store.record(selected(auto("safe following source")))
    await store.flush()
    expect((await open()).conditions.map(({ prompt }) => prompt)).toEqual([
      "safe following source",
    ])
  })

  test("rejects secrets already persisted when they become known at reload", async () => {
    const store = await open()
    await store.record(selected(auto("source now-known-private-value")))
    const filePath = path.join(directory(), "conditions.json")
    const original = await fs.readFile(filePath, "utf8")
    const error = await rejection(
      openProbeHistory({
        instanceId: "listen-4142",
        root,
        secrets: ["now-known-private-value"],
      }),
    )
    expect(error.message).toContain("credential")
    expect(await fs.readFile(filePath, "utf8")).toBe(original)
  })

  test("whitelists observation output and refuses credentials in metadata", async () => {
    const store = await open()
    const input = {
      ...selected(auto("safe source")),
      sessionToken: "not-persisted-session",
      token: "not-persisted-token",
      response: { body: "not-persisted-response" },
      payload: "not-persisted-payload",
      generation: [
        { modelId: "wanted-a", accepted: true, token: "not-persisted-nested" },
      ],
    }
    await store.record(input)
    const journal = await fs.readFile(
      path.join(directory(), "runs/2026-11-13.jsonl"),
      "utf8",
    )
    expect(journal).not.toContain("not-persisted")
    expect((await open()).observations[0].generation).toEqual([
      { modelId: "wanted-a", accepted: true },
    ])
    const fresh = await openProbeHistory({
      instanceId: "listen-4143",
      root,
      secrets: ["metadata-private-value"],
    })
    const error = await rejection(
      fresh.record({
        ...selected(auto("safe")),
        errorCode: "metadata-private-value",
      }),
    )
    expect(error.message).toContain("credential")
    expect(await exists(directory("runtime", "listen-4143"))).toBe(false)
  })

  test("rejects invalid schemas and surfaces append errors through record and flush", async () => {
    const store = await open()
    const schemaError = await rejection(
      store.record({
        ...selected(auto("prompt")),
        scores: [],
      } as unknown as ProbeObservation),
    )
    expect(schemaError).toBeInstanceOf(TypeError)
    expect(schemaError.message).toBe("Invalid probe observation")
    const dateError = await rejection(
      store.record({ ...selected(auto("prompt")), observedAt: "not-a-date" }),
    )
    expect(dateError).toBeInstanceOf(TypeError)
    expect(dateError.message).toBe("Invalid probe observation")
    await fs.mkdir(directory(), { recursive: true })
    await fs.writeFile(path.join(directory(), "runs"), "not a directory")
    const writeError = await rejection(store.record(selected(auto("prompt"))))
    expect(await rejection(store.flush())).toBe(writeError)
    expect(store.observations).toEqual([])
    expect(await fs.readFile(path.join(directory(), "runs"), "utf8")).toBe(
      "not a directory",
    )
    expect(
      (await fs.readdir(directory())).some((name) => name.endsWith(".tmp")),
    ).toBe(false)
  })

  test("rejects unsafe or unsupported writer and instance paths", async () => {
    for (const instanceId of [
      "",
      ".",
      "..",
      "../other",
      "listen/4142",
      "listen\\4142",
    ]) {
      expect(
        await rejection(openProbeHistory({ instanceId, root })),
      ).toBeInstanceOf(TypeError)
    }
    for (const writer of [
      "",
      "../other",
      "tester-../other",
      "tester-",
      "unknown",
    ]) {
      expect(await rejection(open(writer))).toBeInstanceOf(TypeError)
    }
  })
})

describe("historical condition ranking", () => {
  test("interleaves missing-model history with ordinary candidates without changing wanted", async () => {
    const store = await open()
    const knownA = auto("historical wanted a")
    const knownB = auto("historical wanted b", "fast")
    const irrelevant = auto("extra model only")
    const newA = auto("new csv task")
    const newB = auto("new debugging task", "fast")
    const wrongSource = fusion("fusion history", "1")
    await Promise.all([
      store.record(selected(knownA, ["wanted-a"])),
      store.record(selected(knownB, ["wanted-b"])),
      store.record(selected(irrelevant, ["extra-model"])),
      store.record(selected(wrongSource, ["wanted-a"])),
    ])
    const wanted = getWantedModels()
    const candidates = [newA, newB, irrelevant, wrongSource]
    const before = candidates.slice()
    const ranked = getRankedProbeConditions({
      source: "auto",
      conditions: candidates,
      observations: (await open()).observations,
      missingModels: wanted,
    })
    expect(ranked.map(({ id }) => id)).toEqual([
      knownA.id,
      newA.id,
      knownB.id,
      newB.id,
      irrelevant.id,
    ])
    expect(ranked.every(({ source }) => source === "auto")).toBe(true)
    expect(candidates).toEqual(before)
    expect(getWantedModels()).toEqual(["wanted-a", "wanted-b"])
    expect(wanted).toEqual(["wanted-a", "wanted-b"])
    expect(
      getRankedProbeConditions({
        source: "fusion",
        conditions: candidates,
        observations: store.observations,
        missingModels: wanted,
      }),
    ).toEqual([wrongSource])
  })

  test("does not promote errors or historical extras into missing-model relevance", () => {
    const stale = auto("formerly relevant")
    const ordinary = auto("ordinary candidate")
    const extra = auto("historical extra")
    const input = {
      source: "auto" as const,
      conditions: [ordinary, extra, stale],
      missingModels: ["wanted-b"],
      observations: [
        selected(stale, ["wanted-a"]),
        { ...selected(extra, ["wanted-b"]), outcome: "error" as const },
      ],
    }
    expect(getRankedProbeConditions(input)).toEqual([ordinary, extra, stale])
    expect(getRankedProbeConditions({ ...input, missingModels: [] })).toEqual([
      ordinary,
      extra,
      stale,
    ])
  })
})
