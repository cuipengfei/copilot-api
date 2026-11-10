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
import consola from "consola"

import {
  getAutoSessionForModel,
  invalidateAutoSession,
  prewarmAutoSession,
  refreshAutoSession,
  registerAutoSelection,
  registerFusionSelection,
  runProbePoint,
  stopProbeScheduler,
  whenProbeSchedulerIdle,
} from "../src/lib/auto-session"
import { getConfig } from "../src/lib/config-store"
import { state } from "../src/lib/state"
import type { AutoSelectionResponse } from "../src/services/copilot/get-auto-selection"

const selection = (
  modelId: string,
  sessionToken: string,
): AutoSelectionResponse => ({
  selected_model: { id: modelId, supported_endpoints: ["/responses"] },
  session_token: sessionToken,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
})

const originalFetch = globalThis.fetch
const originalTargets = getConfig().autoDiscovery
const originalToken = state.copilotToken
const originalModels = state.models
let queue: Array<AutoSelectionResponse>

interface LogSpy {
  mock: { calls: Array<Array<unknown>> }
}

const messages = (spy: LogSpy): Array<string> =>
  spy.mock.calls.map((call) => call.map(String).join(" "))
const expectFields = (lines: Array<string>, fields: Array<string>): void => {
  expect(
    lines.some((line) => fields.every((field) => line.includes(field))),
  ).toBe(true)
}

