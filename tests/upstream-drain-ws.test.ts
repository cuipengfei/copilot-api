import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { state } from "~/lib/state"
import { createMessages } from "~/services/copilot/create-messages"
const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
const originalCodexToken = state.codexAccessToken
const originalCodexAccount = state.codexAccountId
const originalTelemetryEnabled = state.copilotTelemetryEnabled
const fetchMock = mock(() =>
  Promise.resolve(new Response("unexpected", { status: 500 })),
)
beforeEach(() => {
  state.copilotToken = "test-token"
  state.codexAccessToken = "codex-token"
  state.codexAccountId = "codex-account"
  state.copilotTelemetryEnabled = false
  fetchMock.mockClear()
  const scope = globalThis as unknown as { fetch: typeof fetch }
  scope.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  state.copilotToken = originalCopilotToken
  state.codexAccessToken = originalCodexToken
  state.codexAccountId = originalCodexAccount
  state.copilotTelemetryEnabled = originalTelemetryEnabled
  const scope = globalThis as unknown as { fetch: typeof fetch }
  scope.fetch = originalFetch
  mock.restore()
})
describe("websocket pre-dispatch cancellation", () => {
  test("copilot chat completions refuses aborted client", async () => {
    const unit = await import("~/services/copilot/create-chat-completions")
    const client = new AbortController()
    client.abort()
    const error = await getRejectedError(
      unit.createChatCompletions(
        {
          messages: [{ content: "hello", role: "user" }],
          model: "gpt-test",
        },
        { clientSignal: client.signal },
      ),
    )
    expect(error.name).toBe("AbortError")
    expect(fetchMock).not.toHaveBeenCalled()
  })
  test("copilot websocket refuses aborted client", async () => {
    const unit = await import("~/services/copilot/create-responses")
    const client = new AbortController()
    client.abort()
    const error = await getRejectedError(
      unit.createResponses(
        { input: "hello", model: "gpt-test", stream: true },
        {
          clientSignal: client.signal,
          initiator: "user",
          requestId: "request-1",
          transport: "websocket",
          vision: false,
        },
      ),
    )
    expect(error.name).toBe("AbortError")
    expect(fetchMock).not.toHaveBeenCalled()
  })
  test("codex websocket refuses aborted client", async () => {
    const unit = await import("~/services/codex/create-responses")
    const client = new AbortController()
    client.abort()
    const error = await getRejectedError(
      unit.forwardCodexResponses(
        { input: "hello", model: "gpt-5.4", stream: true },
        new Headers(),
        undefined,
        { clientSignal: client.signal, transport: "websocket" },
      ),
    )
    expect(error.name).toBe("AbortError")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
describe("copilot messages cancellation", () => {
  test("non-streaming messages request aborts upstream with the disconnect reason", async () => {
    const { promise: dispatched, resolve: notifyDispatched } =
      Promise.withResolvers<void>()
    let upstreamSignal: AbortSignal | undefined
    const scope = globalThis as unknown as { fetch: typeof fetch }
    scope.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input
        : input instanceof URL ? input.href
        : input.url
      if (!url.includes("/v1/messages")) {
        // Keep unrelated responses independent of the pending messages request.
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      const signal = init?.signal as AbortSignal
      upstreamSignal = signal
      const { promise, reject } = Promise.withResolvers<Response>()
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
      notifyDispatched()
      return promise
    }) as unknown as typeof fetch
    const client = new AbortController()
    const unrelated = new AbortController()
    const reason = new Error("client disconnected")
    const pending = createMessages(
      {
        max_tokens: 8,
        messages: [{ content: "hi", role: "user" }],
        model: "claude-test",
      },
      undefined,
      { clientSignal: client.signal, requestId: "request-1" },
    )
    const rejected = getRejectedError(pending)
    await dispatched
    const telemetryResponse = await fetch(
      "https://telemetry.example.test/events",
      {
        signal: unrelated.signal,
      },
    )
    client.abort(reason)
    expect(await rejected).toBe(reason)
    expect(upstreamSignal?.aborted).toBe(true)
    expect(upstreamSignal?.reason).toBe(reason)
    const otherResponse = await fetch("https://example.test/health", {
      signal: unrelated.signal,
    })
    expect(unrelated.signal.aborted).toBe(false)
    expect(telemetryResponse.status).toBe(200)
    expect(otherResponse.status).toBe(200)
    expect(otherResponse).not.toBe(telemetryResponse)
  })
})
const getRejectedError = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error("done")
  }
  throw new Error("expected rejection")
}
