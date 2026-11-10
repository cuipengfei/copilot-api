import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import {
  getFusionProbePrompts,
  getIntelligenceProbePrompt,
  PREWARM_PROMPT,
  TARGET_CODE_PROMPT,
} from "~/lib/auto-probe-prompts"
import * as configStore from "~/lib/config-store"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { getAutoSelection } from "~/services/copilot/get-auto-selection"
import { getFusionSelection } from "~/services/copilot/get-fusion-selection"

const NOW = 1_800_000_000_000
const EXPIRES_AT = NOW / 1000 + 86_399
const SESSION_TOKEN = "fusion-session-secret-sentinel"
const PROMPT = "prompt-source-secret-sentinel"
const originalFetch = globalThis.fetch
const originalEnv = {
  COPILOT_API_OAUTH_APP: process.env.COPILOT_API_OAUTH_APP,
  COPILOT_API_ENTERPRISE_URL: process.env.COPILOT_API_ENTERPRISE_URL,
}
const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  macMachineId: state.macMachineId,
}

const soloResponse = () => ({
  fusion_pattern: "solo",
  steps: [{ model_id: "selected-model", role: "generation" }],
  session: { token: SESSION_TOKEN, expires_at: EXPIRES_AT },
})
const fetchMock = mock((_input: string | URL | Request, _init: RequestInit) =>
  Promise.resolve(Response.json(soloResponse())),
)
const errorLog = Object.assign(
  mock((..._args: Array<unknown>) => {}),
  { raw: (..._args: Array<unknown>) => {} },
)
const timeoutSignal = new AbortController().signal
const timeoutMock = mock((_milliseconds: number) => timeoutSignal)

const expectInvalidBody = async (body: unknown): Promise<void> => {
  fetchMock.mockResolvedValueOnce(Response.json(body))
  // Bun types declare rejection matchers as void; normalize their async result.
  await Promise.resolve(
    expect(getFusionSelection(PROMPT)).rejects.toThrow(
      "Invalid Fusion selection response: invalid_body",
    ),
  )
  expect(errorLog).not.toHaveBeenCalled()
}

