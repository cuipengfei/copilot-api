import {
  afterEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createHandlerLogger,
  debugJson,
  debugJsonAsync,
  debugJsonTail,
  shutdownLoggerRuntime,
} from "../src/lib/logger"
import { state } from "../src/lib/state"

const LOG_DIR_ENV = "COPILOT_API_LOG_DIR"
const originalLogDir = process.env[LOG_DIR_ENV]

afterEach(() => {
  shutdownLoggerRuntime()
  setSystemTime()
  state.verbose = false
  if (originalLogDir === undefined) {
    Reflect.deleteProperty(process.env, LOG_DIR_ENV)
  } else {
    process.env[LOG_DIR_ENV] = originalLogDir
  }
})

const localDate = (year: number, month: number, day: number): Date =>
  new Date(year, month - 1, day, 12)

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("Timed out waiting for logger state")
}

function trackLogStreams(): {
  restore: () => void
  streams: Array<fs.WriteStream>
} {
  const originalCreateWriteStream = fs.createWriteStream
  const streams: Array<fs.WriteStream> = []
  fs.createWriteStream = new Proxy(originalCreateWriteStream, {
    apply(target, thisArg, args) {
      const stream = Reflect.apply(target, thisArg, args) as fs.WriteStream
      streams.push(stream)
      return stream
    },
  })

  return {
    restore: () => {
      fs.createWriteStream = originalCreateWriteStream
    },
    streams,
  }
}

test("debugJson skips serialization when verbose logging is disabled", () => {
  state.verbose = false

  const logger = {
    debug: mock(() => {}),
  }
  const toJSON = mock(() => ({ ok: true }))

  debugJson(logger as never, "payload", { toJSON })

  expect(toJSON).not.toHaveBeenCalled()
  expect(logger.debug).not.toHaveBeenCalled()
})

