import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import type { ModelsResponse } from "~/lib/types/models"
import bundledCodexCatalogJson from "~/routes/models/models.json"

import rawModelsResponse from "./fixtures/copilot-models-raw-response.json"

const actualConfigModule = await import("../src/lib/config")
const actualTokenModule = await import("../src/lib/token")

let enabledProviders: Array<string> = []
let providerConfigs: Record<string, ResolvedProviderConfig | null> = {}
let codexSetupError: Error | null = null

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  getRawProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  listEnabledProviders: () => enabledProviders,
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: () => {
    if (codexSetupError) return Promise.reject(codexSetupError)
    return Promise.resolve()
  },
}))

await mock.module("../src/services/copilot/get-models", () => ({
  getModels: () => Promise.resolve(rawModelsResponse as ModelsResponse),
}))

const { state } = await import("../src/lib/state")
const { modelRoutes } = await import("../src/routes/models/route")
const { providerModelRoutes } =
  await import("../src/routes/provider/models/route")

// Dev-side global state setup
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const originalFetch = globalThis.fetch

const createProviderConfig = (
  name: string,
  baseUrl: string,
): ResolvedProviderConfig => ({
  apiKey: `${name}-key`,
  authType: "authorization",
  baseUrl,
  name,
  type: "openai-compatible",
})

