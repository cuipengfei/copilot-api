import fs from "node:fs/promises"

import type { CodexCredentials } from "~/lib/oauth/codex"

import { writeFileAtomically } from "./atomic-file"
import { PATHS } from "./paths"

export const MAX_CODEX_ACCOUNTS = 3

export interface CodexStoredAccount extends CodexCredentials {
  alias?: string
}

export interface CodexCredentialStoreV1 {
  version: 1
  accounts: Array<CodexStoredAccount>
}

export interface WriteCodexCredentialsOptions {
  alias?: string
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null
    }
    throw error
  }
}

function writeProtectedFile(filePath: string, content: string): Promise<void> {
  return Promise.resolve().then(() => writeFileAtomically(filePath, content))
}

function normalizeCodexCredentials(
  credentials: unknown,
): CodexCredentials | null {
  if (!credentials || typeof credentials !== "object") {
    return null
  }

  const candidate = credentials as Partial<CodexCredentials>
  if (
    typeof candidate.accessToken !== "string"
    || typeof candidate.refreshToken !== "string"
    || typeof candidate.expiresAt !== "number"
    || typeof candidate.accountId !== "string"
  ) {
    return null
  }

  return {
    accessToken: candidate.accessToken,
    refreshToken: candidate.refreshToken,
    expiresAt: candidate.expiresAt,
    accountId: candidate.accountId,
  }
}

function normalizeCodexStoredAccount(
  account: unknown,
): CodexStoredAccount | null {
  const credentials = normalizeCodexCredentials(account)
  if (!credentials) {
    return null
  }

  const aliasValue = (account as { alias?: unknown }).alias
  if (aliasValue !== undefined && typeof aliasValue !== "string") {
    return null
  }

  const alias = aliasValue?.trim()
  return {
    ...credentials,
    ...(alias ? { alias } : {}),
  }
}

function normalizeCodexCredentialStore(
  value: unknown,
): CodexCredentialStoreV1 | null {
  const legacyCredentials = normalizeCodexCredentials(value)
  if (legacyCredentials) {
    return {
      version: 1,
      accounts: [legacyCredentials],
    }
  }

  if (!value || typeof value !== "object") {
    return null
  }

  const candidate = value as {
    version?: unknown
    accounts?: unknown
  }
  if (candidate.version !== 1 || !Array.isArray(candidate.accounts)) {
    return null
  }

  if (candidate.accounts.length > MAX_CODEX_ACCOUNTS) {
    return null
  }

  const accounts: Array<CodexStoredAccount> = []
  const accountIds = new Set<string>()
  const aliases = new Set<string>()
  for (const value of candidate.accounts) {
    const account = normalizeCodexStoredAccount(value)
    if (!account || accountIds.has(account.accountId)) {
      return null
    }

    const normalizedAlias = account.alias?.toLowerCase()
    if (normalizedAlias && aliases.has(normalizedAlias)) {
      return null
    }

    accounts.push(account)
    accountIds.add(account.accountId)
    if (normalizedAlias) {
      aliases.add(normalizedAlias)
    }
  }

  return { version: 1, accounts }
}

async function writeCodexCredentialStore(
  store: CodexCredentialStoreV1,
): Promise<void> {
  await writeProtectedFile(
    PATHS.CODEX_CREDENTIAL_PATH,
    `${JSON.stringify(store, null, 2)}\n`,
  )
}

export async function readGitHubToken(): Promise<string | null> {
  const token = await readOptionalFile(PATHS.GITHUB_TOKEN_PATH)
  const normalizedToken = token?.trim()
  return normalizedToken || null
}

// Command line arguments are readable by every local user through the process
// list, so the environment is the preferred way to hand the server a token.
export const GITHUB_TOKEN_ENV = "COPILOT_API_GITHUB_TOKEN"

export function readGitHubTokenFromEnv(): string | undefined {
  return process.env[GITHUB_TOKEN_ENV]?.trim() || undefined
}

export async function writeGitHubToken(token: string): Promise<void> {
  await writeProtectedFile(PATHS.GITHUB_TOKEN_PATH, token.trim())
}

export async function readCodexCredentialStore(): Promise<CodexCredentialStoreV1 | null> {
  const raw = await readOptionalFile(PATHS.CODEX_CREDENTIAL_PATH)
  if (!raw?.trim()) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(
      `Codex credentials file is not valid JSON: ${PATHS.CODEX_CREDENTIAL_PATH}`,
      {
        cause: error,
      },
    )
  }

  const store = normalizeCodexCredentialStore(parsed)
  if (!store) {
    throw new Error(
      `Codex credentials file is missing required fields: ${PATHS.CODEX_CREDENTIAL_PATH}`,
    )
  }

  return store
}

export async function readCodexCredentials(
  accountId?: string,
): Promise<CodexCredentials | null> {
  const store = await readCodexCredentialStore()
  if (!store || store.accounts.length === 0) {
    return null
  }

  const normalizedAccountId = accountId?.trim()
  if (normalizedAccountId) {
    return (
      store.accounts.find(
        (account) => account.accountId === normalizedAccountId,
      ) ?? null
    )
  }

  if (store.accounts.length > 1) {
    throw new Error("Multiple Codex accounts found but no account is selected")
  }

  return store.accounts[0]
}

export async function writeCodexCredentials(
  credentials: CodexCredentials,
  options: WriteCodexCredentialsOptions = {},
): Promise<void> {
  const normalizedCredentials = normalizeCodexCredentials(credentials)
  if (!normalizedCredentials) {
    throw new Error("Codex credentials are missing required fields")
  }

  const store = (await readCodexCredentialStore()) ?? {
    version: 1 as const,
    accounts: [],
  }
  const existingIndex = store.accounts.findIndex(
    (account) => account.accountId === normalizedCredentials.accountId,
  )
  if (existingIndex < 0 && store.accounts.length >= MAX_CODEX_ACCOUNTS) {
    throw new Error(`Codex supports at most ${MAX_CODEX_ACCOUNTS} accounts`)
  }

  const alias = options.alias?.trim()
  if (
    alias
    && store.accounts.some(
      (account, index) =>
        index !== existingIndex
        && account.alias?.toLowerCase() === alias.toLowerCase(),
    )
  ) {
    throw new Error(`Codex account alias '${alias}' is already in use`)
  }

  const existingAccount =
    existingIndex >= 0 ? store.accounts[existingIndex] : undefined
  const nextAccount: CodexStoredAccount = {
    ...normalizedCredentials,
    ...(alias ? { alias }
    : existingAccount?.alias ? { alias: existingAccount.alias }
    : {}),
  }
  const accounts = [...store.accounts]
  if (existingIndex >= 0) {
    accounts[existingIndex] = nextAccount
  } else {
    accounts.push(nextAccount)
  }

  await writeCodexCredentialStore({ version: 1, accounts })
}

export async function clearCodexCredentials(): Promise<void> {
  await writeProtectedFile(PATHS.CODEX_CREDENTIAL_PATH, "")
}

export async function hasCodexCredentials(): Promise<boolean> {
  return ((await readCodexCredentialStore())?.accounts.length ?? 0) > 0
}
