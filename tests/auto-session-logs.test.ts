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
} from "../src/lib/auto-session"
import type { AutoSelectionResponse } from "../src/services/copilot/get-auto-selection"

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

beforeEach(() => {
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
  mock.restore()
})

describe("auto-session logging", () => {
  test("logs discovery summary with deduped model ids and incomplete count", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(selection("gpt-5.3-codex", "token-initial"))

    const infoSpy = spyOn(consola, "info")

    await prewarmAutoSession()

    // 仅 1 个探测点成功，其余 7 个未完成；日志只含去重模型 ID 与数量
    expect(infoSpy).toHaveBeenCalledWith(
      "[auto-session] discovery complete models=gpt-5.3-codex incomplete=7",
    )
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
})
