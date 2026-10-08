import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Server } from "bun"

import type { ResponsesPayload } from "../src/lib/types/responses"
import { getResponseErrorMessage } from "../src/services/copilot/auto-session-retry"
import {
  hasStrippableReasoningItem,
  sendResponsesRequestWithReasoningReplay,
} from "../src/services/copilot/responses-compat"

const BELONG_MESSAGE = "input item ID does not belong to this connection"

let server: Server<undefined>
const requests: Array<{ path: string; body: string }> = []

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
      requests.push({ path: url.pathname, body: await request.text() })

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
