import { describe, expect, it } from "bun:test"

import { COPILOT_VERSION } from "~/lib/providers/api-config"
import { getCommonProperties } from "../src/services/telemetry/identity"

describe("telemetry identity", () => {
  it("returns account and editor session common properties", () => {
    expect(
      getCommonProperties({
        vsCodeVersion: "1.144.0",
        vsCodeSessionId: "editor-session",
        sku: "pro",
        copilotTrackingId: "tid-1",
      }),
    ).toEqual({
      common_extname: "copilot-chat",
      common_extversion: COPILOT_VERSION,
      common_vscodeversion: "1.144.0",
      common_vscodesessionid: "editor-session",
      editor_version: "vscode/1.144.0",
      editor_plugin_version: `copilot-chat/${COPILOT_VERSION}`,
      sku: "pro",
      copilot_trackingId: "tid-1",
    })
  })

  it("defaults omitted version and sku values to empty strings", () => {
    expect(getCommonProperties({})).toEqual({
      common_extname: "copilot-chat",
      common_extversion: COPILOT_VERSION,
      common_vscodeversion: "",
      common_vscodesessionid: "",
      editor_version: "vscode/",
      editor_plugin_version: `copilot-chat/${COPILOT_VERSION}`,
      sku: "",
      copilot_trackingId: "",
    })
  })
})
