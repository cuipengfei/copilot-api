import { afterEach, expect, mock, spyOn, test } from "bun:test"
import type { ReadableStreamDefaultReader as WebStreamReader } from "node:stream/web"

import {
  defaultUpstreamTransportConfig,
  normalizeUpstreamTransportConfig,
} from "~/lib/config"
import {
  UpstreamHeadersTimeoutError,
  UpstreamStreamInactivityTimeoutError,
} from "~/lib/http/error"
import { createResponsesHttpEventStream } from "~/services/responses-http"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

const originalFetch = globalThis.fetch

afterEach(() => {
  mock.restore()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("upstream transport configuration validates positive integer limits", () => {
  expect(
    normalizeUpstreamTransportConfig({
      headersTimeoutMs: 12.8,
      streamInactivityTimeoutMs: 0,
      websocketMaxBufferedBytes: -1,
      websocketMaxBufferedMessages: Number.NaN,
      websocketOpenTimeoutMs: 45,
      websocketPoolIdleTimeoutMs: 0.5,
    }),
  ).toEqual({
    ...defaultUpstreamTransportConfig,
    headersTimeoutMs: 12,
    websocketOpenTimeoutMs: 45,
  })
})

test.each(["client", "init"] as const)(
  "a %s cancelled before dispatch does not call fetch",
  async (source) => {
    const fetchMock = mock(() => Promise.resolve(Response.json({ ok: true })))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch
    const client = new AbortController()
    const request = new AbortController()
    ;(source === "client" ? client : request).abort()

    expect(
      await getRejectedError(
        fetchUpstreamWithLifecycle(
          "https://upstream.example/responses",
          { method: "POST", signal: request.signal },
          lifecycleOptions(client.signal),
        ),
      ),
    ).toHaveProperty("name", "AbortError")
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test.each(["client", "init"] as const)(
  "%s cancellation while awaiting headers aborts upstream",
  async (source) => {
    let upstreamSignal: AbortSignal | undefined
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(
      (_input: string | URL | Request, init?: RequestInit) => {
        upstreamSignal = init?.signal as AbortSignal
        const signal = upstreamSignal
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason as Error),
            {
              once: true,
            },
          )
        })
      },
    ) as unknown as typeof fetch
    const client = new AbortController()
    const request = new AbortController()
    const removeListener = spyOn(client.signal, "removeEventListener")

    const responsePromise = fetchUpstreamWithLifecycle(
      "https://upstream.example/responses",
      { method: "POST", signal: request.signal },
      lifecycleOptions(client.signal),
    )
    const rejection = getRejectedError(responsePromise)
    const error = new Error("client disconnected")
    ;(source === "client" ? client : request).abort(error)

    expect(upstreamSignal?.aborted).toBe(true)
    expect(upstreamSignal?.reason).toBe(error)
    expect(await rejection).toBe(error)
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
  },
)

test.each(["client", "init"] as const)(
  "%s cancellation after headers rejects pending body consumption",
  async (source) => {
    let upstreamSignal: AbortSignal | undefined
    let upstreamBody: ReadableStream<Uint8Array> | undefined
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(
      (_input: string | URL | Request, init?: RequestInit) => {
        upstreamSignal = init?.signal as AbortSignal
        const signal = upstreamSignal
        upstreamBody = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener(
              "abort",
              () => controller.error(signal.reason),
              { once: true },
            )
          },
        })
        return Promise.resolve(new Response(upstreamBody))
      },
    ) as unknown as typeof fetch
    const client = new AbortController()
    const request = new AbortController()
    const response = await fetchUpstreamWithLifecycle(
      "https://upstream.example/responses",
      { method: "POST", signal: request.signal },
      lifecycleOptions(client.signal),
    )
    const reader = response.body!.getReader()
    const rejection = getRejectedError(reader.read())
    const error = new Error("client disconnected")
    ;(source === "client" ? client : request).abort(error)

    expect(upstreamSignal?.aborted).toBe(true)
    expect(upstreamSignal?.reason).toBe(error)
    expect(await rejection).toBe(error)
    expect(upstreamBody?.locked).toBe(false)
    expect(await getRejectedError(reader.read())).toBe(error)
  },
)

