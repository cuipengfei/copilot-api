import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Server } from "bun"
import { rejects } from "node:assert/strict"

import {
  sendCopilotHttpRequest,
  sendCopilotRequest,
} from "../src/services/copilot/request"

let server: Server<undefined>
let requestCount = 0

const transportConfig = {
  headersTimeoutMs: 5_000,
  streamInactivityTimeoutMs: 5_000,
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requestCount += 1
      const url = new URL(request.url)
      if (url.pathname === "/error") {
        return Response.json(
          { error: { message: "signature rejected" } },
          { status: 400, headers: { "x-request-id": "local-error" } },
        )
      }
      return Response.json(
        {
          method: request.method,
          payload: await request.json(),
          sessionToken: request.headers.get("Copilot-Session-Token"),
          requestId: request.headers.get("x-request-id"),
        },
        { headers: { "x-request-id": "local-success" } },
      )
    },
  })
})

afterAll(() => server.stop(true))

test("共享发送入口保留 JSON 请求、会话标识和响应 headers", async () => {
  const before = requestCount
  const payload = {
    model: "local-model",
    input: [{ role: "user", content: "保持当前请求" }],
  }
  const response = await sendCopilotRequest(server.url.href, {
    headers: {
      "content-type": "application/json",
      "Copilot-Session-Token": "local-session",
      "x-request-id": "local-request",
    },
    payload,
    transportConfig,
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("x-request-id")).toBe("local-success")
  expect(await response.json()).toEqual({
    method: "POST",
    payload,
    sessionToken: "local-session",
    requestId: "local-request",
  })
  expect(requestCount - before).toBe(1)
})

test("共享入口保留协议错误，由协议模块决定是否重试", async () => {
  const before = requestCount
  const response = await sendCopilotRequest(
    new URL("/error", server.url).href,
    {
      headers: {},
      payload: { model: "local-model" },
      transportConfig,
    },
  )

  expect(response.status).toBe(400)
  expect(response.headers.get("x-request-id")).toBe("local-error")
  expect(await response.json()).toEqual({
    error: { message: "signature rejected" },
  })
  expect(requestCount - before).toBe(1)
})

test("取消的请求不会发送到本地 HTTP server", async () => {
  const before = requestCount
  const controller = new AbortController()
  const reason = new Error("request cancelled")
  controller.abort(reason)

  await rejects(
    sendCopilotHttpRequest(server.url.href, {
      headers: {},
      payload: { model: "local-model" },
      clientSignal: controller.signal,
      transportConfig,
    }),
    (error: unknown) => error === reason,
  )
  expect(requestCount).toBe(before)
})
