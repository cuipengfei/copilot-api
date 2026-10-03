import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { state } from "~/lib/state"
import { sleep } from "~/lib/utils"
import {
  cacheModels,
  stopModelsRefreshLoop,
} from "~/services/copilot/models-cache"

const makeModels = (ids: Array<string>) => ({
  data: ids.map((id) => ({
    id,
    model_picker_enabled: true,
    capabilities: { type: "chat" as const },
  })),
})

const fetcherMock = mock(() => Promise.resolve(makeModels(["m1"])))

// Short interval so the background timer fires within test timeouts; 50ms
// is small enough for wait(200ms) to observe one tick yet not a tight loop
// if a stray timer leaks past the afterEach.
const TEST_INTERVAL_MS = 50

beforeEach(() => {
  state.models = undefined
  fetcherMock.mockClear()
  fetcherMock.mockImplementation(() => Promise.resolve(makeModels(["m1"])))
})

afterEach(() => {
  stopModelsRefreshLoop()
})

test("cacheModels populates state.models on first call", async () => {
  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  expect(state.models?.data.map((m) => m.id)).toEqual(["m1"])
  expect(fetcherMock).toHaveBeenCalledTimes(1)
})

test("background timer picks up newly-rolled-out models", async () => {
  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  expect(state.models?.data.map((m) => m.id)).toEqual(["m1"])

  fetcherMock.mockImplementation(() =>
    Promise.resolve(makeModels(["m1", "m2"])),
  )

  await sleep(200)

  expect(fetcherMock.mock.calls.length).toBeGreaterThan(1)
  expect(state.models?.data.map((m) => m.id)).toContain("m2")
})

test("refresh failure keeps the previous cache", async () => {
  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  const before = state.models

  fetcherMock.mockImplementation(() =>
    Promise.reject(new Error("upstream blip")),
  )

  await sleep(500)

  expect(state.models).toEqual(before)
})

test("stopModelsRefreshLoop prevents further refreshes", async () => {
  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  stopModelsRefreshLoop()
  const callsAfterStop = fetcherMock.mock.calls.length

  await sleep(500)

  expect(fetcherMock.mock.calls.length).toBe(callsAfterStop)
})

test("a refresh already in flight neither writes state nor revives the loop", async () => {
  const inFlight = Promise.withResolvers<ReturnType<typeof makeModels>>()
  const secondFetchStarted = Promise.withResolvers<void>()
  let calls = 0
  fetcherMock.mockImplementation(() => {
    calls += 1
    if (calls === 1) return Promise.resolve(makeModels(["m1"]))
    secondFetchStarted.resolve()
    return inFlight.promise
  })

  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  const before = state.models

  // The timer has fired and /models is in flight when the reload stops the
  // loop, which is also when a sign-out clears state.models.
  await secondFetchStarted.promise
  stopModelsRefreshLoop()
  const callsAfterStop = fetcherMock.mock.calls.length
  inFlight.resolve(makeModels(["m1", "stale"]))
  await sleep(300)

  expect(state.models).toBe(before)
  expect(state.models?.data.map((m) => m.id)).not.toContain("stale")
  expect(fetcherMock.mock.calls.length).toBe(callsAfterStop)
})

test("a new cacheModels supersedes an in-flight refresh from the old token", async () => {
  const inFlightOldToken =
    Promise.withResolvers<ReturnType<typeof makeModels>>()
  const oldTokenFetchStarted = Promise.withResolvers<void>()
  let calls = 0
  fetcherMock.mockImplementation(() => {
    calls += 1
    if (calls === 1) return Promise.resolve(makeModels(["a1"]))
    oldTokenFetchStarted.resolve()
    return inFlightOldToken.promise
  })

  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  await oldTokenFetchStarted.promise

  // A config reload that switches the GitHub token re-runs cacheModels for the
  // new account while the previous account's /models request is still open.
  fetcherMock.mockImplementation(() => Promise.resolve(makeModels(["b1"])))
  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  expect(state.models?.data.map((m) => m.id)).toEqual(["b1"])

  // Pin the fetcher so a loop tick during the wait below cannot rewrite
  // state.models and mask the stale write this test is looking for.
  fetcherMock.mockImplementation(() => new Promise(() => {}))
  inFlightOldToken.resolve(makeModels(["a1", "stale-a"]))
  await sleep(200)

  expect(state.models?.data.map((m) => m.id)).toEqual(["b1"])
})
