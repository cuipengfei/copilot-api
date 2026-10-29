import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import type { Server } from "bun"

import type { ResponsesPayload } from "../src/lib/types/responses"

import { state } from "../src/lib/state"
import { getResponseErrorMessage } from "../src/services/copilot/auto-session-retry"
import {
  hasStrippableReasoningItem,
  sendResponsesRequestWithReasoningReplay,
} from "../src/services/copilot/responses-compat"

const BELONG_MESSAGE = "input item ID does not belong to this connection"

let server: Server<undefined>
const requests: Array<{ path: string; body: string }> = []
let holdFirstBelong: (() => Promise<void>) | undefined

const transportConfig = {
  headersTimeoutMs: 5_000,
  streamInactivityTimeoutMs: 5_000,
}

const countFor = (path: string): number =>
  requests.filter((request) => request.path === path).length

type CapturedRequestBody = { input: Array<Record<string, unknown>> }

const firstBodyFor = (path: string): CapturedRequestBody => {
  const body = requests.find((request) => request.path === path)?.body
  if (body === undefined) throw new Error(`No request captured for ${path}`)
  return JSON.parse(body) as CapturedRequestBody
}

const lastBodyFor = (path: string): CapturedRequestBody => {
  const body = requests.filter((request) => request.path === path).at(-1)?.body
  if (body === undefined) throw new Error(`No request captured for ${path}`)
  return JSON.parse(body) as CapturedRequestBody
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const bodyText = await request.text()
      requests.push({ path: url.pathname, body: bodyText })

      if (
        url.pathname === "/belong-by-body"
        || url.pathname === "/belong-concurrent"
      ) {
        const body = JSON.parse(bodyText) as {
          input: Array<Record<string, unknown>>
        }
        const hasEncrypted = body.input.some(
          (item) =>
            item.type === "reasoning" && item.encrypted_content !== undefined,
        )
        if (hasEncrypted) {
          if (
            url.pathname === "/belong-concurrent"
            && countFor(url.pathname) === 1
          ) {
            await holdFirstBelong?.()
          }
          return Response.json(
            { error: { message: BELONG_MESSAGE, code: "" } },
            { status: 401 },
          )
        }
        return Response.json({ id: "resp-ok" })
      }
      if (url.pathname === "/belong-always") {
        return Response.json(
          { error: { message: BELONG_MESSAGE, code: "" } },
          { status: 401 },
        )
      }

      if (url.pathname === "/belong-retry") {
        if (countFor(url.pathname) === 1) {
          return Response.json(
            { error: { message: BELONG_MESSAGE, code: "" } },
            { status: 401 },
          )
        }
        return Response.json({ id: "resp-ok" })
      }
      if (url.pathname === "/non-belong") {
        return Response.json(
          {
            error: {
              message: "unauthorized: AuthenticateToken authentication failed",
            },
          },
          { status: 401 },
        )
      }
      if (url.pathname === "/belong-in-detail") {
        return Response.json(
          {
            error: {
              message: "input item validation failed",
              detail: "item does not belong to this connection",
            },
          },
          { status: 401 },
        )
      }
      if (url.pathname === "/belong-uppercase") {
        if (countFor(url.pathname) === 1) {
          return Response.json(
            {
              error: {
                message: "input item ID does not BELONG to this connection",
              },
            },
            { status: 401 },
          )
        }
        return Response.json({ id: "resp-ok" })
      }
      if (url.pathname === "/server-error") {
        return Response.json(
          { error: { message: BELONG_MESSAGE } },
          { status: 500 },
        )
      }
      if (url.pathname === "/non-strippable") {
        return Response.json(
          { error: { message: BELONG_MESSAGE } },
          { status: 401 },
        )
      }
      return Response.json({ id: "resp-ok" })
    },
  })
})

afterAll(() => server.stop(true))

