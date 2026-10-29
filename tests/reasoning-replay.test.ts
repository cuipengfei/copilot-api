import { describe, expect, test } from "bun:test"

import { getReasoningReplayIdentity } from "../src/lib/reasoning-replay"

function headers(init: Record<string, string>): Headers {
  return new Headers(init)
}

describe("getReasoningReplayIdentity", () => {
  test("uses the first non-empty primary session header", () => {
    const identity = getReasoningReplayIdentity(
      headers({
        "x-session-id": "s1",
        "x-claude-code-session-id": "s2",
        "session-id": "s3",
        session_id: "s4",
      }),
    )

    expect(identity).toBe(JSON.stringify(["s1", "_"]))
  })

  test("falls through primary headers in order", () => {
    expect(
      getReasoningReplayIdentity(
        headers({ "x-claude-code-session-id": "s2", session_id: "s4" }),
      ),
    ).toBe(JSON.stringify(["s2", "_"]))
    expect(getReasoningReplayIdentity(headers({ "session-id": "s3" }))).toBe(
      JSON.stringify(["s3", "_"]),
    )
    expect(getReasoningReplayIdentity(headers({ session_id: "s4" }))).toBe(
      JSON.stringify(["s4", "_"]),
    )
  })

  test("skips blank and whitespace-only header values", () => {
    const identity = getReasoningReplayIdentity(
      headers({ "x-session-id": "   ", "x-claude-code-session-id": " s2\t" }),
    )

    expect(identity).toBe(JSON.stringify(["s2", "_"]))
  })

  test("prefers primary headers over an explicit promptCacheKey", () => {
    const identity = getReasoningReplayIdentity(
      headers({ "x-session-id": "header-session" }),
      "cache-key",
    )

    expect(identity).toBe(JSON.stringify(["header-session", "_"]))
  })

  test("uses promptCacheKey before the fallback headers", () => {
    const identity = getReasoningReplayIdentity(
      headers({ "x-root-session-id": "root-session" }),
      "cache-key",
    )

    expect(identity).toBe(JSON.stringify(["cache-key", "_"]))
  })

  test("ignores blank promptCacheKey and continues to fallback headers", () => {
    const identity = getReasoningReplayIdentity(
      headers({ "x-root-session-id": "root-session" }),
      "  ",
    )

    expect(identity).toBe(JSON.stringify(["root-session", "_"]))
  })

  test("uses fallback headers in order", () => {
    const order = [
      ["x-root-session-id", "root-session"],
      ["x-opencode-session-id", "opencode-session"],
      ["x-session-affinity", "affinity"],
      ["x-client-request-id", "request-id"],
      ["thread-id", "thread"],
    ] as const

    for (const [index, [name, value]] of order.entries()) {
      const onlyThis = new Headers({ [name]: value })
      expect(getReasoningReplayIdentity(onlyThis)).toBe(
        JSON.stringify([value, "_"]),
      )

      const withLater = new Headers({
        [name]: value,
        ...Object.fromEntries(order.slice(index + 1)),
      })
      expect(getReasoningReplayIdentity(withLater)).toBe(
        JSON.stringify([value, "_"]),
      )
    }
  })

  test("trims the agent header and defaults to underscore", () => {
    expect(
      getReasoningReplayIdentity(
        headers({ "x-session-id": "s1", "x-oc-agent": " build " }),
      ),
    ).toBe(JSON.stringify(["s1", "build"]))
    expect(
      getReasoningReplayIdentity(
        headers({ "x-session-id": "s1", "x-oc-agent": "  " }),
      ),
    ).toBe(JSON.stringify(["s1", "_"]))
  })

  test("keeps colon-bearing session and agent values distinct", () => {
    const first = getReasoningReplayIdentity(
      headers({ "x-session-id": "a:b", "x-oc-agent": "c" }),
    )
    const second = getReasoningReplayIdentity(
      headers({ "x-session-id": "a", "x-oc-agent": "b:c" }),
    )

    expect(first).not.toBe(second)
    expect(first).toBe(JSON.stringify(["a:b", "c"]))
    expect(second).toBe(JSON.stringify(["a", "b:c"]))
  })

  test("does not derive identity from unrelated headers", () => {
    expect(
      getReasoningReplayIdentity(
        headers({
          "x-oc-agent": "build",
          "user-agent": "client/1.0",
          "x-request-id": "abc",
        }),
      ),
    ).toBeUndefined()
  })

  test("returns undefined without any session source", () => {
    expect(getReasoningReplayIdentity(new Headers())).toBeUndefined()
    expect(getReasoningReplayIdentity(new Headers(), null)).toBeUndefined()
    expect(getReasoningReplayIdentity(new Headers(), "")).toBeUndefined()
  })
})
