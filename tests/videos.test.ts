import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  invalidateConfigCache,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"
import { videoRouteDependencies, videoRoutes } from "~/routes/videos/route"
import { createServer } from "~/server"
import { forwardXaiVideos, XaiVideosRequestError } from "~/services/xai/videos"

const model = "xai/grok-imagine-video-1.5"
const originalFetch = globalThis.fetch
const originalConfigPath = PATHS.CONFIG_PATH
const originalDependencies = { ...videoRouteDependencies }
const fetchMock = mock(
  (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
    Promise.resolve(Response.json({ request_id: "video-job" })),
)
const resolveProviderMock = mock((_name: string) =>
  Promise.resolve<ResolvedProviderConfig | null>(providerConfig),
)
let providerConfig: ResolvedProviderConfig
let tempDir: string

function writeConfig(upstreamTransport: Record<string, number> = {}): void {
  fs.writeFileSync(PATHS.CONFIG_PATH, JSON.stringify({ upstreamTransport }))
  invalidateConfigCache()
}

function createApp() {
  const app = new Hono()
  app.route("/videos", videoRoutes)
  app.route("/v1/videos", videoRoutes)
  return app
}

function getUpstreamUrl(callIndex: number): string {
  const input = fetchMock.mock.calls[callIndex][0]
  return input instanceof Request ? input.url : input.toString()
}

function generate(
  payload: unknown = { model, prompt: "A paper boat on a lake" },
  signal?: AbortSignal,
) {
  return createApp().request("/v1/videos/generations", {
    method: "POST",
    body: JSON.stringify(payload),
    signal,
  })
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-videos-"))
  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
  writeConfig()
  providerConfig = {
    name: "xai",
    type: "openai-responses",
    baseUrl: "https://api.x.ai",
    apiKey: "xai-key",
    authType: "authorization",
  }
  videoRouteDependencies.resolveMappedModel = (value) => value
  resolveProviderMock.mockReset()
  resolveProviderMock.mockImplementation(() => Promise.resolve(providerConfig))
  videoRouteDependencies.resolveProviderConfig = resolveProviderMock
  fetchMock.mockReset()
  fetchMock.mockImplementation(() =>
    Promise.resolve(Response.json({ request_id: "video-job" })),
  )
  globalThis.fetch = Object.assign(fetchMock, { preconnect: () => {} })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(videoRouteDependencies, originalDependencies)
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()
  if (!tempDir.startsWith(path.join(os.tmpdir(), "copilot-api-videos-"))) {
    throw new Error("Invalid test directory")
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("video routes", () => {
  test.each(["/videos", "/v1/videos"])(
    "registers authenticated submit and result endpoints at %s",
    async (prefix) => {
      const app = createServer({ getApiKeys: () => ["gateway-key"] })
      const headers = {
        authorization: "Bearer gateway-key",
        "x-api-key": "gateway-key",
        "chatgpt-account-id": "client-account",
        cookie: "client-cookie",
        "user-agent": "video-client",
      }
      const response = await app.request(`${prefix}/generations?trace=one`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, prompt: "A paper boat" }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ request_id: "video-job" })

      const result = await app.request(`${prefix}/video-job`, { headers })
      expect(result.status).toBe(200)
      await result.text()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(resolveProviderMock.mock.calls).toEqual([["xai"], ["xai"]])
      expect(getUpstreamUrl(0)).toBe(
        "https://api.x.ai/v1/videos/generations?trace=one",
      )
      expect(getUpstreamUrl(1)).toBe("https://api.x.ai/v1/videos/video-job")
      expect(fetchMock.mock.calls[0][1]?.method).toBe("POST")
      expect(fetchMock.mock.calls[1][1]?.method).toBe("GET")
      expect(fetchMock.mock.calls[1][1]?.body).toBeUndefined()
      for (const [, init] of fetchMock.mock.calls) {
        const upstreamHeaders = new Headers(init?.headers)
        expect(upstreamHeaders.get("authorization")).toBe("Bearer xai-key")
        expect(upstreamHeaders.get("content-type")).toBe("application/json")
        expect(upstreamHeaders.get("user-agent")).toBe("video-client")
        for (const name of ["x-api-key", "chatgpt-account-id", "cookie"]) {
          expect(upstreamHeaders.has(name)).toBe(false)
        }
      }
    },
  )

  test.each(["/videos", "/v1/videos"])(
    "rejects missing or invalid gateway credentials at %s",
    async (prefix) => {
      const app = createServer({ getApiKeys: () => ["gateway-key"] })
      for (const authorization of [undefined, "Bearer wrong-key"]) {
        for (const method of ["POST", "GET"]) {
          const response = await app.request(
            `${prefix}/${method === "POST" ? "generations" : "video-job"}`,
            {
              method,
              headers: authorization ? { authorization } : {},
              body: method === "POST" ? JSON.stringify({ model }) : undefined,
            },
          )
          expect(response.status).toBe(401)
          await response.text()
        }
      }
      expect(fetchMock).not.toHaveBeenCalled()
      expect(resolveProviderMock).not.toHaveBeenCalled()
    },
  )

  test("applies model mappings and removes the provider prefix", async () => {
    const resolveModel = mock((value: string) =>
      value === "my-video" ? model : value,
    )
    videoRouteDependencies.resolveMappedModel = resolveModel
    const response = await generate({ model: "my-video", prompt: "A boat" })
    expect(response.status).toBe(200)
    await response.text()
    expect(resolveModel).toHaveBeenCalledWith("my-video")
    expect(await new Response(fetchMock.mock.calls[0][1]?.body).json()).toEqual(
      { model: "grok-imagine-video-1.5", prompt: "A boat" },
    )
  })

  test("uses the configured upstream base URL for submissions and queries", async () => {
    providerConfig.baseUrl = "https://video-proxy.example/custom"
    const submitted = await generate()
    expect(submitted.status).toBe(200)
    await submitted.text()
    const result = await createApp().request("/videos/video-job")
    expect(result.status).toBe(200)
    await result.text()
    expect(getUpstreamUrl(0)).toBe(
      "https://video-proxy.example/custom/v1/videos/generations",
    )
    expect(getUpstreamUrl(1)).toBe(
      "https://video-proxy.example/custom/v1/videos/video-job",
    )
  })

  test.each([
    {
      prompt: "A boat",
      duration: 5,
      aspect_ratio: "16:9",
      resolution: "720p",
      generate_audio: false,
    },
    { image: { url: "https://example.com/first.png" } },
    {
      reference_images: [{ url: "https://example.com/person.png" }],
      reference_audios: [{ voice_id: "eve" }],
      last_frame: { url: "https://example.com/last.png" },
      storage_options: { filename: "clip.mp4", public_url: true },
    },
  ])("preserves native generation parameters %#", async (parameters) => {
    const response = await generate({ ...parameters, model })
    expect(response.status).toBe(200)
    await response.text()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await new Response(fetchMock.mock.calls[0][1]?.body).json()).toEqual(
      { ...parameters, model: "grok-imagine-video-1.5" },
    )
  })

  test.each(["", "{", "null", "[]", "42", '"text"', "true"])(
    "rejects invalid JSON objects: %s",
    async (body) => {
      const response = await createApp().request("/videos/generations", {
        method: "POST",
        body,
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toHaveProperty(
        "error.type",
        "invalid_request_error",
      )
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test.each([undefined, null, 1, "", "  "])(
    "rejects a missing or invalid model: %s",
    async (value) => {
      const response = await generate({ model: value, prompt: "A boat" })
      expect(response.status).toBe(400)
      await response.text()
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test.each([
    "grok-imagine-video-1.5",
    "xai/grok-imagine-image-2.0",
    "xai/grok-imagine-video",
    "other/grok-imagine-video-1.5",
    "xai/",
  ])("rejects unsupported model %s without falling back", async (value) => {
    const response = await generate({ model: value })
    expect(response.status).toBe(400)
    await response.text()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(resolveProviderMock).not.toHaveBeenCalled()
  })

  test("validates the mapped model rather than the original alias", async () => {
    videoRouteDependencies.resolveMappedModel = () => "codex/sora-2"
    const response = await generate()
    expect(response.status).toBe(400)
    await response.text()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each(["POST", "GET"])(
    "returns 404 for unavailable xAI on %s",
    async (method) => {
      resolveProviderMock.mockResolvedValue(null)
      const response =
        method === "POST" ?
          await generate()
        : await createApp().request("/videos/video-job")
      expect(response.status).toBe(404)
      expect(await response.json()).toHaveProperty(
        "error.message",
        "Provider 'xai' not found or disabled",
      )
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test.each(["pending", "done", "expired", "failed"])(
    "preserves native %s result bodies",
    async (status) => {
      const body = {
        status,
        model: "grok-imagine-video-1.5",
        video:
          status === "done" ?
            {
              url: "https://vidgen.x.ai/clip.mp4",
              duration: 5,
              respect_moderation: true,
            }
          : null,
        progress: status === "done" ? 100 : 0,
        usage: { cost_in_usd_ticks: 1 },
      }
      fetchMock.mockImplementation(() => Promise.resolve(Response.json(body)))
      const response = await createApp().request("/v1/videos/video-job")
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(body)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  test.each([400, 401, 403, 404, 429, 500, 503])(
    "passes through upstream HTTP %s without retries",
    async (status) => {
      const body =
        '{"error":{"code":"upstream_error","message":"Cannot generate"}}'
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(body, {
            status,
            headers: {
              "content-type": "application/json",
              "retry-after": "10",
              "x-request-id": "upstream-id",
              "content-length": "9999",
              "content-encoding": "gzip",
              connection: "keep-alive",
            },
          }),
        ),
      )
      for (const method of ["POST", "GET"]) {
        const response =
          method === "POST" ?
            await generate()
          : await createApp().request("/videos/video-job")
        expect(response.status).toBe(status)
        expect(await response.text()).toBe(body)
        expect(response.headers.get("retry-after")).toBe("10")
        expect(response.headers.get("x-request-id")).toBe("upstream-id")
        for (const name of [
          "content-length",
          "content-encoding",
          "connection",
        ]) {
          expect(response.headers.has(name)).toBe(false)
        }
      }
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  test("keeps request IDs inside a single encoded path segment", async () => {
    const response = await createApp().request(
      "/videos/job%3Fpart%23fragment?trace=one",
    )
    expect(response.status).toBe(200)
    await response.text()
    expect(getUpstreamUrl(0)).toBe(
      "https://api.x.ai/v1/videos/job%3Fpart%23fragment?trace=one",
    )
  })

  test.each(["job%2Fother", "job%5Cother", "%20"])(
    "rejects invalid request ID %s",
    async (requestId) => {
      const response = await createApp().request(`/videos/${requestId}`)
      expect(response.status).toBe(400)
      await response.text()
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test.each([".", "..", ""])(
    "rejects path traversal ID %s before dispatch",
    async (requestId) => {
      const error: unknown = await forwardXaiVideos(
        providerConfig,
        new Request("http://localhost/videos/job"),
        { operation: "result", requestId },
      ).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(XaiVideosRequestError)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test.each(["POST", "GET"])(
    "forwards network failures on %s without retries",
    async (method) => {
      fetchMock.mockRejectedValue(new Error("Upstream unavailable"))
      const response =
        method === "POST" ?
          await generate()
        : await createApp().request("/videos/video-job")
      expect(response.status).toBe(500)
      expect(await response.json()).toHaveProperty(
        "error.message",
        "Upstream unavailable",
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  test.each(["POST", "GET"])(
    "applies the configured headers timeout on %s",
    async (method) => {
      writeConfig({ headersTimeoutMs: 20 })
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal
            signal?.addEventListener(
              "abort",
              () => reject(new Error("Fetch aborted")),
              {
                once: true,
              },
            )
          }),
      )
      const response =
        method === "POST" ?
          await generate()
        : await createApp().request("/videos/video-job")
      expect(response.status).toBe(504)
      expect(await response.json()).toHaveProperty(
        "error.type",
        "upstream_timeout",
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    },
  )

  test.each(["POST", "GET"])(
    "does not dispatch a cancelled %s request",
    async (method) => {
      const controller = new AbortController()
      controller.abort()
      const response =
        method === "POST" ?
          await generate(undefined, controller.signal)
        : await createApp().request("/videos/video-job", {
            signal: controller.signal,
          })
      expect(response.status).toBe(499)
      await response.text()
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("rechecks cancellation after resolving credentials", async () => {
    const controller = new AbortController()
    resolveProviderMock.mockImplementation(() => {
      controller.abort()
      return Promise.resolve(providerConfig)
    })
    const response = await generate(undefined, controller.signal)
    expect(response.status).toBe(499)
    await response.text()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("does not register provider-scoped or editing endpoints", async () => {
    const app = createServer({ getApiKeys: () => [] })
    for (const endpoint of [
      "/xai/v1/videos/generations",
      "/xai/videos/generations",
      "/v1/videos/edits",
      "/v1/videos/extensions",
    ]) {
      const response = await app.request(endpoint, {
        method: "POST",
        body: JSON.stringify({ model }),
      })
      expect(response.status).toBe(404)
      await response.text()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
