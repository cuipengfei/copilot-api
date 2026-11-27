import { COPILOT_VERSION } from "~/lib/providers/api-config"

/**
 * Build common telemetry properties shared across all events.
 */
export function getCommonProperties({
  vsCodeVersion,
  sku,
}: {
  vsCodeVersion?: string
  sku?: string
}): Record<string, string> {
  return {
    common_extname: "copilot-chat",
    common_extversion: COPILOT_VERSION,
    common_vscodeversion: vsCodeVersion ?? "",
    editor_version: `vscode/${vsCodeVersion ?? ""}`,
    editor_plugin_version: `copilot-chat/${COPILOT_VERSION}`,
    sku: sku ?? "",
  }
}
