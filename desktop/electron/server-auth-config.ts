import fs from 'node:fs/promises'

import {
  readEditableConfigFromDisk,
  writeConfigToDisk,
} from '../../src/lib/config'
import { PATHS } from '../../src/lib/paths'
import { normalizeApiKeys } from '../../src/lib/request-auth'
import type { ServerKeysConfig, ServerKeysConfigUpdate } from '../src/types/ipc'

export function normalizeAdminApiKey(adminApiKey: unknown): string {
  if (typeof adminApiKey !== 'string') return ''
  return adminApiKey.trim()
}

export async function readServerKeysConfig(): Promise<ServerKeysConfig> {
  try {
    const raw = await fs.readFile(PATHS.CONFIG_PATH, 'utf8')
    const parsed =
      raw.trim() ?
        (JSON.parse(raw) as {
          auth?: { apiKeys?: unknown; adminApiKey?: unknown }
        })
      : {}
    return {
      apiKeys: normalizeApiKeys(parsed.auth?.apiKeys),
      adminApiKey: normalizeAdminApiKey(parsed.auth?.adminApiKey),
    }
  } catch {
    return { apiKeys: [], adminApiKey: '' }
  }
}

// Merges only the provided auth fields into the latest config on disk, so a
// save does not clobber external updates (CLI auth keys, or a server startup
// regenerating a cleared admin key).
export function writeServerKeysConfig(
  keys: ServerKeysConfigUpdate,
): ServerKeysConfig {
  const editableConfig = readEditableConfigFromDisk()
  const auth = { ...editableConfig.auth }

  if (keys.apiKeys !== undefined) {
    auth.apiKeys = normalizeApiKeys(keys.apiKeys)
  }
  if (keys.adminApiKey !== undefined) {
    const adminApiKey = normalizeAdminApiKey(keys.adminApiKey)
    if (adminApiKey) {
      auth.adminApiKey = adminApiKey
    } else {
      delete auth.adminApiKey
    }
  }

  writeConfigToDisk({ ...editableConfig, auth })
  return {
    apiKeys: normalizeApiKeys(auth.apiKeys),
    adminApiKey: normalizeAdminApiKey(auth.adminApiKey),
  }
}
