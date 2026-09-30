import { describe, expect, test } from "bun:test"

import {
  mapAnthropicEffortToResponses,
  resolveEffortForLog,
} from "../src/lib/config"

describe("mapAnthropicEffortToResponses", () => {
  test("maps max to xhigh", () => {
    expect(mapAnthropicEffortToResponses("max")).toBe("xhigh")
  })

  test("maps high to high", () => {
    expect(mapAnthropicEffortToResponses("high")).toBe("high")
  })

  test("maps medium to medium", () => {
    expect(mapAnthropicEffortToResponses("medium")).toBe("medium")
  })

  test("maps low to low", () => {
    expect(mapAnthropicEffortToResponses("low")).toBe("low")
  })
})

describe("resolveEffortForLog", () => {
  test("returns request effort when provided", () => {
    expect(resolveEffortForLog("high", "any-model")).toEqual({
      value: "high",
      source: "request",
    })
  })

  test("falls back to config effort when request missing", () => {
    expect(resolveEffortForLog(undefined, "model-not-in-config")).toEqual({
      value: "high",
      source: "config",
    })
  })
})