beforeEach(() => {
  delete process.env.COPILOT_API_OAUTH_APP
  delete process.env.COPILOT_API_ENTERPRISE_URL
  Object.assign(state, {
    accountType: "individual",
    copilotApiUrl: "https://token-endpoint.example.test",
    copilotToken: "copilot-auth-secret-sentinel",
    vsCodeVersion: "1.110.0",
    vsCodeDeviceId: "fixture-device",
    vsCodeSessionId: "fixture-session-secret-sentinel",
    macMachineId: "fixture-machine",
  })
  spyOn(configStore, "getConfig").mockReturnValue({})
  spyOn(Date, "now").mockReturnValue(NOW)
  errorLog.mockClear()
  spyOn(consola, "error").mockImplementation(errorLog)
  timeoutMock.mockClear()
  spyOn(AbortSignal, "timeout").mockImplementation(timeoutMock)
  fetchMock.mockReset()
  fetchMock.mockImplementation(() =>
    Promise.resolve(Response.json(soloResponse())),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
  Object.assign(state, originalState)
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe("getFusionSelection", () => {
  test("uses the Auto base, public headers and timeout with the exact Fusion body", async () => {
    const result = await getFusionSelection(PROMPT)
    await getAutoSelection(PROMPT, "balance")

    expect(result).toEqual({
      modelId: "selected-model",
      sessionToken: SESSION_TOKEN,
      expiresAt: EXPIRES_AT,
    })
    const [fusionUrl, fusionInit] = fetchMock.mock.calls[0]
    const [autoUrl, autoInit] = fetchMock.mock.calls[1]
    expect(fusionUrl).toBe("https://token-endpoint.example.test/model/fusion")
    expect(autoUrl).toBe("https://token-endpoint.example.test/auto")
    expect(fusionInit.method).toBe("POST")
    expect(fusionInit.method).toBe(autoInit.method)
    expect(fusionInit.body).toBe(
      JSON.stringify({
        prompt: PROMPT,
        fusion_mode: "hydrafusion",
        plan_version: "2",
      }),
    )
    expect(timeoutMock.mock.calls).toEqual([[15_000], [15_000]])
    expect(fusionInit.signal).toBe(timeoutSignal)
    expect(fusionInit.signal).toBe(autoInit.signal)

    const fusionHeaders = new Headers(fusionInit.headers)
    const autoHeaders = new Headers(autoInit.headers)
    expect(fusionHeaders.get("authorization")).toBe(
      `Bearer ${state.copilotToken}`,
    )
    expect(fusionHeaders.get("content-type")).toBe("application/json")
    for (const name of ["x-request-id", "x-agent-task-id"]) {
      expect(typeof fusionHeaders.get(name)).toBe("string")
      fusionHeaders.delete(name)
      autoHeaders.delete(name)
    }
    expect(Object.fromEntries(fusionHeaders)).toEqual(
      Object.fromEntries(autoHeaders),
    )
    expect(errorLog).not.toHaveBeenCalled()
  })

  test.each([
    ["business", "https://api.business.githubcopilot.com"],
    ["enterprise", "https://api.enterprise.githubcopilot.com"],
  ])(
    "uses the %s account endpoint without a token endpoint",
    async (accountType, base) => {
      state.copilotApiUrl = undefined
      state.accountType = accountType
      await getFusionSelection(PROMPT)
      expect(fetchMock.mock.calls[0][0]).toBe(`${base}/model/fusion`)
    },
  )

  test("uses the enterprise domain and preserves the OpenCode public header mode", async () => {
    state.copilotApiUrl = undefined
    process.env.COPILOT_API_ENTERPRISE_URL = "https://company.example.test/"
    process.env.COPILOT_API_OAUTH_APP = "opencode"
    await getFusionSelection(PROMPT)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://copilot-api.company.example.test/model/fusion")
    const headers = new Headers(init.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${state.copilotToken}`)
    expect(headers.get("user-agent")).toStartWith("opencode/")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.has("x-interaction-type")).toBe(false)
    expect(headers.has("host")).toBe(false)
  })

  test("ignores role, kind and unrecognized plan metadata without executing a plan", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...soloResponse(),
        steps: [
          {
            model_id: "actual-selected-model",
            role: "unknown-role",
            kind: { arbitrary: true },
          },
        ],
        matched_rule: "untrusted-rule",
        hydra_scores: { arbitrary: true },
        policy_version: "unknown",
        plan_version: "unknown",
      }),
    )
    expect(await getFusionSelection(PROMPT)).toEqual({
      modelId: "actual-selected-model",
      sessionToken: SESSION_TOKEN,
      expiresAt: EXPIRES_AT,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errorLog).not.toHaveBeenCalled()
  })

  test.each([{ body: null }, { body: [] }, { body: SESSION_TOKEN }])(
    "rejects a non-object body $body",
    async ({ body }) => {
      await expectInvalidBody(body)
    },
  )

  test.each([undefined, "untrusted-pattern-secret", "cascade"])(
    "rejects an unsupported pattern %p",
    async (fusion_pattern) => {
      await expectInvalidBody({ ...soloResponse(), fusion_pattern })
    },
  )

  test.each([
    { steps: [] },
    { steps: [{ model_id: "first" }, { model_id: "second" }] },
    { steps: { model_id: "first" } },
    { steps: [null] },
  ])(
    "rejects steps other than exactly one model step: $steps",
    async ({ steps }) => {
      await expectInvalidBody({ ...soloResponse(), steps })
    },
  )

  test.each([undefined, "", " \n\t", 42])(
    "rejects an invalid model ID %p",
    async (model_id) => {
      await expectInvalidBody({ ...soloResponse(), steps: [{ model_id }] })
    },
  )

  test.each([{ session: undefined }, { session: null }, { session: [] }])(
    "rejects an invalid top-level session $session",
    async ({ session }) => {
      await expectInvalidBody({ ...soloResponse(), session })
    },
  )

  test.each([undefined, null, "", " \n\t", 42])(
    "rejects an invalid token %p",
    async (token) => {
      await expectInvalidBody({
        ...soloResponse(),
        session: { token, expires_at: EXPIRES_AT },
      })
    },
  )

  test.each([
    undefined,
    null,
    String(EXPIRES_AT),
    0,
    NOW / 1000 - 1,
    NOW / 1000,
  ])(
    "rejects a missing, non-numeric or non-future expiry %p",
    async (expires_at) => {
      await expectInvalidBody({
        ...soloResponse(),
        session: { token: SESSION_TOKEN, expires_at },
      })
    },
  )

  test("rejects an infinite expiry parsed from valid JSON", async () => {
    const body = JSON.stringify(soloResponse()).replace(
      String(EXPIRES_AT),
      "1e400",
    )
    fetchMock.mockResolvedValueOnce(new Response(body))
    await Promise.resolve(
      expect(getFusionSelection(PROMPT)).rejects.toThrow("invalid_body"),
    )
    expect(errorLog).not.toHaveBeenCalled()
  })

  test("does not fall back to a header or step-local session", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          fusion_pattern: "solo",
          steps: [{ model_id: "model", session: soloResponse().session }],
        },
        { headers: { "Copilot-Session-Token": SESSION_TOKEN } },
      ),
    )
    await Promise.resolve(
      expect(getFusionSelection(PROMPT)).rejects.toThrow("invalid_body"),
    )
  })

  test("replaces JSON parser details with a safe classification", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(`{"session":"${SESSION_TOKEN}"`),
    )
    const error: unknown = await getFusionSelection(PROMPT).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error("Expected Error")
    expect(error.message).toBe(
      "Invalid Fusion selection response: invalid_json",
    )
    expect(error.cause).toBeUndefined()
    expect(errorLog).not.toHaveBeenCalled()
  })

  test.each([400, 401, 403, 404, 429, 500])(
    "preserves HTTP %i for scheduling without logging upstream secrets",
    async (status) => {
      const response = Response.json(
        { error: { code: "model_pool_not_eligible", message: SESSION_TOKEN } },
        {
          status,
          statusText: "status-text-secret-sentinel",
          headers: {
            "Retry-After": "42",
            "Copilot-Edits-Session": SESSION_TOKEN,
          },
        },
      )
      fetchMock.mockResolvedValueOnce(response)
      const error: unknown = await getFusionSelection(PROMPT).catch(
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(HTTPError)
      if (!(error instanceof HTTPError)) throw new Error("Expected HTTPError")
      expect(error.message).toBe("Failed to get Fusion selection")
      expect(error.response).toBe(response)
      expect(response.bodyUsed).toBe(false)
      expect(response.headers.get("Retry-After")).toBe("42")
      expect(await response.json()).toEqual({
        error: { code: "model_pool_not_eligible", message: SESSION_TOKEN },
      })
      expect(errorLog).toHaveBeenCalledTimes(1)
      const logged = JSON.stringify(errorLog.mock.calls)
      expect(logged).toContain(`HTTP ${status}`)
      for (const secret of [
        SESSION_TOKEN,
        PROMPT,
        "copilot-auth-secret-sentinel",
        "fixture-session-secret-sentinel",
        "status-text-secret-sentinel",
        "model_pool_not_eligible",
      ]) {
        expect(logged).not.toContain(secret)
      }
    },
  )

  test("preserves fetch rejection without logging its possibly sensitive message", async () => {
    const error = new TypeError(SESSION_TOKEN)
    fetchMock.mockRejectedValueOnce(error)
    await Promise.resolve(
      expect(getFusionSelection(PROMPT)).rejects.toBe(error),
    )
    expect(errorLog).not.toHaveBeenCalled()
  })
})

test("Fusion seeds reuse the existing hello, code and intelligence prompts verbatim", () => {
  expect(getFusionProbePrompts()).toEqual([
    PREWARM_PROMPT,
    "Write a CSS rule to center a div using flexbox.",
    TARGET_CODE_PROMPT,
    getIntelligenceProbePrompt(),
  ])
  const first = getFusionProbePrompts()
  first[0] = "changed by caller"
  expect(getFusionProbePrompts()[0]).toBe(PREWARM_PROMPT)
})
