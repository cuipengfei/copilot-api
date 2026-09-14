import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { state } from "~/lib/state"
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
describe("copilot messages drain", () => {
  test("non-streaming messages completes after disconnect", async () => {
    const unit = await import("~/services/copilot/create-messages")
    let resolveFetch: (value: Response) => void = () => {}
    let notifyDispatched: () => void = () => {}
    let upstreamSignal: AbortSignal | undefined
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const dispatched = new Promise<void>((resolve) => {
      notifyDispatched = resolve
    })
    const scope = globalThis as unknown as { fetch: typeof fetch }
    scope.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input
        : input instanceof URL ? input.href
        : input.url
      if (url.includes("/models/session")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              available_models: [],
              expires_at: 0,
              session_token: "auto-session-token",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )
      }
      if (!url.includes("/v1/messages")) {
        // Telemetry and other fire-and-forget fetches must not share the
        // gated Response: sharing one Response object lets res.text() lock
        // the body before the main flow calls getReader() (flaky race).
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      upstreamSignal = init?.signal as AbortSignal
      notifyDispatched()
      return gate
    }) as unknown as typeof fetch
    const client = new AbortController()
    const pending = unit.createMessages(
      {
        max_tokens: 8,
        messages: [{ content: "hi", role: "user" }],
        model: "claude-test",
      },
      undefined,
      { clientSignal: client.signal, requestId: "request-1" },
    )
    await dispatched
    client.abort(new Error("client disconnected"))
    resolveFetch(
      new Response(
        JSON.stringify({
          content: [{ text: "done", type: "text" }],
          model: "claude-test",
          role: "assistant",
        }),
        { headers: { contentType: "application/json" } },
      ),
    )
    const result = (await pending) as unknown as { role: string }
    expect(result.role).toBe("assistant")
    expect(upstreamSignal?.aborted).toBe(false)
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