describe("hasStrippableReasoningItem", () => {
  test("reasoning item with encrypted_content is strippable", () => {
    expect(
      hasStrippableReasoningItem({
        model: "gpt-test",
        input: [
          { role: "user", content: "hi" },
          {
            type: "reasoning",
            id: "r-1",
            summary: [],
            encrypted_content: "enc",
          },
        ],
      }),
    ).toBe(true)
  })

  test("reasoning item without encrypted_content is not strippable", () => {
    expect(
      hasStrippableReasoningItem({
        model: "gpt-test",
        input: [{ type: "reasoning", id: "r-1", summary: [] }],
      }),
    ).toBe(false)
  })

  test("payload without array input is not strippable", () => {
    expect(
      hasStrippableReasoningItem({ model: "gpt-test", input: "plain text" }),
    ).toBe(false)
  })
})

describe("getResponseErrorMessage", () => {
  test("reads string error.message from a real Response", async () => {
    const response = new Response(
      JSON.stringify({ error: { message: BELONG_MESSAGE } }),
      { status: 401 },
    )
    expect(await getResponseErrorMessage(response)).toBe(BELONG_MESSAGE)
  })

  test("returns undefined for non-string error.message", async () => {
    const response = new Response(JSON.stringify({ error: { message: 42 } }), {
      status: 401,
    })
    expect(await getResponseErrorMessage(response)).toBeUndefined()
  })

  test("returns undefined for a non-JSON body", async () => {
    const response = new Response("not json", { status: 401 })
    expect(await getResponseErrorMessage(response)).toBeUndefined()
  })
})

describe("sendResponsesRequestWithReasoningReplay", () => {
  const strippablePayload = (): ResponsesPayload => ({
    model: "gpt-test",
    input: [
      { role: "user", content: "hi" },
      {
        type: "reasoning",
        id: "r-1",
        summary: [],
        encrypted_content: "enc-abc",
      },
    ],
  })

  const urlFor = (path: string): string => new URL(path, server.url).href

  test("4xx with belong in error.message retries once with reasoning stripped", async () => {
    const payload = strippablePayload()
    const response = await sendResponsesRequestWithReasoningReplay(
      urlFor("/belong-retry"),
      { payload, headers: {}, transportConfig },
    )

    expect(response.status).toBe(200)
    expect(countFor("/belong-retry")).toBe(2)
    expect(
      firstBodyFor("/belong-retry").input.find(
        (item) => item.type === "reasoning",
      ),
    ).toMatchObject({ encrypted_content: "enc-abc" })
    expect(
      lastBodyFor("/belong-retry").input.find(
        (item) => item.type === "reasoning",
      ),
    ).toEqual({ id: "r-1", type: "reasoning", summary: [] })
    expect(
      (payload.input as Array<Record<string, unknown>>).find(
        (item) => item.type === "reasoning",
      ),
    ).not.toHaveProperty("encrypted_content")
  })

  test("4xx without belong marker does not retry", async () => {
    const response = await sendResponsesRequestWithReasoningReplay(
      urlFor("/non-belong"),
      { payload: strippablePayload(), headers: {}, transportConfig },
    )

    expect(response.status).toBe(401)
    expect(countFor("/non-belong")).toBe(1)
  })

  test("belong outside error.message does not retry", async () => {
    const response = await sendResponsesRequestWithReasoningReplay(
      urlFor("/belong-in-detail"),
      { payload: strippablePayload(), headers: {}, transportConfig },
    )

    expect(response.status).toBe(401)
    expect(countFor("/belong-in-detail")).toBe(1)
  })

  test("belong match ignores case", async () => {
    const response = await sendResponsesRequestWithReasoningReplay(
      urlFor("/belong-uppercase"),
      { payload: strippablePayload(), headers: {}, transportConfig },
    )

    expect(response.status).toBe(200)
    expect(countFor("/belong-uppercase")).toBe(2)
    expect(
      lastBodyFor("/belong-uppercase").input.find(
        (item) => item.type === "reasoning",
      ),
    ).toEqual({ id: "r-1", type: "reasoning", summary: [] })
  })

  test("non-4xx does not retry even with belong marker", async () => {
    const response = await sendResponsesRequestWithReasoningReplay(
      urlFor("/server-error"),
      { payload: strippablePayload(), headers: {}, transportConfig },
    )

    expect(response.status).toBe(500)
    expect(countFor("/server-error")).toBe(1)
  })

  test("4xx with belong does not retry when payload has no encrypted_content", async () => {
    const response = await sendResponsesRequestWithReasoningReplay(
      urlFor("/non-strippable"),
      {
        payload: {
          model: "gpt-test",
          input: [{ role: "user", content: "hi" }],
        },
        headers: {},
        transportConfig,
      },
    )

    expect(response.status).toBe(401)
    expect(countFor("/non-strippable")).toBe(1)
  })

  test("success on first send does not retry", async () => {
    const response = await sendResponsesRequestWithReasoningReplay(
      urlFor("/ok"),
      { payload: strippablePayload(), headers: {}, transportConfig },
    )

    expect(response.status).toBe(200)
    expect(countFor("/ok")).toBe(1)
  })
})

