import { describe, expect, it } from "bun:test"

import { COPILOT_VERSION } from "~/lib/providers/api-config"
import { getCommonProperties } from "../src/services/telemetry/identity"

describe("telemetry identity", () => {
  it("returns exactly the six non-identifying common properties", () => {
    expect(
      getCommonProperties({ vsCodeVersion: "1.144.0", sku: "pro" }),
    ).toEqual({
      common_extname: "copilot-chat",
      common_extversion: COPILOT_VERSION,
      common_vscodeversion: "1.144.0",
      editor_version: "vscode/1.144.0",
      editor_plugin_version: `copilot-chat/${COPILOT_VERSION}`,
      sku: "pro",
    })
  })

  it("defaults omitted version and sku values to empty strings", () => {
    expect(getCommonProperties({})).toEqual({
      common_extname: "copilot-chat",
      common_extversion: COPILOT_VERSION,
      common_vscodeversion: "",
      editor_version: "vscode/",
      editor_plugin_version: `copilot-chat/${COPILOT_VERSION}`,
      sku: "",
    })
  })
})
