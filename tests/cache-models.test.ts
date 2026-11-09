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

  test("stores picker-enabled, embedding, and supported decisions models unless policy-disabled", async () => {
    await cacheModels()

    expect(state.models).not.toBeNull()
    expect(state.models?.data.length).toBeGreaterThan(0)
    expect(
      state.models?.data.every(
        (model) =>
          model.policy?.state !== "disabled"
          && (model.model_picker_enabled
            || model.capabilities.type === "embeddings"
            || (model.capabilities.type === "decisions"
              && (model.supported_endpoints?.includes("/v1/decisions")
                ?? false))),
      ),
    ).toBe(true)

    const expectedCount = (
      rawModelsResponse.data as Array<{
        capabilities?: { type?: string }
        model_picker_enabled?: boolean
        policy?: { state?: string }
        supported_endpoints?: Array<string>
      }>
    ).filter(
      (model) =>
        model.policy?.state !== "disabled"
        && (model.model_picker_enabled
          || model.capabilities?.type === "embeddings"
          || (model.capabilities?.type === "decisions"
            && (model.supported_endpoints?.includes("/v1/decisions")
              ?? false))),
    ).length

    expect(state.models?.data.length).toBe(expectedCount)
    expect(
      state.models?.data.some(
        (model) => model.capabilities.type === "embeddings",
      ),
    ).toBe(true)
  })

  test("admits hidden decisions model on /v1/decisions while rejecting hidden chat models and disabled decisions models", async () => {
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
    ])
  })
})
