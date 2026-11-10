import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import { rejects } from "node:assert/strict"

import consola from "consola"

import {
  getAutoSessionForModel,
  invalidateAutoSession,
  refreshAutoSession,
  registerAutoSelection,
  registerFusionSelection,
  stopProbeScheduler,
  whenProbeSchedulerIdle,
} from "../src/lib/auto-session"
import { getConfig } from "../src/lib/config-store"
import { state } from "../src/lib/state"
import {
  attachAutoSessionToken,
  retryAfterAutoSessionTokenRejection,
} from "../src/services/copilot/auto-session-retry"
import type { AutoSelectionResponse } from "../src/services/copilot/get-auto-selection"
import { sendCopilotRequest } from "../src/services/copilot/request"

const originalFetch = globalThis.fetch
const originalGithubToken = state.githubToken
const originalAutoDiscovery = getConfig().autoDiscovery
const transportConfig = {
  headersTimeoutMs: 5_000,
  streamInactivityTimeoutMs: 5_000,
}
const AUTH_TOKEN = "retry-auth-token"
const GITHUB_TOKEN = "retry-github-token"
const MODEL = "model-a"
const URL = "https://local.invalid/responses"
const SENTINEL = "private-upstream-session-secret"

interface SentRequest {
  path: string
  headers: Headers
  payload: { model: string; input?: string }
}

const sent: Array<SentRequest> = []
let generate: (request: SentRequest) => Response | Promise<Response>
let discover: (path: string) => Response | Promise<Response>
let controlCalls: Array<string> = []

const autoSelection = (
  model = MODEL,
  sessionToken = "auto-token",
): AutoSelectionResponse => ({
  selected_model: {
    id: model,
    supported_endpoints: ["/responses", "/chat/completions", "/v1/messages"],
  },
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  session_token: sessionToken,
})

const registerAuto = (model = MODEL, token = "auto-token"): void => {
  expect(registerAutoSelection(autoSelection(model, token))).toBe(true)
}

