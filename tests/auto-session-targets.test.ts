import { expect, test } from "bun:test"

import { parseAutoDiscoveryModels } from "../src/lib/auto-session"

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
