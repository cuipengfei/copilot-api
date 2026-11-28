import { COPILOT_VERSION } from "~/lib/providers/api-config"

/**
 * Build common telemetry properties shared across all events.
 */
export function getCommonProperties({
  vsCodeVersion,
  sku,
  copilotTrackingId,
  vsCodeSessionId,
}: {
  vsCodeVersion?: string
  sku?: string
  copilotTrackingId?: string
  vsCodeSessionId?: string
}): Record<string, string> {
  return {
    common_extname: "copilot-chat",
    common_extversion: COPILOT_VERSION,
    common_vscodeversion: vsCodeVersion ?? "",
    common_vscodesessionid: vsCodeSessionId ?? "",
    editor_version: `vscode/${vsCodeVersion ?? ""}`,
    editor_plugin_version: `copilot-chat/${COPILOT_VERSION}`,
    sku: sku ?? "",
    copilot_trackingId: copilotTrackingId ?? "",
  }
}
