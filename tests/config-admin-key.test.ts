import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface ConfigFileShape {
  auth?: {
    apiKeys?: Array<string>
    adminApiKey?: string
  }
  modelMappings?: Record<string, string>
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

function createTempConfigDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-admin-key-"),
  )
  tempDirs.push(tempDir)
  return tempDir
}

function writeConfigFile(tempDir: string, config: ConfigFileShape): string {
  const configPath = path.join(tempDir, "config.json")
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return configPath
}

function readConfigFile(configPath: string): ConfigFileShape {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as ConfigFileShape
}

function runConfigScript(tempDir: string, script: string): void {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd,
    env: {
      ...process.env,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })

  if (result.exitCode !== 0) {
    const stdout = decoder.decode(result.stdout)
    const stderr = decoder.decode(result.stderr)
    throw new Error(
      `Config script failed with exit code ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("config admin api key", () => {
  test("merges default model mappings without replacing user entries", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      auth: { adminApiKey: "existing-admin-key" },
      modelMappings: {
        "codex-auto-review": "gpt-5.6-luna",
        custom: "provider/model",
      },
    })

    runConfigScript(
      tempDir,
      `import assert from "node:assert/strict";
       const { mergeConfigWithDefaults, resolveMappedModel } = await import("./src/lib/config");
       mergeConfigWithDefaults();
       assert.equal(resolveMappedModel("codex-auto-review"), "gpt-5.6-luna");
       assert.equal(resolveMappedModel("gpt-reserve"), "codex/gpt-reserve");
       assert.equal(resolveMappedModel("custom"), "provider/model");`,
    )
    expect(readConfigFile(configPath).modelMappings).toEqual({
      "codex-auto-review": "gpt-5.6-luna",
      "gpt-reserve": "codex/gpt-reserve",
      custom: "provider/model",
    })
  })

  test("generates and persists an admin api key when missing", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      auth: {
        apiKeys: ["regular-key"],
      },
      modelMappings: {
        "claude-opus-4-7": "gpt-5-mini",
      },
    })

    runConfigScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    const config = readConfigFile(configPath)
    expect(config.auth?.apiKeys).toEqual(["regular-key"])
    expect(typeof config.auth?.adminApiKey).toBe("string")
    expect(config.auth?.adminApiKey?.length).toBeGreaterThan(0)
    expect(config.modelMappings).toEqual({
      "codex-auto-review": "codex/codex-auto-review",
      "gpt-reserve": "codex/gpt-reserve",
      "claude-opus-4-7": "gpt-5-mini",
    })
  })

  test("keeps an existing admin api key stable across startup merges", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      auth: {
        apiKeys: ["regular-key"],
        adminApiKey: "existing-admin-key",
      },
    })

    runConfigScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    const config = readConfigFile(configPath)
    expect(config.auth?.adminApiKey).toBe("existing-admin-key")
  })

  test("preserves the generated admin api key when model mappings are updated", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      auth: {
        apiKeys: ["regular-key"],
      },
    })

    runConfigScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )
    const generatedAdminApiKey = readConfigFile(configPath).auth?.adminApiKey

    runConfigScript(
      tempDir,
      'const { mergeConfigWithDefaults, setModelMappings } = await import("./src/lib/config"); mergeConfigWithDefaults(); setModelMappings({ "claude-opus-4-7": "dash/qwen-plus" });',
    )

    const config = readConfigFile(configPath)
    expect(config.auth?.adminApiKey).toBe(generatedAdminApiKey)
    expect(config.modelMappings).toEqual({
      "codex-auto-review": "codex/codex-auto-review",
      "gpt-reserve": "codex/gpt-reserve",
      "claude-opus-4-7": "dash/qwen-plus",
    })
  })

  test("regenerates an admin api key if model mappings are saved after the key is removed", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      auth: {
        apiKeys: ["regular-key"],
      },
    })

    runConfigScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    const generatedAdminApiKey = readConfigFile(configPath).auth?.adminApiKey

    writeConfigFile(tempDir, {
      auth: {
        apiKeys: ["regular-key"],
      },
    })

    runConfigScript(
      tempDir,
      'const { setModelMappings } = await import("./src/lib/config"); setModelMappings({ "claude-opus-4-7": "gpt-5-mini" });',
    )

    const config = readConfigFile(configPath)
    expect(config.auth?.adminApiKey).not.toBeUndefined()
    expect(config.auth?.adminApiKey?.length).toBeGreaterThan(0)
    expect(config.auth?.adminApiKey).not.toBe(generatedAdminApiKey)
    expect(config.modelMappings).toEqual({
      "codex-auto-review": "codex/codex-auto-review",
      "gpt-reserve": "codex/gpt-reserve",
      "claude-opus-4-7": "gpt-5-mini",
    })
  })
})
