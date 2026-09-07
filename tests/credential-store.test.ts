import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  GITHUB_TOKEN_ENV,
  readGitHubTokenFromEnv,
  writeCodexCredentials,
  writeGitHubToken,
} from "~/lib/credential-store"
import { PATHS } from "~/lib/paths"

const originalGitHubTokenPath = PATHS.GITHUB_TOKEN_PATH
const originalCodexCredentialPath = PATHS.CODEX_CREDENTIAL_PATH
const originalFsyncSync = fs.fsyncSync
const tempDirs: Array<string> = []

function useTempCredentialPaths(): {
  githubTokenPath: string
  codexCredentialPath: string
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-store-"))
  tempDirs.push(tempDir)
  const githubTokenPath = path.join(tempDir, "github_token")
  const codexCredentialPath = path.join(tempDir, "codex_credentials.json")
  PATHS.GITHUB_TOKEN_PATH = githubTokenPath
  PATHS.CODEX_CREDENTIAL_PATH = codexCredentialPath
  return { githubTokenPath, codexCredentialPath }
}

function listTemporaryFiles(filePath: string): Array<string> {
  const basenamePrefix = `.${path.basename(filePath)}.`
  return fs
    .readdirSync(path.dirname(filePath))
    .filter(
      (entry) => entry.startsWith(basenamePrefix) && entry.endsWith(".tmp"),
    )
}

async function getRejectedError(operation: Promise<void>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) {
      return error
    }
    throw error
  }

  throw new Error("Expected credential write to fail")
}

afterEach(() => {
  fs.fsyncSync = originalFsyncSync
  PATHS.GITHUB_TOKEN_PATH = originalGitHubTokenPath
  PATHS.CODEX_CREDENTIAL_PATH = originalCodexCredentialPath

  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("credential store atomic writes", () => {
  test("writes GitHub and Codex credentials with protected permissions", async () => {
    const { githubTokenPath, codexCredentialPath } = useTempCredentialPaths()
    const credentials = {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 123,
      accountId: "account-id",
    }

    await writeGitHubToken(" github-token ")
    await writeCodexCredentials(credentials)

    expect(fs.readFileSync(githubTokenPath, "utf8")).toBe("github-token")
    expect(JSON.parse(fs.readFileSync(codexCredentialPath, "utf8"))).toEqual(
      credentials,
    )
    expect(listTemporaryFiles(githubTokenPath)).toEqual([])
    expect(listTemporaryFiles(codexCredentialPath)).toEqual([])

    if (process.platform !== "win32") {
      expect(fs.statSync(githubTokenPath).mode & 0o777).toBe(0o600)
      expect(fs.statSync(codexCredentialPath).mode & 0o777).toBe(0o600)
    }
  })

  test("preserves Codex credentials when fsync fails", async () => {
    const { codexCredentialPath } = useTempCredentialPaths()
    fs.writeFileSync(codexCredentialPath, "old-credentials", "utf8")
    fs.fsyncSync = (() => {
      throw new Error("forced credential fsync failure")
    }) as typeof fs.fsyncSync

    const error = await getRejectedError(
      writeCodexCredentials({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresAt: 456,
        accountId: "new-account-id",
      }),
    )

    expect(error.message).toBe("forced credential fsync failure")
    expect(fs.readFileSync(codexCredentialPath, "utf8")).toBe("old-credentials")
    expect(listTemporaryFiles(codexCredentialPath)).toEqual([])
  })
})

describe("GitHub token from the environment", () => {
  const originalEnvToken = process.env[GITHUB_TOKEN_ENV]

  afterEach(() => {
    if (originalEnvToken === undefined) {
      delete process.env[GITHUB_TOKEN_ENV]
    } else {
      process.env[GITHUB_TOKEN_ENV] = originalEnvToken
    }
  })

  test("returns the trimmed token", () => {
    process.env[GITHUB_TOKEN_ENV] = "  env-token  "

    expect(readGitHubTokenFromEnv()).toBe("env-token")
  })

  test("ignores a blank value", () => {
    process.env[GITHUB_TOKEN_ENV] = "   "

    expect(readGitHubTokenFromEnv()).toBeUndefined()
  })

  test("returns undefined when the variable is unset", () => {
    delete process.env[GITHUB_TOKEN_ENV]

    expect(readGitHubTokenFromEnv()).toBeUndefined()
  })
})
