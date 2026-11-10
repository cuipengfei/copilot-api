import { afterAll, expect, spyOn, test } from "bun:test"
import consola from "consola"

import {
  getAutoSessionForModel,
  invalidateAutoSession,
  registerAutoSelection,
  registerFusionSelection,
  stopProbeScheduler,
  whenProbeSchedulerIdle,
} from "../src/lib/auto-session"
import { state } from "../src/lib/state"
import { createResponses } from "../src/services/copilot/create-responses"
import {
  getResponsesTransportForModel,
  responsesUtilsDependencies,
} from "../src/routes/responses/utils"

// Real loopback handshakes exercise the unchanged transport decision with both caches.
const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  forceAgent: state.forceAgent,
  copilotTelemetryEnabled: state.copilotTelemetryEnabled,
  models: state.models,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeVersion: state.vsCodeVersion,
}
const originalFetch = globalThis.fetch

afterAll(async () => {
  stopProbeScheduler()
  await whenProbeSchedulerIdle()
})

test.each(["fusion", "auto"] as const)(
  "Responses websocket handshake omits a valid %s discount token",
  async (source) => {
    const handshakes: Array<{ path: string; headers: Record<string, string> }> =
      []
    const receivedModels: Array<string> = []
    let httpAutoCount = 0
    let httpResponsesCount = 0
    let httpFusionCount = 0
    const infoSpy = spyOn(consola, "info")
    const transportSpy = spyOn(
      responsesUtilsDependencies,
      "isResponsesApiWebSocketEnabled",
    ).mockReturnValue(true)

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, bunServer) {
        const url = new URL(req.url)
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          handshakes.push({
            path: url.pathname,
            headers: Object.fromEntries(req.headers),
          })
          if (bunServer.upgrade(req)) return
          return new Response("upgrade failed", { status: 500 })
        }
        // 非升级请求一律记账并拒绝：负例断言这两类计数为 0
        if (url.pathname === "/auto") httpAutoCount += 1
        if (url.pathname === "/model/fusion") httpFusionCount += 1
        if (url.pathname === "/responses") httpResponsesCount += 1
        return new Response("unexpected http", { status: 400 })
      },
      websocket: {
        message(ws, data) {
          const payload = JSON.parse(String(data)) as { model?: string }
          if (typeof payload.model === "string") {
            receivedModels.push(payload.model)
          }
          ws.send(
            JSON.stringify({
              type: "response.completed",
              sequence_number: 1,
              response: {
                id: "resp-ws-local",
                object: "response",
                created_at: 0,
                model: payload.model ?? "unknown",
                output: [],
                output_text: "",
                status: "completed",
                usage: null,
                error: null,
                incomplete_details: null,
                instructions: null,
                metadata: null,
                parallel_tool_calls: false,
                temperature: null,
                tools: [],
                tool_choice: "auto",
                top_p: null,
              },
            }),
          )
        },
      },
    })
    const serverUrl = `http://127.0.0.1:${server.port}`
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== serverUrl)
        throw new Error("local websocket fixture forbids external network")
      return originalFetch(input, init)
    }) as typeof fetch

    state.accountType = "individual"
    state.copilotApiUrl = serverUrl
    state.copilotToken = "ws-local-fake-token"
    state.copilotTelemetryEnabled = false
    state.forceAgent = false
    state.vsCodeDeviceId = "device-1"
    state.vsCodeVersion = "1.120.0"
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-test",
          supported_endpoints: ["/responses", "ws:/responses"],
        },
      ],
    } as typeof state.models
    invalidateAutoSession()

    registerAutoSelection({
      selected_model: {
        id: "gpt-test",
        supported_endpoints: ["/responses", "ws:/responses"],
      },
      session_token: "ws-should-not-attach",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    })
    if (source === "fusion") {
      expect(
        registerFusionSelection({
          modelId: "gpt-test",
          sessionToken: "fusion-ws-should-not-attach",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toBe(true)
    }
    try {
      // 配对确实可用（HTTP /responses 维度）：负例针对的是 WS 分支不附加
      expect(
        await getAutoSessionForModel({
          model: "gpt-test",
          endpoint: "/responses",
        }),
      ).toEqual({
        sessionToken:
          source === "fusion" ?
            "fusion-ws-should-not-attach"
          : "ws-should-not-attach",
        source,
        expectedDiscount: source === "fusion" ? 30 : 10,
      })
      const transport = getResponsesTransportForModel(state.models?.data[0])
      expect(transport).toBe("websocket")

      const stream = (await createResponses(
        { input: "hello", model: "gpt-test", stream: true },
        {
          initiator: "user",
          requestId: `ws-local-${source}`,
          transport: transport ?? undefined,
          vision: false,
        },
      )) as AsyncIterable<{ data?: string }>

      let completed: { response?: { model?: string } } | null = null
      for await (const chunk of stream) {
        const message = JSON.parse(chunk.data ?? "{}") as {
          type?: string
          response?: { model?: string }
        }
        if (message.type === "response.completed") completed = message
      }

      // wire 握手恰一次、路径 /responses，且无任何大小写的 session token 头
      expect(handshakes).toHaveLength(1)
      expect(handshakes[0]?.path).toBe("/responses")
      for (const key of Object.keys(handshakes[0]?.headers ?? {})) {
        expect(key.toLowerCase()).not.toBe("copilot-session-token")
      }
      // 服务端收到的请求帧带原模型，完成事件正常回流
      expect(receivedModels).toEqual(["gpt-test"])
      expect(completed?.response?.model).toBe("gpt-test")
      // 零 HTTP /auto、零 HTTP POST /responses
      expect(httpAutoCount).toBe(0)
      expect(httpResponsesCount).toBe(0)
      expect(httpFusionCount).toBe(0)
      const lines = infoSpy.mock.calls.map((call) => call.map(String).join(" "))
      expect(
        lines.some((line) =>
          [
            "[auto-session]",
            'model="gpt-test"',
            "source=none",
            "expected_discount=0%",
            "reason=websocket",
          ].every((field) => line.includes(field)),
        ),
      ).toBe(true)
      expect(lines.join("\n")).not.toContain("should-not-attach")
      expect(lines.join("\n")).not.toContain("ws-local-fake-token")
    } finally {
      await whenProbeSchedulerIdle()
      globalThis.fetch = originalFetch
      invalidateAutoSession()
      state.accountType = originalState.accountType
      state.copilotApiUrl = originalState.copilotApiUrl
      state.copilotToken = originalState.copilotToken
      state.forceAgent = originalState.forceAgent
      state.copilotTelemetryEnabled = originalState.copilotTelemetryEnabled
      state.models = originalState.models
      state.vsCodeDeviceId = originalState.vsCodeDeviceId
      state.vsCodeVersion = originalState.vsCodeVersion

      await server.stop(true)
      transportSpy.mockRestore()
      infoSpy.mockRestore()
    }
  },
)
