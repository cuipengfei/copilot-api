import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import consola from "consola"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PATHS } from "~/lib/storage/paths"

import {
  getMachineId,
  SESSION_ID,
  getCommonProperties,
  getDevDeviceId,
} from "../src/services/telemetry/identity"

describe("telemetry identity", () => {
  const originalAppDir = PATHS.APP_DIR
  let appDir: string
  beforeEach(() => {
    appDir = mkdtempSync(join(tmpdir(), "telemetry-identity-"))
    PATHS.APP_DIR = appDir
  })
  afterEach(() => {
    PATHS.APP_DIR = originalAppDir
    rmSync(appDir, { recursive: true, force: true })
  })

  it("getMachineId returns a random 64-char hex identity", () => {
    const machineId = getMachineId()
    expect(machineId).toHaveLength(64)
    expect(Buffer.from(machineId, "hex").toString("hex")).toBe(machineId)
  })

  it("getMachineId persists and retrieves same ID in copilot-api app dir", () => {
    const machineId1 = getMachineId()
    const machineId2 = getMachineId()

    expect(machineId1).toBe(machineId2)
    expect(existsSync(join(appDir, "telemetry-machine-id"))).toBe(true)
    expect(
      readFileSync(join(appDir, "telemetry-machine-id"), "utf8").trim(),
    ).toBe(machineId1)
  })

  it("SESSION_ID is valid UUID format", () => {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    expect(SESSION_ID).toMatch(uuidRegex)
  })

  it("getCommonProperties returns expected keys and omits OS fingerprint fields", () => {
    const machineId = getMachineId()
    const props = getCommonProperties({
      machineId,
      sessionId: SESSION_ID,
      vsCodeVersion: "1.144.0",
    })

    const expectedKeys = [
      "common_vscodemachineid",
      "common_vscodesessionid",
      "client_machineid",
      "client_sessionid",
      "client_deviceid",
      "common_extname",
      "common_extversion",
      "common_vscodeversion",
      "common_uikind",
      "editor_version",
      "editor_plugin_version",
      "copilot_version",
      "unique_id",
    ]

    for (const key of expectedKeys) {
      expect(key in props).toBe(true)
      expect(props[key]).toBeString()
      expect(props[key].length).toBeGreaterThan(0)
    }

    expect("common_os" in props).toBe(false)
    expect("common_platformversion" in props).toBe(false)
    expect("common_arch" in props).toBe(false)
    expect("common_editorsession_id" in props).toBe(false)
  })

  it("getDevDeviceId returns UUID format", () => {
    const deviceId = getDevDeviceId()
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    expect(deviceId).toMatch(uuidRegex)
  })

  it("getDevDeviceId persists in the isolated app directory", () => {
    const deviceId1 = getDevDeviceId()
    const deviceId2 = getDevDeviceId()

    expect(deviceId1).toBe(deviceId2)
    expect(existsSync(join(appDir, "telemetry-device-id"))).toBe(true)
    expect(
      readFileSync(join(appDir, "telemetry-device-id"), "utf8").trim(),
    ).toBe(deviceId1)
  })

  it("keeps the same in-memory identity when its file is removed", () => {
    const machineId = getMachineId()
    const deviceId = getDevDeviceId()
    rmSync(join(appDir, "telemetry-machine-id"))
    rmSync(join(appDir, "telemetry-device-id"))
    expect(getMachineId()).toBe(machineId)
    expect(getDevDeviceId()).toBe(deviceId)
  })

  for (const getId of [getMachineId, getDevDeviceId]) {
    it(`${getId.name} warns once and stays stable when persistence fails`, () => {
      const blockedPath = join(appDir, "blocked")
      writeFileSync(blockedPath, "not a directory")
      PATHS.APP_DIR = blockedPath
      const warning = spyOn(consola, "warn").mockReturnValue(undefined)
      try {
        const first = getId()
        expect(getId()).toBe(first)
        expect(getId()).toBe(first)
        expect(warning).toHaveBeenCalledTimes(1)
        expect(readFileSync(blockedPath, "utf8")).toBe("not a directory")
      } finally {
        warning.mockRestore()
      }
    })
  }

  it("shares complete persistent identities across simultaneous processes", async () => {
    const workerPath = new URL(
      "./fixtures/telemetry-identity-worker.ts",
      import.meta.url,
    ).pathname
    const workers = Array.from({ length: 4 }, () =>
      Bun.spawn({
        cmd: [process.execPath, workerPath],
        env: { ...process.env, COPILOT_API_HOME: appDir },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const readers = workers.map((worker) => worker.stdout.getReader())
    try {
      await Promise.all(
        readers.map(async (reader) => {
          const ready = await reader.read()
          expect(new TextDecoder().decode(ready.value).trim()).toBe("ready")
        }),
      )
      await Promise.all(
        workers.map(async (worker) => {
          await worker.stdin.write("go")
          await worker.stdin.end()
        }),
      )
      const identities = await Promise.all(
        workers.map(async (worker, index) => {
          const reader = readers[index]
          const decoder = new TextDecoder()
          let output = ""
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            output += decoder.decode(chunk.value, { stream: true })
          }
          output += decoder.decode()
          const errors = await new Response(worker.stderr).text()
          const exitCode = await worker.exited
          if (exitCode !== 0)
            throw new Error(`Identity worker failed: ${errors}`)
          return JSON.parse(output) as { machineId: string; deviceId: string }
        }),
      )
      const first = identities[0]
      if (!first) throw new Error("No worker identity returned")
      expect(first.machineId).toHaveLength(64)
      expect(first.deviceId).toHaveLength(36)
      for (const identity of identities) expect(identity).toEqual(first)
      expect(getMachineId()).toBe(first.machineId)
      expect(getDevDeviceId()).toBe(first.deviceId)
      expect(readdirSync(appDir).sort()).toEqual([
        "telemetry-device-id",
        "telemetry-machine-id",
      ])
      expect(statSync(join(appDir, "telemetry-machine-id")).mode & 0o777).toBe(
        0o600,
      )
      expect(statSync(join(appDir, "telemetry-device-id")).mode & 0o777).toBe(
        0o600,
      )
    } finally {
      for (const worker of workers) if (worker.exitCode === null) worker.kill()
      await Promise.all(workers.map((worker) => worker.exited))
      for (const reader of readers) reader.releaseLock()
    }
  })
})