test.each(["body", "no body"] as const)(
  "normal completion releases client listeners and timers with %s",
  async (mode) => {
    const client = new AbortController()
    const addListener = spyOn(client.signal, "addEventListener")
    const removeListener = spyOn(client.signal, "removeEventListener")
    const timers = spyOn(globalThis, "setTimeout")
    const clearTimer = spyOn(globalThis, "clearTimeout")
    let upstreamSignal: AbortSignal | undefined
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(
      (_input: string | URL | Request, init?: RequestInit) => {
        upstreamSignal = init?.signal as AbortSignal
        return Promise.resolve(
          new Response(mode === "body" ? "done" : null, {
            status: mode === "body" ? 200 : 204,
            headers: { "x-upstream-test": "preserved" },
          }),
        )
      },
    ) as unknown as typeof fetch

    const response = await fetchUpstreamWithLifecycle(
      "https://upstream.example/responses",
      { method: "POST" },
      lifecycleOptions(client.signal),
    )
    expect(await response.text()).toBe(mode === "body" ? "done" : "")
    expect(response.headers.get("x-upstream-test")).toBe("preserved")
    expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), {
      once: true,
    })
    for (const [event, listener] of addListener.mock.calls) {
      expect(removeListener).toHaveBeenCalledWith(event, listener)
    }
    for (const result of timers.mock.results) {
      expect(clearTimer).toHaveBeenCalledWith(result.value)
    }
    client.abort()
    expect(upstreamSignal?.aborted).toBe(false)
  },
)

test.each(["headers", "body"] as const)(
  "client cancellation closes the real upstream connection while awaiting %s",
  async (mode) => {
    const started = createDeferred<void>()
    const aborted = createDeferred<void>()
    const headers = createDeferred<Response>()
    const deadline = Promise.withResolvers<never>()
    const timer = setTimeout(
      () => deadline.reject(new Error("Local upstream cancellation timed out")),
      2000,
    )
    const client = new AbortController()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        request.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve()
            headers.resolve(new Response(null))
          },
          { once: true },
        )
        started.resolve()
        if (mode === "headers") return headers.promise
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("started"))
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        )
      },
    })
    let reader: WebStreamReader<Uint8Array> | undefined
    try {
      const responsePromise = fetchUpstreamWithLifecycle(
        server.url,
        { method: "POST" },
        {
          clientSignal: client.signal,
          headersTimeoutMs: 10000,
          streamInactivityTimeoutMs: 10000,
        },
      )
      const error = new Error("client disconnected")
      if (mode === "headers") {
        const rejection = getRejectedError(responsePromise)
        await Promise.race([started.promise, deadline.promise])
        client.abort(error)
        expect(await Promise.race([rejection, deadline.promise])).toBe(error)
      } else {
        const response = await Promise.race([responsePromise, deadline.promise])
        const bodyReader =
          response.body!.getReader() as WebStreamReader<Uint8Array>
        reader = bodyReader
        const first = await Promise.race([bodyReader.read(), deadline.promise])
        expect(new TextDecoder().decode(first.value)).toBe("started")
        const rejection = getRejectedError(bodyReader.read())
        client.abort(error)
        expect(await Promise.race([rejection, deadline.promise])).toBe(error)
      }
      await Promise.race([aborted.promise, deadline.promise])
    } finally {
      clearTimeout(timer)
      client.abort()
      headers.resolve(new Response(null))
      await reader?.cancel().catch(() => {})
      await server.stop(true)
    }
  },
)

test("early SSE iterator return cancels the managed upstream body", async () => {
  let cancelledBodies = 0
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: response.completed\ndata: {"type":"response.completed"}\n\n',
              ),
            )
          },
          cancel() {
            cancelledBodies += 1
          },
        }),
      ),
    ),
  ) as unknown as typeof fetch

  const response = await fetchUpstreamWithLifecycle(
    "https://upstream.example/responses",
    { method: "POST" },
    lifecycleOptions(),
  )
  const iterator =
    createResponsesHttpEventStream(response)[Symbol.asyncIterator]()

  expect((await iterator.next()).value).toHaveProperty(
    "event",
    "response.completed",
  )
  await iterator.return?.()

  expect(cancelledBodies).toBe(1)
  expect(response.body?.locked).toBe(false)
})

