import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  GITHUB_TOKEN_ENV,
  MAX_CODEX_ACCOUNTS,
  readCodexCredentialStore,
  readCodexCredentials,
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
    expect(JSON.parse(fs.readFileSync(codexCredentialPath, "utf8"))).toEqual({
      version: 1,
      accounts: [credentials],
    })
    expect(listTemporaryFiles(githubTokenPath)).toEqual([])
    expect(listTemporaryFiles(codexCredentialPath)).toEqual([])

    if (process.platform !== "win32") {
      expect(fs.statSync(githubTokenPath).mode & 0o777).toBe(0o600)
      expect(fs.statSync(codexCredentialPath).mode & 0o777).toBe(0o600)
    }
  })

  test("preserves Codex credentials when fsync fails", async () => {
    const { codexCredentialPath } = useTempCredentialPaths()
    const oldCredentials = {
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: 123,
      accountId: "old-account-id",
    }
    const oldContent = `${JSON.stringify(oldCredentials, null, 2)}\n`
    fs.writeFileSync(codexCredentialPath, oldContent, "utf8")
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
    expect(fs.readFileSync(codexCredentialPath, "utf8")).toBe(oldContent)
    expect(listTemporaryFiles(codexCredentialPath)).toEqual([])
  })
})

describe("Codex account store", () => {
  test("reads the legacy single-account credential shape", () => {
    const { codexCredentialPath } = useTempCredentialPaths()
    const credentials = {
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh-token",
      expiresAt: 123,
      accountId: "legacy-account-id",
    }
    fs.writeFileSync(
      codexCredentialPath,
      `${JSON.stringify(credentials, null, 2)}\n`,
      "utf8",
    )

    expect(readCodexCredentialStore()).resolves.toEqual({
      version: 1,
      accounts: [credentials],
    })
    expect(readCodexCredentials()).resolves.toEqual(credentials)
  })

  test("stores at most three accounts and allows an existing account update", async () => {
    useTempCredentialPaths()

    for (let index = 1; index <= MAX_CODEX_ACCOUNTS; index += 1) {
      await writeCodexCredentials(
        {
          accessToken: `access-${index}`,
          refreshToken: `refresh-${index}`,
          expiresAt: index,
          accountId: `account-${index}`,
        },
        { alias: `Account ${index}` },
      )
    }

    await writeCodexCredentials({
      accessToken: "updated-access",
      refreshToken: "updated-refresh",
      expiresAt: 99,
      accountId: "account-2",
    })

    const store = await readCodexCredentialStore()
    expect(store?.accounts).toHaveLength(MAX_CODEX_ACCOUNTS)
    expect(store?.accounts[1]).toEqual({
      accessToken: "updated-access",
      refreshToken: "updated-refresh",
      expiresAt: 99,
      accountId: "account-2",
      alias: "Account 2",
    })

    expect(
      writeCodexCredentials({
        accessToken: "overflow-access",
        refreshToken: "overflow-refresh",
        expiresAt: 100,
        accountId: "account-4",
      }),
    ).rejects.toThrow(`Codex supports at most ${MAX_CODEX_ACCOUNTS} accounts`)
    expect((await readCodexCredentialStore())?.accounts).toHaveLength(
      MAX_CODEX_ACCOUNTS,
    )
  })

  test("rejects duplicate aliases without changing stored accounts", async () => {
    useTempCredentialPaths()
    await writeCodexCredentials(
      {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: 1,
        accountId: "account-1",
      },
      { alias: "Work" },
    )

    expect(
      writeCodexCredentials(
        {
          accessToken: "access-2",
          refreshToken: "refresh-2",
          expiresAt: 2,
          accountId: "account-2",
        },
        { alias: "work" },
      ),
    ).rejects.toThrow("Codex account alias 'work' is already in use")
    expect((await readCodexCredentialStore())?.accounts).toHaveLength(1)
  })

  test("requires an account id when multiple accounts are stored", async () => {
    useTempCredentialPaths()
    await writeCodexCredentials({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1,
      accountId: "account-1",
    })
    await writeCodexCredentials({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: 2,
      accountId: "account-2",
    })

    expect(readCodexCredentials()).rejects.toThrow(
      "Multiple Codex accounts found but no account is selected",
    )
    expect(readCodexCredentials("account-2")).resolves.toMatchObject({
      accessToken: "access-2",
      accountId: "account-2",
    })
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
