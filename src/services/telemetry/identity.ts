import consola from "consola"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, networkInterfaces, platform, arch, release } from "node:os"
import { join } from "node:path"

import { COPILOT_VERSION } from "~/lib/providers/api-config"

// Stable session ID for the lifetime of this process
export const SESSION_ID: string = randomUUID()

/**
 * Get machine ID by hashing the first non-internal MAC address (SHA-256 hex).
 * Algorithm from VS Code src/vs/base/node/id.ts
 */
export function getMachineId(): string {
  const interfaces = networkInterfaces()

  // Find first non-loopback, non-internal MAC address
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue

    for (const addr of iface) {
      // Skip internal interfaces or all-zero MACs
      if (addr.internal || addr.mac === "00:00:00:00:00:00") {
        continue
      }

      // SHA-256 hash of the MAC address
      return createHash("sha256").update(addr.mac).digest("hex")
    }
  }

  // Fallback: hash empty string when no valid MAC found
  return createHash("sha256").update("").digest("hex")
}

/**
 * Get persistent device UUID, mimicking @vscode/deviceid behavior.
 * Path: ~/.cache/Microsoft/DeveloperTools/deviceid
 */
export function getDevDeviceId(): string {
  const deviceIdPath = join(
    homedir(),
    ".cache",
    "Microsoft",
    "DeveloperTools",
    "deviceid",
  )

  // Try reading existing deviceid
  if (existsSync(deviceIdPath)) {
    try {
      const id = readFileSync(deviceIdPath, "utf8").trim()
      if (id) {
        return id
      }
    } catch {
      // Read failed, generate a new one
    }
  }

  // Generate new UUID
  const newId = randomUUID()

  // Persist to disk, warn on failure (non-fatal)
  try {
    const dir = join(homedir(), ".cache", "Microsoft", "DeveloperTools")
    mkdirSync(dir, { recursive: true })
    writeFileSync(deviceIdPath, newId)
  } catch (error) {
    consola.warn(
      `Failed to persist device ID: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return newId
}

/**
 * Build common telemetry properties shared across all events.
 */
export function getCommonProperties(opts: {
  machineId: string
  sessionId: string
  vsCodeVersion?: string
  sku?: string
  organizationList?: Array<string>
  enterpriseList?: Array<number>
}): Record<string, string> {
  const {
    machineId,
    sessionId,
    vsCodeVersion = "",
    sku,
    organizationList,
    enterpriseList,
  } = opts
  const props: Record<string, string> = {
    common_vscodemachineid: machineId,
    common_vscodesessionid: sessionId,
    client_machineid: machineId,
    client_sessionid: sessionId,
    client_deviceid: getDevDeviceId(),
    common_os: platform(),
    common_platformversion: release(),
    common_arch: arch(),
    common_extname: "copilot-chat",
    common_extversion: COPILOT_VERSION,
    common_vscodeversion: vsCodeVersion,
    common_uikind: "desktop",
    common_editorsession_id: sessionId,
    editor_version: `vscode/${vsCodeVersion}`,
    editor_plugin_version: `copilot-chat/${COPILOT_VERSION}`,
    copilot_version: `copilot/${COPILOT_VERSION}`,
    unique_id: randomUUID(),
  }

  if (sku) {
    props.sku = sku
  }
  if (organizationList && organizationList.length > 0) {
    props.organizations_list = organizationList.join(",")
  }
  if (enterpriseList && enterpriseList.length > 0) {
    props.enterprise_list = enterpriseList.join(",")
  }

  return props
}
