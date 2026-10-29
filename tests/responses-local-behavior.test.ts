import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { rejects } from "node:assert/strict"

import consola from "consola"

import { HTTPError } from "~/lib/error"
import type { ResponsesPayload } from "~/lib/types/responses"
import {
  createResponsesStreamErrorEvent,
  prepareNativeResponsesRequest,
  retryResponsesWithoutImages,
  shouldUseChatFallback,
} from "~/routes/responses/local-behavior"

const CONFIG_DEFAULT_MODEL = "local-effort-config-default"

const requests: Array<ResponsesPayload> = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const payload = (await request.json()) as ResponsesPayload
    requests.push(payload)
    return Response.json(payload, {
      headers: { "x-request-id": "image-retry" },
    })
  },
})

afterEach(() => {
  requests.length = 0
})

afterAll(() => server.stop(true))

const payloadWithImage = (): ResponsesPayload => ({
  model: "gpt-image",
  reasoning: { effort: "high" },
  input: [
    {
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
      ],
    },
  ],
})

describe("Responses 本地分派条件", () => {
  test.each(["/chat/completions", "/v1/chat/completions"])(
    "仅 Chat 能力 %s 使用 Chat fallback",
    (endpoint) => {
      expect(
        shouldUseChatFallback({
          userAgent: "client",
          selectedModel: { supported_endpoints: [endpoint] },
          responsesTransport: null,
        }),
      ).toBe(true)
    },
  )

  test("Codex、原生 Responses 和 Messages 的优先级保持", () => {
    const selectedModel = { supported_endpoints: ["/chat/completions"] }
    expect(
      shouldUseChatFallback({
        userAgent: "codex_cli_rs/0.1.0",
        selectedModel,
        responsesTransport: null,
      }),
    ).toBe(false)
    expect(
      shouldUseChatFallback({
        userAgent: "client",
        selectedModel,
        responsesTransport: "http",
      }),
    ).toBe(false)
    expect(
      shouldUseChatFallback({
        userAgent: "client",
        selectedModel: {
          supported_endpoints: ["/v1/messages", "/chat/completions"],
        },
        responsesTransport: null,
      }),
    ).toBe(false)
    expect(
      shouldUseChatFallback({
        userAgent: "client",
        selectedModel: undefined,
        responsesTransport: null,
      }),
    ).toBe(false)
  })
})

const prepareWithLog = (
  payload: ResponsesPayload,
  supportedEfforts: Array<string> | undefined,
): Array<string> => {
  const info = spyOn(consola, "info")
  try {
    prepareNativeResponsesRequest({ payload, supportedEfforts })
    return info.mock.calls.map((args) => String(args[0]))
  } finally {
    info.mockRestore()
  }
}

test("显式 effort 优先于能力收敛且保留其它 reasoning 字段", () => {
  const payload: ResponsesPayload = {
    model: "gpt-image",
    reasoning: { effort: "high", summary: "detailed" },
    input: "hello",
  }
  const logs = prepareWithLog(payload, ["low", "medium"])
  expect(payload.reasoning).toEqual({ effort: "high", summary: "detailed" })
  expect(logs).toContain("IN gpt-image [effort=high (request)]")
})

test("缺少能力列表时配置默认值照旧注入并保留 summary", () => {
  const payload: ResponsesPayload = {
    model: CONFIG_DEFAULT_MODEL,
    reasoning: { summary: "detailed" },
    input: "hello",
  }
  const logs = prepareWithLog(payload, undefined)
  expect(payload.reasoning).toEqual({ effort: "high", summary: "detailed" })
  expect(logs).toContain(`IN ${CONFIG_DEFAULT_MODEL} [effort=high (config)]`)
})

test("空能力列表不注入配置默认值，日志记录 unsupported", () => {
  const withSummary: ResponsesPayload = {
    model: CONFIG_DEFAULT_MODEL,
    reasoning: { summary: "detailed" },
    input: "hello",
  }
  const logs = prepareWithLog(withSummary, [])
  expect(withSummary.reasoning).toEqual({ summary: "detailed" })
  expect(logs).toContain(
    `IN ${CONFIG_DEFAULT_MODEL} [effort=unsupported (config)]`,
  )

  const withoutReasoning: ResponsesPayload = {
    model: CONFIG_DEFAULT_MODEL,
    input: "hello",
  }
  prepareWithLog(withoutReasoning, [])
  expect(withoutReasoning.reasoning).toBeUndefined()
})

test("非空能力列表把配置默认值向下收敛并记录实际发送值", () => {
  const payload: ResponsesPayload = {
    model: CONFIG_DEFAULT_MODEL,
    input: "hello",
  }
  const logs = prepareWithLog(payload, ["minimal", "low"])
  expect(payload.reasoning).toEqual({ effort: "low" })
  expect(logs).toContain(`IN ${CONFIG_DEFAULT_MODEL} [effort=low (config)]`)
})

test("413 图片重试通过真实 HTTP 保留输入并使用已有图片清理", async () => {
  const payload = payloadWithImage()
  const rejected = new HTTPError(
    "too large",
    new Response(null, { status: 413 }),
  )
  const result = await retryResponsesWithoutImages({
    error: rejected,
    payload,
    retry: async () => {
      const response = await fetch(server.url, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      return (await response.json()) as ResponsesPayload
    },
  })
  expect(requests).toHaveLength(1)
  expect(result.model).toBe("gpt-image")
  expect(result.reasoning).toEqual({ effort: "high" })
  expect(result.input).toEqual(payload.input)
  const input = result.input as Array<{
    content: Array<{ image_url: string; detail: string }>
  }>
  expect(input[0].content[0].detail).toBe("low")
  expect(input[0].content[0].image_url).not.toBe(
    "data:image/png;base64,aGVsbG8=",
  )
})

test("无图片或非 413 错误不执行请求", async () => {
  for (const options of [
    {
      error: new HTTPError("too large", new Response(null, { status: 413 })),
      payload: { model: "gpt-image", input: "text" },
    },
    {
      error: new HTTPError("bad request", new Response(null, { status: 400 })),
      payload: payloadWithImage(),
    },
    { error: new Error("network"), payload: payloadWithImage() },
  ]) {
    await rejects(
      retryResponsesWithoutImages({
        ...options,
        retry: () => fetch(server.url),
      }),
      (error: unknown) => error === options.error,
    )
  }
  expect(requests).toHaveLength(0)
})

test("图片重试失败直接传播且仅调用一次", async () => {
  const error = new HTTPError("too large", new Response(null, { status: 413 }))
  const failure = new Error("second request failed")
  let attempts = 0
  await rejects(
    retryResponsesWithoutImages({
      error,
      payload: payloadWithImage(),
      retry: async () => {
        attempts++
        await fetch(server.url, {
          method: "POST",
          body: JSON.stringify(payloadWithImage()),
        })
        throw failure
      },
    }),
    (error: unknown) => error === failure,
  )
  expect(attempts).toBe(1)
  expect(requests).toHaveLength(1)
})

test("流式错误事件保留模型、错误文本与失败状态", () => {
  const event = createResponsesStreamErrorEvent(
    "gpt-image",
    new Error("interrupted"),
  )
  expect(event.type).toBe("response.failed")
  expect(event.response.model).toBe("gpt-image")
  expect(event.response.status).toBe("failed")
  expect(event.response.error.message).toBe("interrupted")
  expect(
    createResponsesStreamErrorEvent("gpt-image", null).response.error.message,
  ).toBe("Stream error")
})