describe("reasoning replay learning cache", () => {
  const urlFor = (path: string): string => new URL(path, server.url).href

  const payloadFor = (model: string): ResponsesPayload => ({
    model,
    input: [
      { role: "user", content: "hi" },
      {
        type: "reasoning",
        id: "r-1",
        summary: [],
        encrypted_content: "enc-abc",
      },
    ],
  })

  const sendCounted = async (
    path: string,
    identity: string | undefined,
    {
      model = "gpt-test",
      headers = {},
    }: { model?: string; headers?: Record<string, string> } = {},
  ): Promise<{ response: Response; attempts: number }> => {
    const before = countFor(path)
    const response = await sendResponsesRequestWithReasoningReplay(
      urlFor(path),
      {
        payload: payloadFor(model),
        headers,
        transportConfig,
        reasoningReplayIdentity: identity,
      },
    )
    return { response, attempts: countFor(path) - before }
  }

  const attemptBody = (path: string, index: number): CapturedRequestBody => {
    const body = requests.filter((request) => request.path === path)[index]
      ?.body
    if (body === undefined) throw new Error(`No attempt ${index} for ${path}`)
    return JSON.parse(body) as CapturedRequestBody
  }

  beforeEach(() => {
    state.responsesReplayLearned.clear()
  })

  test("learns genuine belong failures and skips the first attempt next time", async () => {
    const first = await sendCounted("/belong-by-body", "session-a")
    expect(first.response.status).toBe(200)
    expect(first.attempts).toBe(2)

    const second = await sendCounted("/belong-by-body", "session-a")
    expect(second.response.status).toBe(200)
    expect(second.attempts).toBe(1)
    expect(countFor("/belong-by-body")).toBe(3)
    expect(
      attemptBody("/belong-by-body", 2).input.find(
        (item) => item.type === "reasoning",
      ),
    ).toEqual({ id: "r-1", type: "reasoning", summary: [] })
  })

  test("does not share learnings across identities", async () => {
    expect((await sendCounted("/belong-by-body", "session-a")).attempts).toBe(2)
    expect((await sendCounted("/belong-by-body", "session-b")).attempts).toBe(2)
  })

  test("does not share learnings across models", async () => {
    const modelA = await sendCounted("/belong-by-body", "session-a", {
      model: "model-a",
    })
    const modelB = await sendCounted("/belong-by-body", "session-a", {
      model: "model-b",
    })
    expect(modelA.attempts).toBe(2)
    expect(modelB.attempts).toBe(2)
  })

  test("does not learn or reuse anything without an identity", async () => {
    expect((await sendCounted("/belong-by-body", undefined)).attempts).toBe(2)
    expect((await sendCounted("/belong-by-body", undefined)).attempts).toBe(2)
    expect(state.responsesReplayLearned.size).toBe(0)
  })

  test("does not share learnings across auth scopes", async () => {
    const authA = { headers: { Authorization: "Bearer account-a" } }
    const authB = { headers: { Authorization: "Bearer account-b" } }
    expect(
      (await sendCounted("/belong-by-body", "session-a", authA)).attempts,
    ).toBe(2)
    expect(
      (await sendCounted("/belong-by-body", "session-a", authB)).attempts,
    ).toBe(2)
    const lowercaseAuth = {
      headers: { authorization: "Bearer account-a" },
    }
    const relabeled = await sendCounted(
      "/belong-by-body",
      "session-a",
      lowercaseAuth,
    )
    expect(relabeled.attempts).toBe(1)
  })

  test("缓存保留凭据摘要且同一凭据复用已学习记录", async () => {
    const token = "local-sensitive-replay-token"
    const headers = { Authorization: `Bearer ${token}` }
    expect(
      (await sendCounted("/belong-by-body", "session-private", { headers }))
        .attempts,
    ).toBe(2)
    expect(Array.from(state.responsesReplayLearned).join("\n")).not.toContain(
      token,
    )
    expect(
      (await sendCounted("/belong-by-body", "session-private", { headers }))
        .attempts,
    ).toBe(1)
  })

  test("does not learn from non-belong, non-message, or non-4xx failures", async () => {
    expect((await sendCounted("/non-belong", "session-a")).attempts).toBe(1)
    expect((await sendCounted("/belong-in-detail", "session-a")).attempts).toBe(
      1,
    )
    expect((await sendCounted("/server-error", "session-a")).attempts).toBe(1)
    expect(state.responsesReplayLearned.size).toBe(0)
  })

  test("keeps the original error response readable after the belong check", async () => {
    const { response } = await sendCounted("/non-belong", "session-a")
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("unauthorized")
  })

  test("does not loop when the retry also fails", async () => {
    expect((await sendCounted("/belong-always", "session-a")).attempts).toBe(2)
    expect((await sendCounted("/belong-always", "session-a")).attempts).toBe(1)
    expect(state.responsesReplayLearned.size).toBe(1)
  })

  test("并发重复学习保留首次插入顺序，最早身份被淘汰后重新尝试", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    holdFirstBelong = async () => {
      entered.resolve()
      await release.promise
    }
    const heldRequest = sendResponsesRequestWithReasoningReplay(
      urlFor("/belong-concurrent"),
      {
        payload: payloadFor("gpt-test"),
        headers: {},
        transportConfig,
        reasoningReplayIdentity: "concurrent",
      },
    )
    try {
      await entered.promise
      expect(
        (await sendCounted("/belong-concurrent", "concurrent")).attempts,
      ).toBe(2)
      for (let index = 0; index < 1023; index += 1) {
        state.responsesReplayLearned.add(`seed-${index}`)
      }
      release.resolve()
      expect((await heldRequest).status).toBe(200)
      expect(
        (await sendCounted("/belong-concurrent", "overflow")).attempts,
      ).toBe(2)
      expect(
        (await sendCounted("/belong-concurrent", "concurrent")).attempts,
      ).toBe(2)
    } finally {
      release.resolve()
      holdFirstBelong = undefined
      await heldRequest
    }
  })

  test("bounds the learning cache at 1024 entries with FIFO eviction", async () => {
    for (let index = 0; index < 1024; index += 1) {
      state.responsesReplayLearned.add(`seed-${index}`)
    }

    expect((await sendCounted("/belong-by-body", "overflow")).attempts).toBe(2)
    expect(state.responsesReplayLearned.size).toBe(1024)
    expect(state.responsesReplayLearned.has("seed-0")).toBe(false)
    expect(state.responsesReplayLearned.has("seed-1")).toBe(true)
    expect((await sendCounted("/belong-by-body", "overflow")).attempts).toBe(1)
  })
})
