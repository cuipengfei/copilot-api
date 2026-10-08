import { expect, test } from "bun:test"

import {
  getAutoSessionTokenForModel,
  invalidateAutoSession,
  registerAutoSelection,
} from "../src/lib/auto-session"
import { state } from "../src/lib/state"
import { createResponses } from "../src/services/copilot/create-responses"

// 真实 wire 负例：用本机 Bun.serve 的 WebSocket 升级握手验证 WS 分支
// 不附带 Copilot-Session-Token。须在无外部路由的网络命名空间内运行
//（生产连接被 namespace 禁止，loopback 可用）。
const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  forceAgent: state.forceAgent,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeVersion: state.vsCodeVersion,
}

test("Responses websocket handshake against real Bun.serve omits auto session token", async () => {
  const handshakes: Array<{ path: string; headers: Record<string, string> }> =
    []
  const receivedModels: Array<string> = []
  let httpAutoCount = 0
  let httpResponsesCount = 0

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
      if (url.pathname === "/responses") httpResponsesCount += 1
      return new Response("unexpected http", { status: 500 })
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

  state.accountType = "individual"
  state.copilotApiUrl = `http://127.0.0.1:${server.port}`
  state.copilotToken = "ws-local-fake-token"
  state.forceAgent = false
  state.vsCodeDeviceId = "device-1"
  state.vsCodeVersion = "1.120.0"

  registerAutoSelection({
    selected_model: {
      id: "gpt-test",
      supported_endpoints: ["/responses", "ws:/responses"],
    },
    session_token: "ws-should-not-attach",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  })
  try {
    // 配对确实可用（HTTP /responses 维度）：负例针对的是 WS 分支不附加
    expect(await getAutoSessionTokenForModel("gpt-test", "/responses")).toBe(
      "ws-should-not-attach",
    )

    const stream = (await createResponses(
      { input: "hello", model: "gpt-test", stream: true },
      {
        initiator: "user",
        requestId: "ws-local-1",
        transport: "websocket",
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
  } finally {
    invalidateAutoSession()
    state.accountType = originalState.accountType
    state.copilotApiUrl = originalState.copilotApiUrl
    state.copilotToken = originalState.copilotToken
    state.forceAgent = originalState.forceAgent
    state.vsCodeDeviceId = originalState.vsCodeDeviceId
    state.vsCodeVersion = originalState.vsCodeVersion

    await server.stop(true)
  }
})
