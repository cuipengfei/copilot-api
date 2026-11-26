import consola from "consola"
import { randomBytes, randomUUID } from "node:crypto"
import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { COPILOT_VERSION } from "~/lib/providers/api-config"
import { PATHS } from "~/lib/storage/paths"

// Stable session ID for the lifetime of this process
export const SESSION_ID: string = randomUUID()

const cachedIds = new Map<string, string>()

function readOrPersistId(
  fileName: string,
  generate: () => string,
  label: string,
): string {
  const filePath = join(PATHS.APP_DIR, fileName)
  const cached = cachedIds.get(filePath)
  if (cached !== undefined) return cached

  let id: string | undefined
  try {
    try {
      const existing = readFileSync(filePath, "utf8").trim()
      if (!existing) throw new Error(`Empty ${label} file`)
      id = existing
    } catch (error) {
      if (
        !(error instanceof Error)
        || !("code" in error)
        || error.code !== "ENOENT"
      ) {
        throw error
      }

      id = generate()
      mkdirSync(PATHS.APP_DIR, { recursive: true })
      const temporaryPath = `${filePath}.${id}.tmp`
      try {
        writeFileSync(temporaryPath, id, { flag: "wx", mode: 0o600 })
        // Publish completed contents without overwriting another process's ID.
        try {
          linkSync(temporaryPath, filePath)
        } catch (error) {
          if (
            !(error instanceof Error)
            || !("code" in error)
            || error.code !== "EEXIST"
          ) {
            throw error
          }
          const existing = readFileSync(filePath, "utf8").trim()
          if (!existing)
            throw new Error(`Empty ${label} file`, { cause: error })
          id = existing
        }
      } finally {
        rmSync(temporaryPath, { force: true })
      }
    }
  } catch (error) {
    consola.warn(
      `Failed to persist ${label}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  id ??= generate()
  cachedIds.set(filePath, id)
  return id
}

/**
 * Get persistent 64-char hex machine ID isolated from host network MAC addresses.
 * Path: $COPILOT_API_HOME/telemetry-machine-id
 */
export function getMachineId(): string {
  return readOrPersistId(
    "telemetry-machine-id",
    () => randomBytes(32).toString("hex"),
    "machine ID",
  )
}

/**
 * Get persistent device UUID isolated from host ~/.cache/Microsoft/DeveloperTools/deviceid.
 * Path: $COPILOT_API_HOME/telemetry-device-id
 */
export function getDevDeviceId(): string {
  return readOrPersistId("telemetry-device-id", () => randomUUID(), "device ID")
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
    common_extname: "copilot-chat",
    common_extversion: COPILOT_VERSION,
    common_vscodeversion: vsCodeVersion,
    common_uikind: "desktop",
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
