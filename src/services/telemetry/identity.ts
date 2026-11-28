import { COPILOT_VERSION } from "~/lib/providers/api-config"

/**
 * Build common telemetry properties shared across all events.
 */
export function getCommonProperties({
  vsCodeVersion,
  sku,
  copilotTrackingId,
  vsCodeSessionId,
  macMachineId,
  vsCodeDeviceId,
}: {
  vsCodeVersion?: string
  sku?: string
  copilotTrackingId?: string
  vsCodeSessionId?: string
  macMachineId?: string
  vsCodeDeviceId?: string
}): Record<string, string> {
  return {
    common_extname: "copilot-chat",
    common_extversion: COPILOT_VERSION,
    common_vscodeversion: vsCodeVersion ?? "",
    common_vscodesessionid: vsCodeSessionId ?? "",
    common_vscodemachineid: macMachineId ?? "",
    client_machineid: macMachineId ?? "",
    client_deviceid: vsCodeDeviceId ?? "",
    client_sessionid: vsCodeSessionId ?? "",
    common_uikind: "desktop",
    common_remotename: "none",
    common_isnewappinstall: "",
    editor_version: `vscode/${vsCodeVersion ?? ""}`,
    editor_plugin_version: `copilot-chat/${COPILOT_VERSION}`,
    sku: sku ?? "",
    copilot_trackingId: copilotTrackingId ?? "",
  }
}
