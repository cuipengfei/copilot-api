import { describe, expect, it } from "bun:test"

import { COPILOT_VERSION } from "~/lib/providers/api-config"
import { getCommonProperties } from "../src/services/telemetry/identity"

describe("telemetry identity", () => {
  it("returns account and editor session common properties", () => {
    expect(
      getCommonProperties({
        vsCodeVersion: "1.144.0",
        vsCodeSessionId: "editor-session",
        macMachineId: "machine-hash",
        vsCodeDeviceId: "device-uuid",
        sku: "pro",
        copilotTrackingId: "tid-1",
      }),
    ).toEqual({
      common_extname: "copilot-chat",
      common_extversion: COPILOT_VERSION,
      common_vscodeversion: "1.144.0",
      common_vscodesessionid: "editor-session",
      common_vscodemachineid: "machine-hash",
      client_machineid: "machine-hash",
      client_deviceid: "device-uuid",
      client_sessionid: "editor-session",
      common_uikind: "desktop",
      common_remotename: "none",
      common_isnewappinstall: "",
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
      common_vscodemachineid: "",
      client_machineid: "",
      client_deviceid: "",
      client_sessionid: "",
      common_uikind: "desktop",
      common_remotename: "none",
      common_isnewappinstall: "",
      editor_version: "vscode/",
      editor_plugin_version: `copilot-chat/${COPILOT_VERSION}`,
      sku: "",
      copilot_trackingId: "",
    })
  })
})
