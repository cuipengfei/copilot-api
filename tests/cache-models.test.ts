import { beforeEach, describe, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "../src/lib/types/models"

import { state } from "../src/lib/state"
import rawModelsResponse from "./fixtures/copilot-models-raw-response.json"

await mock.module("../src/services/copilot/get-models", () => ({
  getModels: () => Promise.resolve(rawModelsResponse as ModelsResponse),
}))

const { cacheModels } = await import("../src/services/copilot/models-cache")

describe("cacheModels", () => {
  beforeEach(() => {
    state.models = undefined
  })

  test("admits all decisions models regardless of policy or endpoints while excluding hidden chat models", async () => {
    const baseModel = rawModelsResponse
      .data[0] as ModelsResponse["data"][number]
    await cacheModels(() =>
      Promise.resolve({
        object: "list",
        data: [
          {
            ...baseModel,
            id: "gpt-6-luna-decisions",
            name: "GPT-6 Luna Decisions",
            model_picker_enabled: false,
            policy: undefined,
            supported_endpoints: ["/v1/decisions"],
            capabilities: {
              ...baseModel.capabilities,
              family: "gpt-6-luna",
              type: "decisions",
            },
          },
          {
            ...baseModel,
            id: "gpt-6-luna-decisions-disabled",
            name: "Disabled Decisions",
            model_picker_enabled: false,
            policy: { state: "disabled", terms: "disabled" },
            supported_endpoints: ["/v1/decisions"],
            capabilities: {
              ...baseModel.capabilities,
              family: "gpt-6-luna",
              type: "decisions",
            },
          },
          {
            ...baseModel,
            id: "gpt-6-luna-decisions-no-endpoint",
            name: "No Endpoint Decisions",
            model_picker_enabled: false,
            policy: undefined,
            supported_endpoints: [],
            capabilities: {
              ...baseModel.capabilities,
              family: "gpt-6-luna",
              type: "decisions",
            },
          },
          {
            ...baseModel,
            id: "decisions-alternative-endpoint",
            model_picker_enabled: false,
            policy: undefined,
            supported_endpoints: ["/decisions"],
            capabilities: { ...baseModel.capabilities, type: "decisions" },
          },
          {
            ...baseModel,
            id: "decisions-missing-endpoints",
            model_picker_enabled: false,
            policy: undefined,
            supported_endpoints: undefined,
            capabilities: { ...baseModel.capabilities, type: "decisions" },
          },
          {
            ...baseModel,
            id: "gpt-4o-hidden-legacy",
            name: "Hidden Legacy Chat",
            model_picker_enabled: false,
            policy: undefined,
            supported_endpoints: [],
            capabilities: {
              ...baseModel.capabilities,
              type: "chat",
            },
          },
        ],
      }),
    )

    expect(state.models?.data.map((m) => m.id)).toEqual([
      "gpt-6-luna-decisions",
      "gpt-6-luna-decisions-disabled",
      "gpt-6-luna-decisions-no-endpoint",
      "decisions-alternative-endpoint",
      "decisions-missing-endpoints",
    ])
  })
})