const createCopilotModels = (ids: Array<string>): ModelsResponse => ({
  object: "list",
  data: ids.map((id) => ({
    capabilities: {
      family: "gpt",
      limits: {
        max_context_window_tokens: 200_000,
      },
      object: "model_capabilities",
      supports: {},
      tokenizer: "o200k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "test",
  })),
})

const createDefaultCodexCatalogModels = () => [
  {
    slug: "gpt-native",
    display_name: "GPT Native",
    base_instructions: "Native instructions",
    available_in_plans: ["pro"],
  },
]

const bundledCodexModels = (
  bundledCodexCatalogJson as {
    models: Array<{
      slug: string
      visibility?: string
      supported_in_api?: boolean
      model_messages?: { instructions_template?: string }
    }>
  }
).models
const bundledCodexSlugs = bundledCodexModels.map((model) => model.slug)

let codexCatalogModels: Array<Record<string, unknown>> =
  createDefaultCodexCatalogModels()

const fetchMock = mock((url: string | URL | Request, _init?: RequestInit) => {
  const requestUrl =
    typeof url === "string" ? url
    : url instanceof URL ? url.toString()
    : url.url

  if (requestUrl.startsWith("https://chatgpt.com/backend-api/codex/models")) {
    return Promise.resolve(
      Response.json({
        models: codexCatalogModels,
      }),
    )
  }

  if (requestUrl === "https://bad.example/v1/models") {
    return Promise.resolve(new Response("upstream failed", { status: 502 }))
  }

  if (requestUrl === "https://kimi.example/v1/models") {
    return Promise.resolve(
      Response.json({
        object: "list",
        data: [
          {
            id: "kimi-k2.5",
            input_modalities: ["text"],
            name: "Kimi K2.5",
            object: "model",
          },
        ],
      }),
    )
  }

  if (requestUrl === "https://deepseek.example/v1/models") {
    return Promise.resolve(
      Response.json({
        object: "list",
        data: [
          {
            id: "deepseek-v4-pro",
            context_window: 128_000,
            input_modalities: ["text", "image"],
            max_output_tokens: 8_000,
            name: "DeepSeek V4 Pro",
            object: "model",
          },
        ],
      }),
    )
  }

  if (requestUrl === "https://opencode.example/v1/models") {
    return Promise.resolve(
      Response.json({
        object: "list",
        data: [
          { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
          { id: "gpt-provider-only", name: "GPT Provider Only" },
          { id: "grok-4.5", name: "Grok 4.5" },
          { id: "qwen3-coder", name: "Qwen3 Coder" },
        ],
      }),
    )
  }

  if (requestUrl === "https://reject.example/v1/models") {
    return Promise.reject(new Error("connection refused"))
  }

  if (requestUrl === "https://invalid.example/v1/models") {
    return Promise.resolve(Response.json({ models: [] }))
  }

  const providerModelIds: Record<string, string> = {
    "first.example": "first-model",
    "second.example": "second-model",
  }
  const providerModelId =
    providerModelIds[new URL(requestUrl).host] ?? "qwen-plus"

  return Promise.resolve(
    Response.json({
      object: "list",
      data: [
        {
          id: providerModelId,
          name: providerModelId,
          object: "model",
        },
        {
          id: "",
          object: "model",
        },
      ],
    }),
  )
})

const providerFetch: typeof fetch = Object.assign(fetchMock, {
  preconnect: originalFetch.preconnect,
})

function createApp() {
  const app = new Hono()
  app.route("/v1/models", modelRoutes)
  app.route("/:provider/v1/models", providerModelRoutes)
  return app
}

// Response type from our API
interface ModelListResponse {
  object: string
  data: Array<{
    id: string
    object: string
    type: string
    created: number
    created_at: string
    owned_by: string
    display_name: string
    family: string
    preview: boolean
    model_picker_enabled: boolean
    endpoints: Array<string> | null
    supports_tool_calls: boolean
    supports_parallel_tool_calls: boolean
    supports_streaming: boolean
    supports_structured_outputs: boolean
    limits: {
      context_window: number | null
      max_output: number | null
      max_prompt: number | null
      thinking_budget?: { min: number; max: number }
      vision?: {
        max_image_size: number | null
        max_images: number | null
        media_types: Array<string> | null
      }
    }
    is_premium: boolean
    billing_multiplier: number
    available_to: Array<string> | null
  }>
  has_more: boolean
}

// Helper to make request to the route
async function getModelsResponse(): Promise<ModelListResponse> {
  const req = new Request("http://localhost/")
  const res = await modelRoutes.fetch(req)
  return res.json() as Promise<ModelListResponse>
}

beforeEach(() => {
  enabledProviders = []
  providerConfigs = {}
  codexSetupError = null
  codexCatalogModels = createDefaultCodexCatalogModels()
  state.models = undefined
  fetchMock.mockClear()
  globalThis.fetch = providerFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = undefined
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
})

describe("model routes", () => {
  test("aggregates Copilot and provider models without mutating state.models", async () => {
    state.models = createCopilotModels(["gpt-5-mini"])
    enabledProviders = ["dash"]
    providerConfigs = {
      dash: createProviderConfig("dash", "https://dash.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "gpt-5-mini",
      "dash/qwen-plus",
    ])
    expect(state.models.data.map((model) => model.id)).toEqual(["gpt-5-mini"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://dash.example/v1/models")
  })

  test("keeps Copilot models first and provider models in provider order", async () => {
    state.models = createCopilotModels(["gpt-5-mini", "gpt-5"])
    enabledProviders = ["second", "first"]
    providerConfigs = {
      first: createProviderConfig("first", "https://first.example"),
      second: createProviderConfig("second", "https://second.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "gpt-5-mini",
      "gpt-5",
      "second/second-model",
      "first/first-model",
    ])
  })

  test("returns provider models in provider-only mode and skips failed providers", async () => {
    enabledProviders = ["bad", "dash"]
    providerConfigs = {
      bad: createProviderConfig("bad", "https://bad.example"),
      dash: createProviderConfig("dash", "https://dash.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual(["dash/qwen-plus"])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("falls back to pricing models for each failed provider models request", async () => {
    enabledProviders = ["deepseek", "kimi", "opencode-go"]
    providerConfigs = {
      deepseek: createProviderConfig("deepseek", "https://bad.example"),
      kimi: createProviderConfig("kimi", "https://reject.example"),
      "opencode-go": createProviderConfig(
        "opencode-go",
        "https://invalid.example",
      ),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: Array<Record<string, unknown> & { id: string }>
    }
    const modelIds = body.data.map((model) => model.id)
    expect(modelIds).toContain("deepseek/deepseek-flash")
    expect(modelIds).toContain("deepseek/deepseek-v4-pro")
    expect(modelIds).toContain("kimi/k3")
    expect(modelIds).toContain("kimi/k3-256k")
    expect(modelIds).toContain("opencode-go/hy3")
    expect(modelIds).toContain("opencode-go/gpt-5.6-luna")
    expect(
      body.data.find((model) => model.id === "deepseek/deepseek-flash"),
    ).toMatchObject({
      display_name: "deepseek-flash",
      object: "model",
      owned_by: "deepseek",
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test("ignores providers whose models fetch rejects when merging the Codex catalog", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    state.models = copilotModels
    enabledProviders = ["reject"]
    providerConfigs = {
      reject: createProviderConfig("reject", "https://reject.example"),
    }

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models.map((model) => model.slug)).toEqual([
      ...bundledCodexSlugs,
      "claude-sonnet-4-6",
    ])
  })

  test("uses pricing models for failed providers in the Codex catalog", async () => {
    enabledProviders = ["deepseek", "kimi", "opencode-go"]
    providerConfigs = {
      deepseek: createProviderConfig("deepseek", "https://bad.example"),
      kimi: createProviderConfig("kimi", "https://reject.example"),
      "opencode-go": createProviderConfig(
        "opencode-go",
        "https://invalid.example",
      ),
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    const modelSlugs = body.models.map((model) => model.slug)
    expect(modelSlugs).toContain("deepseek/deepseek-flash")
    expect(modelSlugs).toContain("kimi/k3")
    expect(modelSlugs).toContain("opencode-go/hy3")
    expect(modelSlugs).toContain("opencode-go/qwen3.7-plus")
    expect(
      body.models.find((model) => model.slug === "deepseek/deepseek-flash"),
    ).toMatchObject({
      context_window: 1_000_000,
      input_modalities: ["text", "image"],
      max_output_tokens: 384_000,
      shell_type: "unified_exec",
      use_responses_lite: true,
      tool_mode: "code_mode_only",
    })
    expect(body.models.find((model) => model.slug === "kimi/k3")).toMatchObject(
      {
        context_window: 1_048_576,
        input_modalities: ["text", "image"],
        max_output_tokens: 64_000,
      },
    )
    expect(
      body.models.find((model) => model.slug === "opencode-go/hy3"),
    ).toMatchObject({
      context_window: 256_000,
      input_modalities: ["text"],
      max_output_tokens: 64_000,
    })
    expect(
      body.models.find((model) => model.slug === "opencode-go/qwen3.7-plus"),
    ).toMatchObject({
      context_window: 1_000_000,
      input_modalities: ["text", "image"],
      max_output_tokens: 64_000,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test("prefers user model config over upstream and built-in defaults", async () => {
    enabledProviders = ["deepseek"]
    providerConfigs = {
      deepseek: {
        ...createProviderConfig("deepseek", "https://deepseek.example"),
        models: {
          "deepseek-v4-pro": {
            contextWindow: 123_456,
            inputModalities: ["text"],
            maxOutputTokens: 4_096,
          },
        },
      },
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find((model) => model.slug === "deepseek/deepseek-v4-pro"),
    ).toMatchObject({
      context_window: 123_456,
      input_modalities: ["text"],
      max_output_tokens: 4_096,
    })
  })

  test("prefers upstream capabilities over built-in catalog defaults", async () => {
    enabledProviders = ["deepseek"]
    providerConfigs = {
      deepseek: createProviderConfig("deepseek", "https://deepseek.example"),
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find((model) => model.slug === "deepseek/deepseek-v4-pro"),
    ).toMatchObject({
      context_window: 128_000,
      input_modalities: ["text", "image"],
      max_output_tokens: 8_000,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("adds built-in Codex provider models without calling upstream", async () => {
    enabledProviders = ["codex"]
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-6-astra")
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-5.6-sol")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("does not use pricing models when Codex credential setup fails", async () => {
    enabledProviders = ["codex"]
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    codexSetupError = new Error("refresh failed")

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("forwards Codex clients to the fixed Codex models endpoint", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/v1/models?client=codex", {
      headers: {
        accept: "*/*",
        "user-agent": "codex-tui/0.144.1",
      },
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/backend-api/codex/models?client=codex",
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
    expect(headers.get("accept")).toBe("*/*")
  })

  test("merges Messages-backed models into the Codex response_lite catalog", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    state.models = copilotModels
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models.map((model) => model.slug)).toEqual([
      "gpt-native",
      "claude-sonnet-4-6",
    ])
    expect(
      body.models.find((model) => model.slug === "claude-sonnet-4-6"),
    ).toMatchObject({
      use_responses_lite: true,
      prefer_websockets: false,
      apply_patch_tool_type: "freeform",
      supports_search_tool: false,
      supports_parallel_tool_calls: true,
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
      default_reasoning_level: "max",
    })
  })

  test("merges Responses-backed Copilot models into the Codex catalog", async () => {
    const copilotModels = createCopilotModels([
      "gpt-responses-http",
      "gpt-responses-websocket",
    ])
    copilotModels.data[0].supported_endpoints = ["/responses"]
    copilotModels.data[1].supported_endpoints = ["ws:/responses"]
    for (const model of copilotModels.data) {
      model.capabilities.supports.tool_calls = true
    }
    state.models = copilotModels

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models.map((model) => model.slug)).toEqual([
      ...bundledCodexSlugs,
      "gpt-responses-http",
      "gpt-responses-websocket",
    ])
    expect(
      body.models.find((model) => model.slug === "gpt-responses-http")
        ?.description,
    ).toBe("gpt-responses-http through the Copilot Responses API.")
    expect(
      body.models.find((model) => model.slug === "gpt-responses-websocket")
        ?.description,
    ).toBe("gpt-responses-websocket through the Copilot Responses API.")
  })

  test("describes non-GPT Responses-capable Copilot models as adapter-backed", async () => {
    const copilotModels = createCopilotModels([
      "claude-sonnet-4.6",
      "gemini-3-pro",
    ])
    copilotModels.data[0].supported_endpoints = ["/responses", "/v1/messages"]
    copilotModels.data[1].supported_endpoints = ["/responses"]
    for (const model of copilotModels.data) {
      model.capabilities.supports.tool_calls = true
    }
    state.models = copilotModels

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find((model) => model.slug === "claude-sonnet-4-6")
        ?.description,
    ).toBe("claude-sonnet-4.6 through the Copilot Messages adapter.")
    expect(
      body.models.find((model) => model.slug === "gemini-3-pro")?.description,
    ).toBe("gemini-3-pro through the Copilot Messages-to-Responses adapter.")
  })

  test("uses the bundled Codex catalog when the Codex provider is missing", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    state.models = copilotModels
    enabledProviders = ["claude"]
    providerConfigs = {
      claude: createProviderConfig("claude", "https://claude.example"),
    }

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    const synthetic = body.models.find(
      (model) => model.slug === "claude-sonnet-4-6",
    )
    expect(synthetic).toMatchObject({
      display_name: "claude-sonnet-4.6",
      shell_type: "unified_exec",
    })
    expect(synthetic?.available_in_plans).toContain("pro")
    const template = bundledCodexModels.find(
      (model) =>
        model.visibility === "list" && model.supported_in_api !== false,
    )
    const modelMessages = synthetic?.model_messages as
      { instructions_template?: string } | undefined
    expect(modelMessages?.instructions_template).toBe(
      template?.model_messages?.instructions_template,
    )
  })

  test("copies matching Codex catalog models for provider-prefixed aliases", async () => {
    const solCatalogModel = {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      description: "Sol catalog description",
      base_instructions: "Sol catalog instructions",
      context_window: 372_000,
      default_reasoning_level: "max",
      priority: 11,
      supported_reasoning_levels: [
        { effort: "high", description: "High reasoning" },
        { effort: "xhigh", description: "Extra high reasoning" },
        { effort: "max", description: "Maximum reasoning" },
      ],
      use_responses_lite: false,
      custom_catalog_field: { source: "sol" },
    }
    const lunaCatalogModel = {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6 Luna",
      description: "Luna catalog description",
      base_instructions: "Luna catalog instructions",
      context_window: 372_000,
      priority: 13,
      supported_reasoning_levels: [
        { effort: "max", description: "Maximum reasoning" },
      ],
      use_responses_lite: false,
      custom_catalog_field: { source: "luna" },
    }
    const remoteOnlyCatalogModel = {
      slug: "gpt-remote-only",
      display_name: "GPT Remote Only",
      description: "Only the remote catalog knows this model",
      priority: 17,
      use_responses_lite: false,
    }
    codexCatalogModels = [
      solCatalogModel,
      lunaCatalogModel,
      remoteOnlyCatalogModel,
    ]
    enabledProviders = ["codex", "opencode-go"]
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
      "opencode-go": {
        apiKey: "opencode-token",
        authType: "authorization",
        baseUrl: "https://opencode.example",
        name: "opencode-go",
        type: "openai-compatible",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models.find((model) => model.slug === "gpt-5.6-sol")).toEqual(
      solCatalogModel,
    )
    expect(
      body.models.find((model) => model.slug === "codex/gpt-5.6-sol"),
    ).toEqual({
      ...solCatalogModel,
      slug: "codex/gpt-5.6-sol",
      display_name: "codex GPT-5.6 Sol",
      priority: 1_000,
    })
    expect(
      body.models.find((model) => model.slug === "opencode-go/gpt-5.6-luna"),
    ).toEqual({
      ...lunaCatalogModel,
      slug: "opencode-go/gpt-5.6-luna",
      display_name: "opencode-go GPT-5.6 Luna",
      priority: 3_000,
    })
    expect(
      body.models.find((model) => model.slug === "codex/gpt-remote-only"),
    ).toEqual({
      ...remoteOnlyCatalogModel,
      slug: "codex/gpt-remote-only",
      display_name: "codex GPT Remote Only",
      priority: 1_002,
    })
    expect(
      body.models.find((model) => model.slug === "opencode-go/qwen3-coder"),
    ).toMatchObject({ display_name: "Qwen3 Coder (opencode-go)" })
    expect(
      body.models.find((model) => model.slug === "opencode-go/grok-4.5"),
    ).toMatchObject({
      context_window: 500_000,
      default_reasoning_level: "high",
      display_name: "Grok 4.5 (opencode-go)",
      input_modalities: ["text", "image"],
      max_output_tokens: 64_000,
      supported_reasoning_levels: [
        { effort: "low", description: "low reasoning effort" },
        { effort: "medium", description: "medium reasoning effort" },
        { effort: "high", description: "high reasoning effort" },
        { effort: "ultra", description: "ultra reasoning effort" },
      ],
    })
    expect(body.models.map((model) => model.slug)).not.toContain(
      "opencode-go/gpt-provider-only",
    )
  })

  test("orders merged Codex models as catalog, codex, copilot, opencode-go, then providers", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    state.models = copilotModels
    enabledProviders = ["codex", "kimi", "opencode-go"]
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
      kimi: createProviderConfig("kimi", "https://kimi.example"),
      "opencode-go": createProviderConfig(
        "opencode-go",
        "https://opencode.example",
      ),
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models.map((model) => model.slug)).toEqual([
      "gpt-native",
      "codex/gpt-native",
      "claude-sonnet-4-6",
      "opencode-go/grok-4.5",
      "opencode-go/qwen3-coder",
      "kimi/kimi-k2.5",
    ])
    const priorities = body.models.map((model) =>
      typeof model.priority === "number" ? model.priority : 0,
    )
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b))
  })

  test("skips malformed Copilot model records when merging the Codex catalog", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    copilotModels.data.push({
      id: "broken-model",
    } as unknown as ModelsResponse["data"][number])
    state.models = copilotModels

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models.map((model) => model.slug)).toEqual([
      ...bundledCodexSlugs,
      "claude-sonnet-4-6",
    ])
  })

  test("prefers max as the built-in default reasoning effort for Codex models", async () => {
    const copilotModels = createCopilotModels([
      "claude-sonnet-4.6",
      "claude-opus-4.1",
    ])
    for (const model of copilotModels.data) {
      model.supported_endpoints = ["/v1/messages"]
      model.capabilities.supports.tool_calls = true
    }
    copilotModels.data[0].capabilities.supports.reasoning_effort = [
      "minimal",
      "low",
      "medium",
      "max",
    ]
    copilotModels.data[1].capabilities.supports.reasoning_effort = [
      "low",
      "medium",
    ]
    state.models = copilotModels

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find((model) => model.slug === "claude-sonnet-4-6"),
    ).toMatchObject({ default_reasoning_level: "max" })
    expect(
      body.models.find((model) => model.slug === "claude-opus-4-1"),
    ).toMatchObject({ default_reasoning_level: "low" })
  })

  test("defaults reasoning efforts to high, xhigh, max, and ultra for Codex models", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    state.models = copilotModels
    enabledProviders = ["chat"]
    providerConfigs = {
      chat: createProviderConfig("chat", "https://chat.example"),
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    for (const slug of ["claude-sonnet-4-6", "chat/qwen-plus"]) {
      expect(body.models.find((model) => model.slug === slug)).toMatchObject({
        default_reasoning_level: "max",
        supported_reasoning_levels: [
          { effort: "high", description: "high reasoning effort" },
          { effort: "xhigh", description: "xhigh reasoning effort" },
          { effort: "max", description: "max reasoning effort" },
          { effort: "ultra", description: "ultra reasoning effort" },
        ],
      })
    }
  })

  test("adds ultra reasoning effort at the end when it is missing", async () => {
    const copilotModels = createCopilotModels(["gpt-reasoning-test"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    copilotModels.data[0].capabilities.supports.reasoning_effort = [
      "low",
      "medium",
      "high",
      "xhigh",
    ]
    state.models = copilotModels

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find((model) => model.slug === "gpt-reasoning-test"),
    ).toMatchObject({
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "low reasoning effort" },
        { effort: "medium", description: "medium reasoning effort" },
        { effort: "high", description: "high reasoning effort" },
        { effort: "xhigh", description: "xhigh reasoning effort" },
        { effort: "ultra", description: "ultra reasoning effort" },
      ],
    })
  })

  test("merges Anthropic and OpenAI-compatible provider models for Codex", async () => {
    enabledProviders = ["anthropic", "chat"]
    providerConfigs = {
      anthropic: {
        apiKey: "anthropic-key",
        authType: "x-api-key",
        baseUrl: "https://anthropic.example",
        models: {
          "claude-provider": {
            contextWindow: 180_000,
            maxOutputTokens: 24_000,
            inputModalities: ["text", "image"],
            reasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "high",
          },
        },
        name: "anthropic",
        type: "anthropic",
      },
      chat: {
        apiKey: "chat-key",
        authType: "authorization",
        baseUrl: "https://chat.example",
        models: { "chat-provider": {} },
        name: "chat",
        type: "openai-compatible",
      },
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    const anthropicModel = body.models.find(
      (model) => model.slug === "anthropic/claude-provider",
    )
    expect(anthropicModel).toMatchObject({
      use_responses_lite: true,
      context_window: 180_000,
      max_output_tokens: 24_000,
      input_modalities: ["text", "image"],
      default_reasoning_level: "high",
      supports_parallel_tool_calls: true,
      supports_search_tool: false,
    })
    expect(body.models.map((model) => model.slug)).toContain(
      "chat/chat-provider",
    )
  })

  test("adds image input to Kimi Codex models by default", async () => {
    enabledProviders = ["kimi"]
    providerConfigs = {
      kimi: {
        apiKey: "kimi-key",
        authType: "authorization",
        baseUrl: "https://kimi.example",
        name: "kimi",
        type: "openai-compatible",
      },
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find((model) => model.slug === "kimi/kimi-k2.5"),
    ).toMatchObject({ input_modalities: ["text", "image"] })
  })

  test("forwards Codex clients on the provider-scoped models route", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request(
      "/codex/v1/models?client=codex",
      {
        headers: {
          accept: "*/*",
          "user-agent": "codex-tui/0.144.1",
        },
      },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/backend-api/codex/models?client=codex",
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
  })

  test("returns built-in Codex models on the provider route without Codex UA", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }

    const response = await createApp().request("/codex/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toContain("gpt-6-astra")
    expect(body.data.map((model) => model.id)).toContain("gpt-5.6-sol")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("GET /models - backward compatibility", () => {
  test("returns original fields for all models", async () => {
    const response = await getModelsResponse()

    expect(response.object).toBe("list")
    expect(response.data).toBeArray()
    expect(response.data.length).toBeGreaterThan(0)

    // Check first model has all original fields
    const model = response.data[0]
    expect(model).toHaveProperty("id")
    expect(model).toHaveProperty("object", "model")
    expect(model).toHaveProperty("type")
    expect(model).toHaveProperty("created")
    expect(model).toHaveProperty("created_at")
    expect(model).toHaveProperty("owned_by")
    expect(model).toHaveProperty("display_name")
  })
})

describe("GET /models - new fields", () => {
  test("includes family field", async () => {
    const response = await getModelsResponse()
    const model = response.data[0]

    expect(model).toHaveProperty("family")
    expect(typeof model.family).toBe("string")
  })

  test("includes preview field", async () => {
    const response = await getModelsResponse()
    const model = response.data[0]

    expect(model).toHaveProperty("preview")
    expect(typeof model.preview).toBe("boolean")
  })

  test("includes model_picker_enabled field", async () => {
    const response = await getModelsResponse()
    const model = response.data[0]

    expect(model).toHaveProperty("model_picker_enabled")
    expect(typeof model.model_picker_enabled).toBe("boolean")
  })

  test("includes endpoints field when available", async () => {
    const response = await getModelsResponse()
    // Find a model with supported_endpoints
    const modelWithEndpoints = response.data.find((m) => m.endpoints !== null)

    expect(modelWithEndpoints).toBeDefined()
    if (modelWithEndpoints) {
      expect(modelWithEndpoints.endpoints).toBeArray()
    }
  })

  test("includes supports_* boolean fields", async () => {
    const response = await getModelsResponse()
    const model = response.data[0]

    expect(model).toHaveProperty("supports_tool_calls")
    expect(model).toHaveProperty("supports_parallel_tool_calls")
    expect(model).toHaveProperty("supports_streaming")
    expect(model).toHaveProperty("supports_structured_outputs")

    expect(typeof model.supports_tool_calls).toBe("boolean")
    expect(typeof model.supports_streaming).toBe("boolean")
  })

  test("includes limits object with core fields", async () => {
    const response = await getModelsResponse()
    const model = response.data[0]

    expect(model).toHaveProperty("limits")
    expect(model.limits).toHaveProperty("context_window")
    expect(model.limits).toHaveProperty("max_output")
    expect(model.limits).toHaveProperty("max_prompt")

    expect(typeof model.limits.context_window).toBe("number")
  })

  test("includes billing fields", async () => {
    const response = await getModelsResponse()
    const model = response.data[0]

    expect(model).toHaveProperty("is_premium")
    expect(model).toHaveProperty("billing_multiplier")

    expect(typeof model.is_premium).toBe("boolean")
    expect(typeof model.billing_multiplier).toBe("number")
  })
})

describe("GET /models - conditional fields", () => {
  test("Claude models have /v1/messages in endpoints", async () => {
    const response = await getModelsResponse()
    const claudeModel = response.data.find((m) => m.id.startsWith("claude-"))

    expect(claudeModel).toBeDefined()
    if (claudeModel) {
      expect(claudeModel.endpoints).toContain("/v1/messages")
    }
  })

  test("models with thinking support have limits.thinking_budget", async () => {
    const response = await getModelsResponse()
    // Claude and Gemini models support thinking
    const claudeModel = response.data.find((m) => m.id.startsWith("claude-"))

    expect(claudeModel).toBeDefined()
    if (claudeModel) {
      expect(claudeModel.limits).toHaveProperty("thinking_budget")
      expect(claudeModel.limits.thinking_budget).toHaveProperty("min")
      expect(claudeModel.limits.thinking_budget).toHaveProperty("max")
    }
  })

  test("models with vision support have limits.vision", async () => {
    const response = await getModelsResponse()
    // Find a model with vision support
    const visionModel = response.data.find((m) => m.limits.vision !== undefined)

    expect(visionModel).toBeDefined()
    if (visionModel) {
      expect(visionModel.limits.vision).toHaveProperty("max_image_size")
      expect(visionModel.limits.vision).toHaveProperty("max_images")
      expect(visionModel.limits.vision).toHaveProperty("media_types")
    }
  })

  test("premium models have available_to field", async () => {
    const response = await getModelsResponse()
    const premiumModel = response.data.find((m) => m.is_premium)

    expect(premiumModel).toBeDefined()
    if (premiumModel) {
      expect(premiumModel).toHaveProperty("available_to")
      expect(premiumModel.available_to).toBeArray()
    }
  })
})

describe("GET /models - all models parsed correctly", () => {
  test("returns picker-enabled and embedding models unless policy-disabled", async () => {
    const response = await getModelsResponse()

    const expectedCount = (
      rawModelsResponse.data as Array<{
        capabilities?: { type?: string }
        model_picker_enabled?: boolean
        policy?: { state?: string }
      }>
    ).filter(
      (model) =>
        model.policy?.state !== "disabled"
        && (model.model_picker_enabled
          || model.capabilities?.type === "embeddings"),
    ).length
    expect(response.data.length).toBe(expectedCount)
  })

  test("no model has undefined required fields", async () => {
    const response = await getModelsResponse()

    for (const model of response.data) {
      // Required fields should never be undefined
      expect(model.id).toBeDefined()
      expect(model.object).toBe("model")
      expect(model.owned_by).toBeDefined()
      expect(model.family).toBeDefined()
      expect(model.limits).toBeDefined()
      expect(typeof model.is_premium).toBe("boolean")
    }
  })
})

describe("GET /models - sorting", () => {
  test("premium models come before non-premium models", async () => {
    const response = await getModelsResponse()
    const chatModels = response.data.filter((m) => m.type === "chat")

    let sawNonPremium = false
    for (const model of chatModels) {
      if (!model.is_premium) {
        sawNonPremium = true
      }
      // Once we see a non-premium, we shouldn't see premium again
      if (sawNonPremium && model.is_premium) {
        throw new Error(
          `Premium model ${model.id} appears after non-premium models`,
        )
      }
    }
  })

  test("premium models are sorted by max_prompt descending", async () => {
    const response = await getModelsResponse()
    const premiumChatModels = response.data.filter(
      (m) => m.is_premium && m.type === "chat",
    )

    for (let i = 1; i < premiumChatModels.length; i++) {
      const prev = premiumChatModels[i - 1].limits.max_prompt ?? 0
      const curr = premiumChatModels[i].limits.max_prompt ?? 0
      expect(prev).toBeGreaterThanOrEqual(curr)
    }
  })

  test("non-premium chat models are sorted by max_prompt descending", async () => {
    const response = await getModelsResponse()
    const nonPremiumChatModels = response.data.filter(
      (m) => !m.is_premium && m.type === "chat",
    )

    for (let i = 1; i < nonPremiumChatModels.length; i++) {
      const prev = nonPremiumChatModels[i - 1].limits.max_prompt ?? 0
      const curr = nonPremiumChatModels[i].limits.max_prompt ?? 0
      expect(prev).toBeGreaterThanOrEqual(curr)
    }
  })

  test("embedding models come at the end (if any pass model_picker_enabled)", async () => {
    const response = await getModelsResponse()
    const embeddingModels = response.data.filter((m) => m.type === "embeddings")

    if (embeddingModels.length === 0) {
      // All embedding models filtered out by model_picker_enabled — nothing to assert
      return
    }

    const lastModels = response.data.slice(-embeddingModels.length)
    expect(lastModels.every((m) => m.type === "embeddings")).toBe(true)
  })
})