beforeEach(() => {
  getConfig().autoDiscovery = undefined
  state.copilotToken = "AUTH_HEADER_SENSITIVE_SENTINEL"
  state.models = {
    object: "list",
    data: [
      { id: "wanted-model", supported_endpoints: ["/responses"] },
      { id: "extra-model", supported_endpoints: ["/responses"] },
      { id: "gpt-5.3-codex", supported_endpoints: ["/responses"] },
    ],
  } as typeof state.models
  invalidateAutoSession()
  queue = []

  const fetchMock = mock((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/model/fusion") {
      return Promise.resolve(
        Response.json(
          { error: { code: "model_pool_not_eligible" } },
          { status: 403 },
        ),
      )
    }
    if (url.pathname !== "/auto") {
      throw new Error("unexpected logging fixture endpoint")
    }
    const payload = queue.shift()
    return Promise.resolve(
      payload ? Response.json(payload) : new Response(null, { status: 400 }),
    )
  })

  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(async () => {
  invalidateAutoSession()
  try {
    await whenProbeSchedulerIdle()
  } finally {
    mock.restore()
    globalThis.fetch = originalFetch
    getConfig().autoDiscovery = originalTargets
    state.copilotToken = originalToken
    state.models = originalModels
  }
})

afterAll(async () => {
  stopProbeScheduler()
  await whenProbeSchedulerIdle()
})

describe("auto-session logging", () => {
  test("startup reports acquisition and discovery source coverage at info", async () => {
    const infoSpy = spyOn(consola, "info")
    queue.push(selection("extra-model", "SESSION_SENSITIVE_SENTINEL"))

    await prewarmAutoSession()

    const lines = messages(infoSpy)
    expectFields(lines, ["[auto-session]", "discovery", "wanted=[]"])
    expectFields(lines, [
      "[auto-session]",
      "extra-model",
      "source=auto",
      "expected_discount=10%",
    ])
    expectFields(lines, [
      "obtained=",
      "extra-model",
      "missing=[]",
      "fusion_obtained=",
      "auto_obtained=",
      "fusion_missing=",
      "auto_missing=",
    ])
    expect(lines.join("\n")).not.toContain("SESSION_SENSITIVE_SENTINEL")
  })

  test("invalid selection emits one safe warning per response", async () => {
    const warnSpy = spyOn(consola, "warn")
    queue.push({
      ...selection("invalid-model", "PRIVATE_SESSION"),
      expires_at: 0,
    })
    expect(
      await runProbePoint("balance", "easy", "PRIVATE_SOURCE_PROMPT", false, 1),
    ).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(messages(warnSpy).join("\n")).not.toContain("PRIVATE_SESSION")
    expect(messages(warnSpy).join("\n")).not.toContain("PRIVATE_SOURCE_PROMPT")
  })

  test("acquisition and upgrade expose expected discounts without credentials", async () => {
    const infoSpy = spyOn(consola, "info")
    expect(
      registerAutoSelection(selection("wanted-model", "AUTO_PRIVATE")),
    ).toBe(true)
    expectFields(messages(infoSpy), [
      'model="wanted-model"',
      "source=auto",
      "expected_discount=10%",
    ])

    infoSpy.mockClear()
    expect(
      registerFusionSelection({
        modelId: "wanted-model",
        sessionToken: "FUSION_PRIVATE",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toBe(true)
    expectFields(messages(infoSpy), [
      "upgraded",
      "previous_discount=10%",
      'model="wanted-model"',
      "source=fusion",
      "expected_discount=30%",
    ])
    expect(
      await getAutoSessionForModel({
        model: "wanted-model",
        endpoint: "/responses",
      }),
    ).toEqual({
      sessionToken: "FUSION_PRIVATE",
      source: "fusion",
      expectedDiscount: 30,
    })
    expectFields(messages(infoSpy), [
      "hit",
      'model="wanted-model"',
      'endpoint="/responses"',
      "source=fusion",
      "expected_discount=30%",
    ])
    const output = messages(infoSpy).join("\n")
    for (const secret of [
      "AUTO_PRIVATE",
      "FUSION_PRIVATE",
      state.copilotToken!,
    ]) {
      expect(output).not.toContain(secret)
    }
  })

  test("same-source renewal is visible at info and selects the renewed token", async () => {
    registerAutoSelection(selection("extra-model", "FIRST_PRIVATE_TOKEN"))
    const infoSpy = spyOn(consola, "info")
    queue.push(selection("extra-model", "SECOND_PRIVATE_TOKEN"))
    await refreshAutoSession()
    expectFields(messages(infoSpy), [
      "refresh",
      'model="extra-model"',
      "source=auto",
      "expected_discount=10%",
    ])
    expect(
      await getAutoSessionForModel({
        model: "extra-model",
        endpoint: "/responses",
      }),
    ).toEqual({
      sessionToken: "SECOND_PRIVATE_TOKEN",
      source: "auto",
      expectedDiscount: 10,
    })
    expectFields(messages(infoSpy), [
      "hit",
      'endpoint="/responses"',
      "source=auto",
      "expected_discount=10%",
    ])
    expect(messages(infoSpy).join("\n")).not.toContain("PRIVATE_TOKEN")
  })

  test("expired Fusion falls back to Auto with source-correct info", async () => {
    await prewarmAutoSession()
    await whenProbeSchedulerIdle()
    const now = Date.now()
    registerAutoSelection(selection("wanted-model", "AUTO_EXPIRY_PRIVATE"))
    registerFusionSelection({
      modelId: "wanted-model",
      sessionToken: "FUSION_EXPIRY_PRIVATE",
      expiresAt: Math.floor(now / 1000) + 600,
    })
    const infoSpy = spyOn(consola, "info")
    const clock = spyOn(Date, "now").mockReturnValue(now + 601_000)
    try {
      expect(
        await getAutoSessionForModel({
          model: "wanted-model",
          endpoint: "/responses",
          waitForDiscovery: false,
        }),
      ).toEqual({
        sessionToken: "AUTO_EXPIRY_PRIVATE",
        source: "auto",
        expectedDiscount: 10,
      })
      expectFields(messages(infoSpy), [
        'model="wanted-model"',
        "source=fusion",
        "expected_discount=30%",
        "reason=expired",
      ])
      expectFields(messages(infoSpy), [
        "hit",
        "source=auto",
        "expected_discount=10%",
      ])
      expect(messages(infoSpy).join("\n")).not.toContain("EXPIRY_PRIVATE")
    } finally {
      clock.mockRestore()
    }
  })

  test("uncovered requests report no-token fields and escaped model IDs", async () => {
    const infoSpy = spyOn(consola, "info")
    const model = 'not-covered\nsource=fusion"'
    expect(
      await getAutoSessionForModel({ model, endpoint: "/responses" }),
    ).toBeUndefined()
    expectFields(messages(infoSpy), [
      "miss",
      `model=${JSON.stringify(model)}`,
      'endpoint="/responses"',
      "source=none",
      "expected_discount=0%",
    ])
    expect(messages(infoSpy).join("\n")).not.toContain("not-covered\n")
  })

  test("probe errors never log raw source, response, headers or exception text", async () => {
    const spies = [
      spyOn(consola, "info"),
      spyOn(consola, "warn"),
      spyOn(consola, "error"),
      spyOn(consola, "debug"),
    ]
    globalThis.fetch = mock(() => {
      throw new Error("RAW_ERROR_SOURCE_AND_HEADER_SENTINEL")
    }) as unknown as typeof fetch
    expect(
      await runProbePoint("balance", "easy", "PRIVATE_SOURCE_PROMPT", false, 1),
    ).toBeUndefined()

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("RAW_RESPONSE_BODY_SENTINEL", {
          status: 400,
          statusText: "RAW_STATUS_SENTINEL",
          headers: { "x-private-header": "RAW_HEADER_SENTINEL" },
        }),
      ),
    ) as unknown as typeof fetch
    expect(
      await runProbePoint("balance", "hard", "PRIVATE_SOURCE_PROMPT", false, 1),
    ).toBeUndefined()
    const output = spies.flatMap(messages).join("\n")
    for (const sentinel of [
      "RAW_ERROR_SOURCE_AND_HEADER_SENTINEL",
      "PRIVATE_SOURCE_PROMPT",
      "RAW_RESPONSE_BODY_SENTINEL",
      "RAW_STATUS_SENTINEL",
      "RAW_HEADER_SENTINEL",
      state.copilotToken!,
    ]) {
      expect(output).not.toContain(sentinel)
    }
  })

  test("colors hit and miss only in interactive terminals", async () => {
    registerAutoSelection(selection("gpt-5.3-codex", "COLOR_PRIVATE_TOKEN"))
    const ttyDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    )
    const noColor = process.env.NO_COLOR
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    })
    delete process.env.NO_COLOR

    try {
      const infoSpy = spyOn(consola, "info")
      await getAutoSessionForModel({
        model: "gpt-5.3-codex",
        endpoint: "/responses",
      })
      await getAutoSessionForModel({
        model: "not-covered",
        endpoint: "/responses",
      })
      expectFields(messages(infoSpy), ["\x1b[1;92mhit\x1b[0m", "source=auto"])
      expectFields(messages(infoSpy), ["\x1b[1;93mmiss\x1b[0m", "source=none"])

      process.env.NO_COLOR = "1"
      infoSpy.mockClear()
      await getAutoSessionForModel({
        model: "gpt-5.3-codex",
        endpoint: "/responses",
      })
      expectFields(messages(infoSpy), [
        "hit",
        "source=auto",
        "expected_discount=10%",
      ])
      expect(messages(infoSpy).join("\n")).not.toContain("\x1b[")
    } finally {
      if (ttyDescriptor)
        Object.defineProperty(process.stdout, "isTTY", ttyDescriptor)
      else Reflect.deleteProperty(process.stdout, "isTTY")
      if (noColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = noColor
    }
  })
})