const registerFusion = (token = "fusion-token"): void => {
  expect(
    registerFusionSelection({
      modelId: MODEL,
      sessionToken: token,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toBe(true)
}

const headersFor = (authToken = AUTH_TOKEN): Record<string, string> => ({
  Authorization: `Bearer ${authToken}`,
  "x-request-id": "same-request",
})

const selectionFor = (model = MODEL) =>
  getAutoSessionForModel({
    model,
    endpoint: "/responses",
    waitForDiscovery: false,
  })
const send = (headers: Record<string, string>, clientSignal?: AbortSignal) => {
  const payload = { model: MODEL, input: "keep the requested model" }
  return sendCopilotRequest(URL, {
    headers,
    payload,
    clientSignal,
    transportConfig,
  })
}

const sentTokens = (): Array<string | null> =>
  sent.map((request) => request.headers.get("Copilot-Session-Token"))

beforeEach(() => {
  invalidateAutoSession()
  getConfig().autoDiscovery = undefined
  state.githubToken = GITHUB_TOKEN
  state.copilotToken = AUTH_TOKEN
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.forceAgent = false
  state.models = {
    object: "list",
    data: [
      { id: MODEL, supported_endpoints: ["/responses"] },
      { id: "model-b", supported_endpoints: ["/responses"] },
    ],
  } as typeof state.models
  state.interactionId = "retry-interaction-id"
  sent.length = 0
  controlCalls = []
  generate = () => Response.json({ id: "ok" })
  discover = () =>
    Response.json({ error: { message: SENTINEL } }, { status: 403 })
  const fetchMock = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      const path = new globalThis.URL(url).pathname
      if (path === "/auto" || path === "/model/fusion") {
        controlCalls.push(path)
        if (controlCalls.length > 32)
          throw new Error("discovery request cap exceeded")
        return discover(path)
      }
      if (path !== "/responses") throw new Error("unexpected upstream endpoint")
      if (sent.length >= 8) throw new Error("generation request cap exceeded")
      if (typeof init?.body !== "string") {
        throw new Error("expected string request body")
      }
      const request = {
        path,
        headers: new Headers(init?.headers),
        payload: JSON.parse(init.body) as SentRequest["payload"],
      }
      sent.push(request)
      return generate(request)
    },
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  invalidateAutoSession()
  state.githubToken = originalGithubToken
  getConfig().autoDiscovery = originalAutoDiscovery
  mock.restore()
})

afterAll(async () => {
  stopProbeScheduler()
  await whenProbeSchedulerIdle()
  globalThis.fetch = originalFetch
})

describe("finite source-based discount rejection chain", () => {
  test("real sender falls back 30 -> 10 -> 0 without changing model, input, auth or request ID", async () => {
    registerAuto()
    registerAuto("model-b", "other-model-token")
    registerFusion()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    const info = spyOn(consola, "info")
    const warn = spyOn(consola, "warn")
    generate = () =>
      sent.length < 3 ?
        Response.json(
          { error: { message: SENTINEL, detail: "BELONG" } },
          { status: sent.length === 1 ? 401 : 400 },
        )
      : Response.json({ id: "full-price-success" })

    const response = await send(headers)

    expect(await response.json()).toEqual({ id: "full-price-success" })
    expect(sentTokens()).toEqual(["fusion-token", "auto-token", null])
    for (const request of sent) {
      expect(request.payload).toEqual({
        model: MODEL,
        input: "keep the requested model",
      })
      expect(request.headers.get("Authorization")).toBe(`Bearer ${AUTH_TOKEN}`)
      expect(request.headers.get("x-request-id")).toBe("same-request")
    }
    expect((await selectionFor("model-b"))?.sessionToken).toBe(
      "other-model-token",
    )
    const logs = JSON.stringify([...info.mock.calls, ...warn.mock.calls])
    expect(logs).toContain("reason=http_401")
    expect(logs).toContain("reason=http_400")
    expect(logs).not.toContain(SENTINEL)
    expect(logs).not.toContain("fusion-token")
    expect(logs).not.toContain("auto-token")
    expect(logs).not.toContain(AUTH_TOKEN)
  })

  test.each(["fusion", "auto", "none"] as const)(
    "skips absent candidates when only %s is available",
    async (source) => {
      if (source === "fusion") registerFusion()
      if (source === "auto") registerAuto()
      const headers = headersFor()
      await attachAutoSessionToken(headers, MODEL, "/responses")
      generate = (request) =>
        request.headers.has("Copilot-Session-Token") ?
          new Response("token rejected", { status: 401 })
        : Response.json({ id: "ok" })

      const response = await send(headers)

      expect(response.status).toBe(200)
      await response.text()
      expect(sentTokens()).toEqual(
        source === "none" ? [null] : [`${source}-token`, null],
      )
    },
  )

  test("returns the final full-price error body, status and headers unchanged", async () => {
    registerAuto()
    registerFusion()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    generate = () =>
      Response.json(
        {
          error: {
            message:
              sent.length === 3 ? "final auth failure" : "token rejected",
          },
        },
        { status: 401, headers: { "x-request-id": "final-error-id" } },
      )

    const response = await send(headers)

    expect(response.status).toBe(401)
    expect(response.headers.get("x-request-id")).toBe("final-error-id")
    expect(await response.json()).toEqual({
      error: { message: "final auth failure" },
    })
    expect(sentTokens()).toEqual(["fusion-token", "auto-token", null])
  })

  test("the helper returns the exact final Response and never retries tokenless failure", async () => {
    registerAuto()
    registerFusion()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    const final = new Response("full-price failure", { status: 401 })
    const retry = mock(() =>
      Promise.resolve(
        headers["Copilot-Session-Token"] ?
          new Response("rejected", { status: 400 })
        : final,
      ),
    )

    const response = await retryAfterAutoSessionTokenRejection(
      new Response("rejected", { status: 401 }),
      headers,
      MODEL,
      "/responses",
      retry,
    )

    expect(response).toBe(final)
    expect(retry).toHaveBeenCalledTimes(2)
    expect(await final.text()).toBe("full-price failure")
  })

  test("a late rejection does not delete or retry the newer token of the same source", async () => {
    registerAuto()
    registerFusion("fusion-old")
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    generate = () => {
      if (sent.length === 1) {
        registerFusion("fusion-new")
        return new Response("late rejection", { status: 401 })
      }
      return Response.json({ id: "ok" })
    }

    await (await send(headers)).text()

    expect(sentTokens()).toEqual(["fusion-old", "auto-token"])
    expect((await selectionFor())?.sessionToken).toBe("fusion-new")
    const nextHeaders = headersFor()
    await attachAutoSessionToken(nextHeaders, MODEL, "/responses")
    expect(nextHeaders["Copilot-Session-Token"]).toBe("fusion-new")
  })

  test("does not return to Fusion when it arrives after the chain already selected Auto", async () => {
    registerAuto()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    generate = () => {
      if (sent.length === 1) {
        registerFusion()
        return new Response("auto rejected", { status: 401 })
      }
      return Response.json({ id: "ok" })
    }

    await (await send(headers)).text()

    expect(sentTokens()).toEqual(["auto-token", null])
    expect((await selectionFor())?.source).toBe("fusion")
  })

  test("cleared concurrent pairings still allow one full-price send", async () => {
    registerAuto()
    registerFusion()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    generate = () => {
      if (sent.length === 1) {
        invalidateAutoSession()
        return new Response("late rejection", { status: 401 })
      }
      return Response.json({ id: "ok" })
    }

    await (await send(headers)).text()

    expect(sentTokens()).toEqual(["fusion-token", null])
  })

  test("413 re-entry starts a fresh source chain for the same headers", async () => {
    registerAuto()
    registerFusion()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    generate = (request) => {
      if (sent.length === 3)
        return new Response("reduce images", { status: 413 })
      return request.headers.has("Copilot-Session-Token") ?
          new Response("token rejected", { status: 401 })
        : Response.json({ id: "retried-after-image-reduction" })
    }

    const first = await send(headers)
    expect(first.status).toBe(413)
    await first.text()
    registerAuto(MODEL, "auto-reentry-token")
    registerFusion("fusion-reentry-token")
    await attachAutoSessionToken(headers, MODEL, "/responses")

    const response = await send(headers)

    expect(response.status).toBe(200)
    await response.text()
    expect(sentTokens()).toEqual([
      "fusion-token",
      "auto-token",
      null,
      "fusion-reentry-token",
      "auto-reentry-token",
      null,
    ])
  })
})

describe("actual Authorization snapshot and candidate applicability", () => {
  test.each(["Authorization", "authorization", "AUTHORIZATION"])(
    "uses the actual %s credential rather than the current global token",
    async (name) => {
      registerAuto()
      registerFusion()
      const headers: Record<string, string> = {
        [name]: "Bearer stale-identity",
      }
      await attachAutoSessionToken(headers, MODEL, "/responses")
      expect(headers["Copilot-Session-Token"]).toBeUndefined()
      expect((await selectionFor())?.source).toBe("fusion")
    },
  )

  test("missing Authorization cannot borrow a globally authenticated pairing", async () => {
    registerAuto()
    registerFusion()
    const headers: Record<string, string> = {}
    await attachAutoSessionToken(headers, MODEL, "/responses")
    expect(headers["Copilot-Session-Token"]).toBeUndefined()
  })

  test.each(["Authorization", "authorization", "AUTHORIZATION"])(
    "associates the known GitHub %s with its captured Copilot identity without replacing auth",
    async (name) => {
      registerAuto()
      const headers: Record<string, string> = {
        [name]: `Bearer ${GITHUB_TOKEN}`,
      }

      await attachAutoSessionToken(headers, MODEL, "/v1/messages")

      expect(headers).toEqual({
        [name]: `Bearer ${GITHUB_TOKEN}`,
        "Copilot-Session-Token": "auto-token",
      })
      expect(controlCalls).toHaveLength(0)
    },
  )

  test.each([
    headersFor("stranger-github-token").Authorization,
    `token ${GITHUB_TOKEN}`,
    "Bearer ",
  ])(
    "unassociated Authorization %s cannot borrow the current account's pairing",
    async (authorization) => {
      registerAuto()
      registerFusion()
      const headers = { Authorization: authorization }

      await attachAutoSessionToken(headers, MODEL, "/responses")

      expect(headers).toEqual({ Authorization: authorization })
      expect(controlCalls).toHaveLength(0)
      expect((await selectionFor())?.sessionToken).toBe("fusion-token")
    },
  )

  test("the known GitHub identity keeps the same association throughout 30 -> 10 -> 0", async () => {
    registerAuto()
    registerFusion()
    const headers = headersFor(GITHUB_TOKEN)
    await attachAutoSessionToken(headers, MODEL, "/responses")
    generate = (request) =>
      request.headers.has("Copilot-Session-Token") ?
        new Response("token rejected", { status: 401 })
      : Response.json({ id: "github-full-price" })

    expect(await (await send(headers)).json()).toEqual({
      id: "github-full-price",
    })
    expect(sentTokens()).toEqual(["fusion-token", "auto-token", null])
    for (const request of sent) {
      expect(request.headers.get("Authorization")).toBe(
        `Bearer ${GITHUB_TOKEN}`,
      )
    }
  })

  test.each([false, true])(
    "GitHub rotation while attachment awaits rejects the result with Copilot rotation=%s",
    async (rotateCopilot) => {
      registerAuto()
      const headers = headersFor(GITHUB_TOKEN)
      const attachment = attachAutoSessionToken(headers, MODEL, "/v1/messages")
      state.githubToken = "rotated-github-token"
      if (rotateCopilot) state.copilotToken = "rotated-copilot-token"
      registerAuto(MODEL, "auto-after-rotation")

      await attachment

      expect(headers.Authorization).toBe(`Bearer ${GITHUB_TOKEN}`)
      expect(headers["Copilot-Session-Token"]).toBeUndefined()
      expect((await selectionFor())?.sessionToken).toBe("auto-after-rotation")
      await attachAutoSessionToken(headers, MODEL, "/v1/messages")
      expect(headers["Copilot-Session-Token"]).toBeUndefined()
    },
  )

  test.each(["github", "copilot", "both"])(
    "%s rotation during a GitHub-authenticated retry cannot borrow or invalidate the new pairing",
    async (rotation) => {
      registerAuto()
      registerFusion()
      const headers = headersFor(GITHUB_TOKEN)
      await attachAutoSessionToken(headers, MODEL, "/responses")
      generate = () => {
        if (sent.length === 1) {
          if (rotation !== "copilot") state.githubToken = "rotated-github-token"
          if (rotation !== "github")
            state.copilotToken = "rotated-copilot-token"
          registerAuto(MODEL, "auto-new-identity")
          registerFusion("fusion-token")
          return new Response("old request rejected", { status: 401 })
        }
        return Response.json({ id: "old-request-full-price" })
      }

      await (await send(headers)).text()

      expect(sentTokens()).toEqual(["fusion-token", null])
      expect((await selectionFor())?.sessionToken).toBe("fusion-token")
      expect(
        (
          await getAutoSessionForModel({
            model: MODEL,
            endpoint: "/responses",
            excludedSources: new Set(["fusion"]),
            waitForDiscovery: false,
          })
        )?.sessionToken,
      ).toBe("auto-new-identity")
      for (const request of sent) {
        expect(request.headers.get("Authorization")).toBe(
          `Bearer ${GITHUB_TOKEN}`,
        )
      }
    },
  )

  test("retry never reinterprets an old Copilot credential as the new GitHub identity", async () => {
    registerAuto()
    registerFusion()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    generate = () => {
      if (sent.length === 1) {
        state.githubToken = AUTH_TOKEN
        state.copilotToken = "new-copilot-token"
        registerAuto(MODEL, "auto-new-identity")
        registerFusion("fusion-new-identity")
        return new Response("old credential rejected", { status: 401 })
      }
      return Response.json({ id: "old-copilot-full-price" })
    }

    await (await send(headers)).text()

    expect(sentTokens()).toEqual(["fusion-token", null])
    expect((await selectionFor())?.sessionToken).toBe("fusion-new-identity")
  })

  test("rotation during a rejected request never attaches the new identity's token", async () => {
    registerAuto()
    registerFusion("fusion-old-identity")
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    generate = () => {
      if (sent.length === 1) {
        invalidateAutoSession()
        state.copilotToken = "rotated-identity"
        registerAuto(MODEL, "auto-new-identity")
        registerFusion("fusion-new-identity")
        return new Response("old request rejected", { status: 401 })
      }
      return Response.json({ id: "ok" })
    }

    await (await send(headers)).text()

    expect(sentTokens()).toEqual(["fusion-old-identity", null])
    expect((await selectionFor())?.sessionToken).toBe("fusion-new-identity")
  })

  test("reattaching for another model clears the old token instead of crossing models", async () => {
    registerFusion()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    expect(headers["Copilot-Session-Token"]).toBe("fusion-token")
    await attachAutoSessionToken(headers, "model-b", "/responses")
    expect(headers["Copilot-Session-Token"]).toBeUndefined()
  })

  test("Fusion's HTTP Responses candidate is not attached to Chat", async () => {
    registerAuto()
    registerFusion()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/chat/completions")
    expect(headers["Copilot-Session-Token"]).toBe("auto-token")
  })

  test("no candidate clears previously attached session headers of either case", async () => {
    const headers = {
      ...headersFor(),
      "copilot-session-token": "stale-lowercase-token",
      "Copilot-Session-Token": "stale-canonical-token",
    }
    await attachAutoSessionToken(headers, MODEL, "/responses")
    expect(new Headers(headers).has("Copilot-Session-Token")).toBe(false)
  })

  test("a header token changed after attachment cannot invalidate the selected source", async () => {
    registerFusion()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    headers["Copilot-Session-Token"] = "untracked-token"
    generate = () => new Response("not the selected token", { status: 401 })

    const response = await send(headers)

    expect(response.status).toBe(401)
    await response.text()
    expect(sentTokens()).toEqual(["untracked-token"])
    expect((await selectionFor())?.sessionToken).toBe("fusion-token")
  })

  test.each([429, 500])(
    "a fallback HTTP %i does not continue to full price",
    async (status) => {
      registerAuto()
      registerFusion()
      const headers = headersFor()
      await attachAutoSessionToken(headers, MODEL, "/responses")
      generate = () =>
        new Response("original failure", {
          status: sent.length === 1 ? 401 : status,
        })

      const response = await send(headers)

      expect(response.status).toBe(status)
      expect(await response.text()).toBe("original failure")
      expect(sentTokens()).toEqual(["fusion-token", "auto-token"])
      expect((await selectionFor())?.sessionToken).toBe("auto-token")
    },
  )
})

describe("non-downgrade boundaries", () => {
  test.each([403, 413, 429, 500, 503])(
    "HTTP %i is returned without source invalidation or replay",
    async (status) => {
      registerAuto()
      registerFusion()
      const headers = headersFor()
      await attachAutoSessionToken(headers, MODEL, "/responses")
      generate = () => new Response("original failure", { status })

      const response = await send(headers)

      expect(response.status).toBe(status)
      expect(await response.text()).toBe("original failure")
      expect(sentTokens()).toEqual(["fusion-token"])
      expect((await selectionFor())?.sessionToken).toBe("fusion-token")
    },
  )

  test.each([
    "input item does not belong to this connection",
    "INPUT ITEM DOES NOT BELONG TO THIS CONNECTION",
    "BeLoNg to another connection",
  ])(
    "belong message stays with the compatibility path: %s",
    async (message) => {
      registerFusion()
      const headers = headersFor()
      await attachAutoSessionToken(headers, MODEL, "/responses")
      const rejected = Response.json({ error: { message } }, { status: 401 })
      const retry = mock(() => Promise.resolve(new Response("unused")))

      const response = await retryAfterAutoSessionTokenRejection(
        rejected,
        headers,
        MODEL,
        "/responses",
        retry,
      )

      expect(response).toBe(rejected)
      expect(await response.json()).toEqual({ error: { message } })
      expect(retry).not.toHaveBeenCalled()
      expect((await selectionFor())?.sessionToken).toBe("fusion-token")
    },
  )

  test("network failure is propagated without invalidation or retry", async () => {
    registerFusion()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    const failure = new TypeError("network unavailable")
    generate = () => Promise.reject(failure)

    await rejects(send(headers), (error: unknown) => error === failure)
    expect(sentTokens()).toEqual(["fusion-token"])
    expect((await selectionFor())?.sessionToken).toBe("fusion-token")
  })

  test("cancelled requests preserve the caller's reason and send nothing", async () => {
    registerFusion()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    const controller = new AbortController()
    const reason = new Error("client cancelled")
    controller.abort(reason)

    await rejects(
      send(headers, controller.signal),
      (error: unknown) => error === reason,
    )
    expect(sent).toHaveLength(0)
    expect((await selectionFor())?.sessionToken).toBe("fusion-token")
  })

  test("successful SSE headers are never replayed even if the body contains an error event", async () => {
    registerFusion()
    const headers = headersFor()
    await attachAutoSessionToken(headers, MODEL, "/responses")
    const body = 'event: error\ndata: {"error":{"message":"stream failed"}}\n\n'
    generate = () =>
      new Response(body, {
        headers: { "content-type": "text/event-stream" },
      })

    const response = await send(headers)

    expect(await response.text()).toBe(body)
    expect(sentTokens()).toEqual(["fusion-token"])
    expect((await selectionFor())?.sessionToken).toBe("fusion-token")
  })
})

test("background refresh failure cannot terminate the full-price fallback", async () => {
  discover = () => Response.json(autoSelection())
  await refreshAutoSession()
  const headers = headersFor()
  await attachAutoSessionToken(headers, MODEL, "/responses")
  discover = () => Promise.reject(new Error(SENTINEL))
  generate = (request) =>
    request.headers.has("Copilot-Session-Token") ?
      new Response("token rejected", { status: 401 })
    : Response.json({ id: "full-price-after-refresh-failure" })

  try {
    const response = await send(headers)
    expect(await response.json()).toEqual({
      id: "full-price-after-refresh-failure",
    })
    expect(sentTokens()).toEqual(["auto-token", null])
  } finally {
    stopProbeScheduler()
    await whenProbeSchedulerIdle()
  }
})
