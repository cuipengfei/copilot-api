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

import type * as AutoSessionModule from "../src/lib/auto-session"
import { getConfig } from "../src/lib/config-store"
import * as logger from "../src/lib/logger"
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
const originalNoColor = process.env.NO_COLOR
const originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
let sessions: typeof AutoSessionModule
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

beforeEach(async () => {
  getConfig().autoDiscovery = undefined
  process.env.NO_COLOR = "1"
  state.copilotToken = "AUTH_HEADER_SENSITIVE_SENTINEL"
  state.models = {
    object: "list",
    data: [
      { id: "wanted-model", supported_endpoints: ["/responses"] },
      { id: "extra-model", supported_endpoints: ["/responses"] },
      { id: "gpt-5.3-codex", supported_endpoints: ["/responses"] },
    ],
  } as typeof state.models
  // Static imports retain scheduler-stop state and discovery metadata between cases.
  sessions = (await import(
    `../src/lib/auto-session?logs=${Date.now()}-${Math.random()}`
  )) as typeof AutoSessionModule
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
  sessions.stopProbeScheduler()
  try {
    await sessions.whenProbeSchedulerIdle()
  } finally {
    sessions.invalidateAutoSession()
    mock.restore()
    globalThis.fetch = originalFetch
    getConfig().autoDiscovery = originalTargets
    state.copilotToken = originalToken
    state.models = originalModels
    if (originalNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = originalNoColor
    if (originalTty) Object.defineProperty(process.stdout, "isTTY", originalTty)
    else Reflect.deleteProperty(process.stdout, "isTTY")
  }
})

describe("auto-session logging", () => {
  test("startup reports acquisition and complete discovery coverage once", async () => {
    const infoSpy = spyOn(consola, "info")
    getConfig().autoDiscovery = { models: ["extra-model"] }
    queue.push(selection("extra-model", "SESSION_SENSITIVE_SENTINEL"))

    await sessions.prewarmAutoSession()
    await sessions.whenProbeSchedulerIdle()

    const lines = messages(infoSpy)
    expect(
      lines.filter((line) => line.includes("discovery start wanted=")),
    ).toEqual(['[auto-session] discovery start wanted=["extra-model"]'])
    expect(
      lines.filter((line) => line.includes("target discovery start")).sort(),
    ).toEqual([
      '[auto-session] target discovery start source=auto reason=startup missing=["extra-model"]',
      '[auto-session] target discovery start source=fusion reason=startup missing=["extra-model"]',
    ])
    expectFields(lines, [
      "acquired",
      "model=extra-model",
      "source=auto",
      "expected_discount=10%",
    ])
    expectFields(lines, [
      "discovery result",
      'obtained=["extra-model"]',
      "missing=[]",
      "fusion_obtained=[]",
      'auto_obtained=["extra-model"]',
      'fusion_missing=["extra-model"]',
      "auto_missing=[]",
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
      await sessions.runProbePoint(
        "balance",
        "easy",
        "PRIVATE_SOURCE_PROMPT",
        false,
        1,
      ),
    ).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(messages(warnSpy).join("\n")).not.toContain("PRIVATE_SESSION")
    expect(messages(warnSpy).join("\n")).not.toContain("PRIVATE_SOURCE_PROMPT")
  })

  test("first candidates and the Auto to Fusion upgrade are visible without credentials", async () => {
    const infoSpy = spyOn(consola, "info")
    expect(
      sessions.registerAutoSelection(selection("wanted-model", "AUTO_PRIVATE")),
    ).toBe(true)
    expectFields(messages(infoSpy), [
      "acquired",
      "model=wanted-model",
      "source=auto",
      "expected_discount=10%",
    ])

    infoSpy.mockClear()
    expect(
      sessions.registerFusionSelection({
        modelId: "extra-model",
        sessionToken: "FIRST_FUSION_PRIVATE",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toBe(true)
    expectFields(messages(infoSpy), [
      "acquired",
      "model=extra-model",
      "source=fusion",
      "expected_discount=30%",
    ])
    expect(
      sessions.registerFusionSelection({
        modelId: "wanted-model",
        sessionToken: "FUSION_PRIVATE",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toBe(true)
    expectFields(messages(infoSpy), [
      "upgraded",
      "previous_discount=10%",
      "model=wanted-model",
      "source=fusion",
      "expected_discount=30%",
    ])
    expect(
      await sessions.getAutoSessionForModel({
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
      "model=wanted-model",
      "endpoint=/responses",
      "source=fusion",
      "expected_discount=30%",
    ])
    expect(messages(infoSpy).join("\n")).not.toContain("PRIVATE")
    expect(messages(infoSpy).join("\n")).not.toContain(state.copilotToken!)
  })

  test.each(["auto", "fusion"] as const)(
    "duplicate %s sampling quietly replaces the token, expiry and refresh timer",
    async (source) => {
      let now = Math.floor(Date.now() / 1000) * 1000
      spyOn(Date, "now").mockImplementation(() => now)
      const timerSpy = spyOn(globalThis, "setTimeout")
      const clearTimerSpy = spyOn(globalThis, "clearTimeout")
      const register = (token: string, lifetime: number): boolean =>
        source === "auto" ?
          sessions.registerAutoSelection({
            ...selection("wanted-model", token),
            expires_at: Math.floor(now / 1000) + lifetime,
          })
        : sessions.registerFusionSelection({
            modelId: "wanted-model",
            sessionToken: token,
            expiresAt: Math.floor(now / 1000) + lifetime,
          })
      expect(register("FIRST_PRIVATE_TOKEN", 600)).toBe(true)
      expect(timerSpy.mock.calls.at(-1)?.[1]).toBe(300_000)
      const originalTimer = timerSpy.mock.results.at(-1)?.value
      const infoSpy = spyOn(consola, "info")
      const debugSpy = spyOn(consola, "debug")
      now += 60_000
      if (source === "auto") {
        queue.push(selection("wanted-model", "SECOND_PRIVATE_TOKEN"))
        expect(
          await sessions.runProbePoint(
            "balance",
            "easy",
            "PRIVATE_SOURCE_PROMPT",
            false,
            1,
          ),
        ).toBe("wanted-model")
      } else {
        expect(register("SECOND_PRIVATE_TOKEN", 3600)).toBe(true)
      }
      expect(messages(infoSpy)).toEqual([])
      expectFields(messages(debugSpy), [
        "refresh",
        "model=wanted-model",
        `source=${source}`,
      ])
      expect(clearTimerSpy).toHaveBeenCalledWith(originalTimer)
      expect(timerSpy.mock.calls.at(-1)?.[1]).toBe(3_300_000)

      // Past the original expiry, the new candidate must still be usable.
      now += 601_000
      expect(
        await sessions.getAutoSessionForModel({
          model: "wanted-model",
          endpoint: "/responses",
        }),
      ).toEqual({
        sessionToken: "SECOND_PRIVATE_TOKEN",
        source,
        expectedDiscount: source === "fusion" ? 30 : 10,
      })
      expect(messages(infoSpy).some((line) => line.includes("expired"))).toBe(
        false,
      )
      expect(
        [...messages(infoSpy), ...messages(debugSpy)].join("\n"),
      ).not.toContain("PRIVATE_TOKEN")
    },
  )

  test("explicit refresh remains visible and selects the renewed token", async () => {
    sessions.registerAutoSelection(
      selection("extra-model", "FIRST_PRIVATE_TOKEN"),
    )
    const infoSpy = spyOn(consola, "info")
    queue.push(selection("extra-model", "SECOND_PRIVATE_TOKEN"))
    await sessions.refreshAutoSession()
    expectFields(messages(infoSpy), [
      "refresh",
      "model=extra-model",
      "source=auto",
      "expected_discount=10%",
    ])
    expect(
      await sessions.getAutoSessionForModel({
        model: "extra-model",
        endpoint: "/responses",
      }),
    ).toEqual({
      sessionToken: "SECOND_PRIVATE_TOKEN",
      source: "auto",
      expectedDiscount: 10,
    })
    expect(messages(infoSpy).join("\n")).not.toContain("PRIVATE_TOKEN")
  })

  test("timer refresh is reported only after the renewal response succeeds", async () => {
    let now = Math.floor(Date.now() / 1000) * 1000
    spyOn(Date, "now").mockImplementation(() => now)
    const timerSpy = spyOn(globalThis, "setTimeout")
    sessions.registerAutoSelection({
      ...selection("wanted-model", "TIMER_OLD_PRIVATE"),
      expires_at: Math.floor(now / 1000) + 600,
    })
    const callback = timerSpy.mock.calls.find(
      (call) => call[1] === 300_000,
    )?.[0]
    expect(typeof callback).toBe("function")
    const gate = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<void>()
    globalThis.fetch = mock(() => {
      started.resolve()
      return gate.promise
    }) as unknown as typeof fetch
    const infoSpy = spyOn(consola, "info")
    try {
      now += 300_000
      if (typeof callback !== "function")
        throw new Error("missing refresh timer")
      callback()
      await started.promise
      expect(messages(infoSpy).some((line) => line.includes(" refresh "))).toBe(
        false,
      )
      gate.resolve(
        Response.json(selection("wanted-model", "TIMER_NEW_PRIVATE")),
      )
      await sessions.whenProbeSchedulerIdle()
      expectFields(messages(infoSpy), [
        "refresh",
        "model=wanted-model",
        "source=auto",
      ])
      expect(
        (await sessions.getAutoSessionForModel({ model: "wanted-model" }))
          ?.sessionToken,
      ).toBe("TIMER_NEW_PRIVATE")
      expect(messages(infoSpy).join("\n")).not.toContain("PRIVATE")
    } finally {
      gate.resolve(new Response(null, { status: 400 }))
    }
  })

  test.each(["expired", "rejected"] as const)(
    "%s Auto candidates recover at info rather than debug",
    async (reason) => {
      let now = Math.floor(Date.now() / 1000) * 1000
      spyOn(Date, "now").mockImplementation(() => now)
      sessions.registerAutoSelection({
        ...selection("wanted-model", "OLD_RECOVERY_PRIVATE"),
        expires_at: Math.floor(now / 1000) + 600,
      })
      const infoSpy = spyOn(consola, "info")
      queue.push(selection("wanted-model", "NEW_RECOVERY_PRIVATE"))
      if (reason === "expired") {
        now += 601_000
        expect(
          await sessions.getAutoSessionForModel({
            model: "wanted-model",
            waitForDiscovery: false,
          }),
        ).toBeUndefined()
      } else {
        expect(
          sessions.invalidateAutoSessionPairing(
            "wanted-model",
            "OLD_RECOVERY_PRIVATE",
          ),
        ).toBe(true)
      }
      await sessions.whenProbeSchedulerIdle()
      expectFields(messages(infoSpy), [
        reason,
        "model=wanted-model",
        "source=auto",
      ])
      expectFields(messages(infoSpy), [
        "acquired",
        "model=wanted-model",
        "source=auto",
        "expected_discount=10%",
      ])
      expect(
        (await sessions.getAutoSessionForModel({ model: "wanted-model" }))
          ?.sessionToken,
      ).toBe("NEW_RECOVERY_PRIVATE")
      expect(messages(infoSpy).join("\n")).not.toContain("RECOVERY_PRIVATE")
    },
  )

  test("expired Fusion falls back to Auto with source-correct info", async () => {
    await sessions.prewarmAutoSession()
    await sessions.whenProbeSchedulerIdle()
    const now = Date.now()
    sessions.registerAutoSelection(
      selection("wanted-model", "AUTO_EXPIRY_PRIVATE"),
    )
    sessions.registerFusionSelection({
      modelId: "wanted-model",
      sessionToken: "FUSION_EXPIRY_PRIVATE",
      expiresAt: Math.floor(now / 1000) + 600,
    })
    const infoSpy = spyOn(consola, "info")
    spyOn(Date, "now").mockReturnValue(now + 601_000)
    expect(
      await sessions.getAutoSessionForModel({
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
      "model=wanted-model",
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
  })

  test("model IDs cannot inject log lines or terminal controls", async () => {
    const spies = [spyOn(consola, "info"), spyOn(consola, "debug")]
    const model = 'not-covered\n\r\t\x1b[31m\u0085\u2028\u2029source=fusion"'
    const escaped = JSON.stringify(model).replace(
      /[\u0080-\u009f\u2028\u2029]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    sessions.registerAutoSelection(selection(model, "CONTROL_PRIVATE_TOKEN"))
    await sessions.getAutoSessionForModel({ model, endpoint: "/responses" })
    sessions.registerAutoSelection(selection(model, "RENEWED_PRIVATE_TOKEN"))
    expect(
      await sessions.getAutoSessionForModel({
        model: `${model}-miss`,
        endpoint: "/responses",
      }),
    ).toBeUndefined()
    const lines = spies.flatMap(messages)
    expectFields(lines, ["acquired", `model=${escaped}`, "source=auto"])
    expectFields(lines, ["hit", `model=${escaped}`, "endpoint=/responses"])
    expectFields(lines, ["refresh", `model=${escaped}`, "source=auto"])
    expectFields(lines, ["miss", "source=none", "expected_discount=0%"])
    for (const line of lines) {
      expect(
        [...line].some((character) => {
          const code = character.codePointAt(0)!
          return (
            code < 32
            || (code >= 127 && code <= 159)
            || code === 0x2028
            || code === 0x2029
          )
        }),
      ).toBe(false)
      expect(line).not.toContain("PRIVATE_TOKEN")
      expect(line).not.toContain(state.copilotToken!)
    }
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
      await sessions.runProbePoint(
        "balance",
        "hard",
        "PRIVATE_SOURCE_PROMPT",
        false,
        1,
      ),
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
      await sessions.runProbePoint(
        "balance",
        "hard",
        "PRIVATE_SOURCE_PROMPT",
        false,
        1,
      ),
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

  test.each([
    { tty: true, noColor: undefined, colored: true },
    { tty: true, noColor: "", colored: false },
    { tty: false, noColor: undefined, colored: false },
  ])(
    "terminal colors respect TTY=$tty and NO_COLOR=$noColor",
    async ({ tty, noColor, colored }) => {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: tty,
      })
      if (noColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = noColor
      const colorSpy = spyOn(logger, "shouldUseColor")
      const infoSpy = spyOn(consola, "info")
      sessions.registerAutoSelection(
        selection("gpt-5.3-codex", "COLOR_PRIVATE_TOKEN"),
      )
      await sessions.getAutoSessionForModel({
        model: "gpt-5.3-codex",
        endpoint: "/responses",
      })
      await sessions.getAutoSessionForModel({
        model: "not-covered",
        endpoint: "/responses",
      })
      const lines = messages(infoSpy)
      expect(colorSpy).toHaveBeenCalled()
      if (colored) {
        expectFields(lines, [
          "acquired",
          `model=${logger.colorizeModel("gpt-5.3-codex")}`,
        ])
        expectFields(lines, [
          "\x1b[1;92mhit\x1b[0m",
          `model=${logger.colorizeModel("gpt-5.3-codex")}`,
          "source=auto",
        ])
        expectFields(lines, [
          "\x1b[1;93mmiss\x1b[0m",
          `model=${logger.colorizeModel("not-covered")}`,
          "source=none",
        ])
      } else {
        expectFields(lines, ["hit", "model=gpt-5.3-codex", "source=auto"])
        expectFields(lines, ["miss", "model=not-covered", "source=none"])
        expect(lines.join("\n")).not.toContain("\x1b[")
      }
      expect(lines.join("\n")).not.toContain("COLOR_PRIVATE_TOKEN")
    },
  )
})