describe("debugJsonAsync", () => {
  test("skips reading when verbose logging is disabled", async () => {
    state.verbose = false

    const logger = {
      debug: mock(() => {}),
    }
    const readValue = mock(() => Promise.resolve({ body: "request body" }))

    await debugJsonAsync(logger as never, "payload", readValue)

    expect(readValue).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  test("reads and logs when verbose logging is enabled", async () => {
    state.verbose = true

    const logger = {
      debug: mock(() => {}),
    }
    const payload = { body: "response body" }
    const readValue = mock(() => Promise.resolve(payload))

    await debugJsonAsync(logger as never, "payload", readValue)

    expect(readValue).toHaveBeenCalledTimes(1)
    expect(logger.debug).toHaveBeenCalledWith(
      "payload",
      JSON.stringify(payload),
    )
  })
})

describe("debugJson", () => {
  test("skips serialization when verbose logging is disabled", () => {
    state.verbose = false

    const logger = {
      debug: mock(() => {}),
    }
    const toJSON = mock(() => ({ ok: true }))

    debugJson(logger as never, "payload", { toJSON })

    expect(toJSON).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  test("logs the serialized payload when verbose logging is enabled", () => {
    state.verbose = true

    const logger = {
      debug: mock(() => {}),
    }
    const payload = { ok: true }

    debugJson(logger as never, "payload", payload)

    expect(logger.debug).toHaveBeenCalledWith(
      "payload",
      JSON.stringify(payload),
    )
  })
})

describe("debugJsonTail", () => {
  test("preserves tail truncation behavior", () => {
    state.verbose = true

    const logger = {
      debug: mock(() => {}),
    }
    const payload = { text: "abcdefghijklmnopqrstuvwxyz" }
    const expected = JSON.stringify(payload).slice(-10)

    debugJsonTail(logger as never, "payload", {
      value: payload,
      tailLength: 10,
    })

    expect(logger.debug).toHaveBeenCalledWith("payload", expected)
  })
})

test("createHandlerLogger writes to COPILOT_API_LOG_DIR when set", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir

  try {
    const logger = createHandlerLogger("env-override-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`line-${index}`)
    }

    const dateKey = new Date().toLocaleDateString("sv-SE")
    const filePath = path.join(logDir, `env-override-handler-${dateKey}.log`)

    // Poll until the last line is flushed to disk: the log file is created
    // asynchronously by fs.createWriteStream, so it can exist while still
    // empty. Checking only for existence would race with the async write.
    let content = ""
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, "utf8")
        if (content.includes("line-99")) {
          break
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(fs.existsSync(filePath)).toBe(true)
    expect(content).toContain("line-0")
    expect(content).toContain("line-99")
  } finally {
    // Close the write stream before deleting: Windows cannot remove a
    // directory while a file handle is still open. Retries cover the brief
    // window until the stream's fd is released after end().
    shutdownLoggerRuntime()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

test("createHandlerLogger closes the previous stream when the date changes", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir
  const trackedStreams = trackLogStreams()

  try {
    setSystemTime(localDate(2026, 1, 1))
    const logger = createHandlerLogger("rotating-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`first-day-${index}`)
    }

    const firstFilePath = path.join(logDir, "rotating-handler-2026-01-01.log")
    await waitFor(
      () =>
        trackedStreams.streams.length === 1
        && fs.existsSync(firstFilePath)
        && fs.readFileSync(firstFilePath, "utf8").includes("first-day-99"),
    )
    const firstStream = trackedStreams.streams[0]
    expect(firstStream.closed).toBe(false)

    setSystemTime(localDate(2026, 1, 2))
    for (let index = 0; index < 100; index += 1) {
      logger.error(`second-day-${index}`)
    }

    await waitFor(() => firstStream.closed)
    expect(firstStream.closed).toBe(true)

    const secondFilePath = path.join(logDir, "rotating-handler-2026-01-02.log")
    await waitFor(
      () =>
        fs.existsSync(secondFilePath)
        && fs.readFileSync(secondFilePath, "utf8").includes("second-day-99"),
    )
    expect(fs.readFileSync(secondFilePath, "utf8")).toContain("second-day-99")
  } finally {
    shutdownLoggerRuntime()
    trackedStreams.restore()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

test("logger startup removes expired files", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir
  const filePath = path.join(logDir, "retention-handler-2026-01-01.log")
  const firstDate = localDate(2026, 1, 1)
  fs.writeFileSync(filePath, "expired\n", "utf8")
  fs.utimesSync(filePath, firstDate, firstDate)

  try {
    setSystemTime(localDate(2026, 1, 10))
    const logger = createHandlerLogger("retention-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`current-${index}`)
    }
    const currentFilePath = path.join(
      logDir,
      "retention-handler-2026-01-10.log",
    )

    await waitFor(
      () =>
        !fs.existsSync(filePath)
        && fs.existsSync(currentFilePath)
        && fs.readFileSync(currentFilePath, "utf8").includes("current-99"),
    )
    expect(fs.existsSync(filePath)).toBe(false)
  } finally {
    shutdownLoggerRuntime()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

test("logger maintenance warns when an expired log cannot be removed", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir
  const filePath = path.join(logDir, "blocked-handler-2026-01-01.log")
  const firstDate = localDate(2026, 1, 1)
  fs.writeFileSync(filePath, "blocked\n", "utf8")
  fs.utimesSync(filePath, firstDate, firstDate)
  setSystemTime(localDate(2026, 1, 10))

  const originalRmSync = fs.rmSync
  const originalWarn = console.warn
  const warnings: Array<Array<unknown>> = []
  fs.rmSync = new Proxy(originalRmSync, {
    apply(target, thisArg, args) {
      if (args[0] === filePath) {
        throw new Error("forced remove failure")
      }
      Reflect.apply(target, thisArg, args)
    },
  })
  console.warn = (...args: Array<unknown>) => {
    warnings.push(args)
  }

  try {
    const logger = createHandlerLogger("blocked-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`current-${index}`)
    }
    const currentFilePath = path.join(logDir, "blocked-handler-2026-01-10.log")
    await waitFor(
      () =>
        warnings.some(([message]) =>
          String(message).includes("Failed to remove old handler log"),
        )
        && fs.existsSync(currentFilePath)
        && fs.readFileSync(currentFilePath, "utf8").includes("current-99"),
    )

    expect(fs.existsSync(filePath)).toBe(true)
    expect(
      warnings.some(([message]) =>
        String(message).includes("Failed to remove old handler log"),
      ),
    ).toBe(true)
  } finally {
    shutdownLoggerRuntime()
    fs.rmSync = originalRmSync
    console.warn = originalWarn
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})
