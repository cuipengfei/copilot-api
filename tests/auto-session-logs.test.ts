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
  getAutoSessionTokenForModel,
  invalidateAutoSession,
  prewarmAutoSession,
  refreshAutoSession,
  registerAutoSelection,
  runProbePoint,
} from "../src/lib/auto-session"
import type { AutoSelectionResponse } from "../src/services/copilot/get-auto-selection"
import { getConfig } from "../src/lib/config-store"
import { state } from "../src/lib/state"

const selection = (
  modelId: string,
  sessionToken: string,
): AutoSelectionResponse => ({
  selected_model: { id: modelId },
  session_token: sessionToken,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
})

const createResponse = (payload: AutoSelectionResponse) =>
  new Response(JSON.stringify(payload), { status: 200 })

const originalFetch = globalThis.fetch
const originalTargets = getConfig().autoDiscovery
const originalToken = state.copilotToken

beforeEach(() => {
  getConfig().autoDiscovery = undefined
  state.copilotToken = "logging-auth-token"
  invalidateAutoSession()
  const queue: Array<AutoSelectionResponse> = []
  ;(
    globalThis as unknown as { __AUTO_SESSION_QUEUE__?: typeof queue }
  ).__AUTO_SESSION_QUEUE__ = queue

  const fetchMock = mock(() => {
    const currentQueue = (
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__?: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__

    if (!currentQueue || currentQueue.length === 0) {
      throw new Error("missing queued /auto response")
    }

    const nextPayload = currentQueue.shift()
    if (!nextPayload) {
      throw new Error("missing queued /auto response")
    }

    return Promise.resolve(createResponse(nextPayload))
  })

  // @ts-expect-error Bun mock is enough for runtime; typed fetch extras are not required in test
  ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock
})

afterEach(() => {
  invalidateAutoSession()
  globalThis.fetch = originalFetch
  getConfig().autoDiscovery = originalTargets
  state.copilotToken = originalToken
  mock.restore()
})

describe("auto-session logging", () => {
  test("startup reports targets and one result without acquisition info", async () => {
    const infoSpy = spyOn(consola, "info")
    const queue = Reflect.get(
      globalThis,
      "__AUTO_SESSION_QUEUE__",
    ) as Array<AutoSelectionResponse>
    queue.push(selection("extra-model", "private-token"))
    await prewarmAutoSession()
    expect(infoSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      "[auto-session] discovery start wanted=[]",
      '[auto-session] discovery result obtained=["extra-model"] missing=[]',
    ])
  })

  test("invalid selection emits only one warning per response", async () => {
    const warnSpy = spyOn(consola, "warn")
    const queue = Reflect.get(
      globalThis,
      "__AUTO_SESSION_QUEUE__",
    ) as Array<AutoSelectionResponse>
    queue.push({
      ...selection("invalid-model", "private-token"),
      expires_at: 0,
    })
    expect(
      await runProbePoint("balance", "easy", "hello", false, 1),
    ).toBeUndefined()
    expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      "[auto-session] ignored invalid auto selection",
    ])
  })
  test("registration reports model acquisition only at debug level", () => {
    const infoSpy = spyOn(consola, "info")
    const debugSpy = spyOn(consola, "debug")
    registerAutoSelection(selection("wanted-model", "secret-session-token"))
    expect(infoSpy).not.toHaveBeenCalled()
    expect(debugSpy).toHaveBeenCalledWith(
      '[auto-session] acquired model="wanted-model"',
    )
    expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(
      "secret-session-token",
    )
  })

  test("same-model refresh remains quiet and preserves its hit log", async () => {
    registerAutoSelection(selection("extra-model", "first-token"))
    const infoSpy = spyOn(consola, "info")
    const queue = Reflect.get(
      globalThis,
      "__AUTO_SESSION_QUEUE__",
    ) as Array<AutoSelectionResponse>
    queue.push(selection("extra-model", "second-token"))
    await refreshAutoSession()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(await getAutoSessionTokenForModel("extra-model")).toBe(
      "second-token",
    )
    expect(infoSpy).toHaveBeenCalledWith("[auto-session] hit model=extra-model")
  })

  test("logs hit event via consola.info when model is covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(selection("gpt-5.3-codex", "token-initial"))

    const infoSpy = spyOn(consola, "info")

    await prewarmAutoSession()
    await getAutoSessionTokenForModel("gpt-5.3-codex")

    expect(infoSpy).toHaveBeenCalledWith(
      "[auto-session] hit model=gpt-5.3-codex",
    )
  })

  test("logs miss event via consola.info when model is not covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(selection("gpt-5.3-codex", "token-initial"))

    const infoSpy = spyOn(consola, "info")

    await prewarmAutoSession()
    await getAutoSessionTokenForModel("not-covered")

    expect(infoSpy).toHaveBeenCalledWith(
      "[auto-session] miss model=not-covered",
    )
  })

  test("colors hit and miss only in interactive terminals", async () => {
    const queue: unknown = Reflect.get(globalThis, "__AUTO_SESSION_QUEUE__")
    if (!Array.isArray(queue)) throw new Error("expected auto-session queue")
    queue.push(selection("gpt-5.3-codex", "token-initial"))

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
      await prewarmAutoSession()
      await getAutoSessionTokenForModel("gpt-5.3-codex")
      await getAutoSessionTokenForModel("not-covered")
      expect(infoSpy).toHaveBeenCalledWith(
        "[auto-session] \x1b[1;92mhit\x1b[0m model=gpt-5.3-codex",
      )
      expect(infoSpy).toHaveBeenCalledWith(
        "[auto-session] \x1b[1;93mmiss\x1b[0m model=not-covered",
      )

      process.env.NO_COLOR = "1"
      await getAutoSessionTokenForModel("gpt-5.3-codex")
      expect(infoSpy).toHaveBeenCalledWith(
        "[auto-session] hit model=gpt-5.3-codex",
      )
    } finally {
      if (ttyDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", ttyDescriptor)
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY")
      }
      if (noColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = noColor
    }
  })
})
