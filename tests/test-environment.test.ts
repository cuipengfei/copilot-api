import { expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))

test.each([
  [
    "direct Bun test",
    [
      "test",
      "--isolate",
      "tests/decisions.test.ts",
      "tests/telemetry-identity.test.ts",
    ],
    1,
  ],
  [
    "package test script",
    [
      "run",
      "test",
      "tests/decisions.test.ts",
      "tests/telemetry-identity.test.ts",
    ],
    0,
  ],
  [
    "isolated Bun test",
    [
      "run",
      "test:isolated-env",
      "test",
      "--isolate",
      "tests/decisions.test.ts",
      "tests/telemetry-identity.test.ts",
    ],
    0,
  ],
])(
  "%s leaves inherited application data and device IDs untouched",
  (_name, args, expectedExitCode) => {
    const applicationHome = mkdtempSync(
      path.join(tmpdir(), "copilot-api-sentinel-"),
    )
    const database = path.join(applicationHome, "copilot-api.sqlite")
    const config = path.join(applicationHome, "config.json")
    const originalDatabase = "preserve existing database bytes"
    const originalConfig = "preserve existing config bytes"
    const systemHome = path.join(applicationHome, "home")
    const cacheHome = path.join(applicationHome, "cache")
    const deviceIds = [
      path.join(
        systemHome,
        ".cache",
        "Microsoft",
        "DeveloperTools",
        "deviceid",
      ),
      path.join(cacheHome, "Microsoft", "DeveloperTools", "deviceid"),
    ]
    const originalDeviceId = "preserve existing device ID"
    for (const deviceId of deviceIds) {
      mkdirSync(path.dirname(deviceId), { recursive: true })
      writeFileSync(deviceId, originalDeviceId)
    }
    writeFileSync(database, originalDatabase)
    writeFileSync(config, originalConfig)
    try {
      const result = Bun.spawnSync({
        cmd: [process.execPath, ...args],
        cwd,
        env: {
          ...process.env,
          HOME: systemHome,
          XDG_CACHE_HOME: cacheHome,
          COPILOT_API_TEST_HOME: undefined,
          COPILOT_API_HOME: applicationHome,
          COPILOT_API_LOG_DIR: path.join(applicationHome, "logs"),
          COPILOT_API_SQLITE_DB_PATH: database,
        },
        timeout: 20_000,
      })
      const stderr = new TextDecoder().decode(result.stderr)
      expect(result.exitCode, stderr).toBe(expectedExitCode)
      if (expectedExitCode !== 0) {
        expect(stderr).toContain("Use bun run test [files].")
      }
      expect(readFileSync(database, "utf8")).toBe(originalDatabase)
      expect(readFileSync(config, "utf8")).toBe(originalConfig)
      for (const deviceId of deviceIds) {
        expect(readFileSync(deviceId, "utf8")).toBe(originalDeviceId)
      }
      expect(readdirSync(applicationHome).sort()).toEqual([
        "cache",
        "config.json",
        "copilot-api.sqlite",
        "home",
      ])
    } finally {
      rmSync(applicationHome, { recursive: true, force: true })
    }
  },
)