test("concurrent upstream lifecycles use independent controllers", async () => {
  const upstreamSignals: Array<AbortSignal> = []
  const bodyControllers: Array<ReadableStreamDefaultController<Uint8Array>> = []
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(
    (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal
      upstreamSignals.push(signal)
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyControllers.push(controller)
              signal.addEventListener(
                "abort",
                () => controller.error(signal.reason),
                { once: true },
              )
              controller.enqueue(new TextEncoder().encode("event"))
            },
          }),
        ),
      )
    },
  ) as unknown as typeof fetch

  const firstClient = new AbortController()
  const secondClient = new AbortController()
  const firstResponse = await fetchUpstreamWithLifecycle(
    "https://first.example/responses",
    { method: "POST" },
    lifecycleOptions(firstClient.signal),
  )
  const secondResponse = await fetchUpstreamWithLifecycle(
    "https://second.example/responses",
    { method: "POST" },
    lifecycleOptions(secondClient.signal),
  )
  const firstReader = firstResponse.body!.getReader()
  const secondReader = secondResponse.body!.getReader()
  await firstReader.read()
  await secondReader.read()

  const rejection = getRejectedError(firstReader.read())
  const error = new Error("first client disconnected")
  firstClient.abort(error)
  expect(await rejection).toBe(error)

  expect(upstreamSignals[0]?.aborted).toBe(true)
  expect(upstreamSignals[1]?.aborted).toBe(false)

  bodyControllers[1]?.close()
  expect((await secondReader.read()).done).toBe(true)
})

test("HTTP headers deadline aborts a stalled fetch with an actionable error", async () => {
  let upstreamSignal: AbortSignal | undefined
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(
    (_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener(
          "abort",
          () =>
            reject(
              upstreamSignal?.reason instanceof Error ?
                upstreamSignal.reason
              : new Error("HTTP request aborted"),
            ),
          { once: true },
        )
      })
    },
  ) as unknown as typeof fetch

  expect(
    await getRejectedError(
      fetchUpstreamWithLifecycle(
        "https://upstream.example/responses",
        { method: "POST" },
        {
          headersTimeoutMs: 5,
          streamInactivityTimeoutMs: 100,
        },
      ),
    ),
  ).toBeInstanceOf(UpstreamHeadersTimeoutError)
  expect(upstreamSignal?.aborted).toBe(true)
})

test("HTTP stream inactivity aborts stalled body consumption", async () => {
  let upstreamSignal: AbortSignal | undefined
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(
    (_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal
      return Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ start() {} })),
      )
    },
  ) as unknown as typeof fetch

  const response = await fetchUpstreamWithLifecycle(
    "https://upstream.example/responses",
    { method: "POST" },
    {
      headersTimeoutMs: 100,
      streamInactivityTimeoutMs: 5,
    },
  )

  expect(
    await getRejectedError(response.body!.getReader().read()),
  ).toBeInstanceOf(UpstreamStreamInactivityTimeoutError)
  expect(upstreamSignal?.aborted).toBe(true)
})

test("periodic body data can outlive one inactivity window", async () => {
  const encoder = new TextEncoder()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const chunk of ["a", "b", "c", "d"]) {
              controller.enqueue(encoder.encode(chunk))
              await delay(8)
            }
            controller.close()
          },
        }),
      ),
    ),
  ) as unknown as typeof fetch

  const response = await fetchUpstreamWithLifecycle(
    "https://upstream.example/responses",
    { method: "POST" },
    {
      headersTimeoutMs: 100,
      streamInactivityTimeoutMs: 20,
    },
  )

  expect(await response.text()).toBe("abcd")
})

const lifecycleOptions = (
  clientSignal?: AbortSignal,
): {
  clientSignal?: AbortSignal
  headersTimeoutMs: number
  streamInactivityTimeoutMs: number
} => ({
  clientSignal,
  headersTimeoutMs: 1000,
  streamInactivityTimeoutMs: 1000,
})

const createDeferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const delay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds))

const getRejectedError = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error("Expected promise to reject")
}
