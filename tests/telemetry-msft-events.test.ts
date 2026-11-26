import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

const requestMock = mock(() =>
  Promise.resolve({
    statusCode: 200,
    body: {
      text: () => Promise.resolve('{"acc":1}'),
    },
  }),
)

void mock.module("undici", () => ({
  request: requestMock,
}))

let mockTelemetryEnabled: boolean | undefined = false

const codexToolPrompt = `
## Tool use
- You have access to many tools. If a tool exists to perform a specific task, you MUST use that tool instead of running a terminal command to perform that task.
### Bash tool
When using the Bash tool, follow these rules:
- always run_in_background set to false, unless you are running a long-running command (e.g., a server or a watch command).
### BashOutput tool
When using the BashOutput tool, follow these rules:
- Only Bash Tool run_in_background set to true, Use BashOutput to read the output later
### TodoWrite tool
When using the TodoWrite tool, follow these rules:
- Skip using the TodoWrite tool for tasks with three or fewer steps.
- Do not make single-step todo lists.
- When you made a todo, update it after having performed one of the sub-tasks that you shared on the todo list.
## Special user requests
- If the user makes a simple request (such as asking for the time) which you can fulfill by running a terminal command (such as 'date'), you should do so.
`

function getMockConfig(): {
  telemetry: boolean | undefined
  extraPrompts: Record<string, string>
  smallModel: string
  modelReasoningEfforts: Record<string, string>
  compactUseSmallModel: boolean
} {
  return {
    telemetry: mockTelemetryEnabled,
    extraPrompts: {
      "gpt-5-codex": codexToolPrompt,
      "gpt-5.4": "## Intermediary updates",
    },
    smallModel: "gpt-5-mini",
    modelReasoningEfforts: { "gpt-5-mini": "low" },
    compactUseSmallModel: true,
  }
}

void mock.module("~/lib/config", () => ({
  getConfig: getMockConfig,
  getExtraPromptForModel: (model: string): string =>
    getMockConfig().extraPrompts[model] ?? "",
  getSmallModel: (): string => getMockConfig().smallModel,
  getReasoningEffortForModel: (model: string): string =>
    getMockConfig().modelReasoningEfforts[model] ?? "high",
  shouldCompactUseSmallModel: (): boolean =>
    getMockConfig().compactUseSmallModel,
  mergeConfigWithDefaults: getMockConfig,
}))

import { state } from "../src/lib/state"
import {
  initTelemetry,
  schedulePostResponseEvents,
  trackConversationAcceptedCopy,
  trackConversationAcceptedInsert,
  trackConversationAppliedCodeblock,
  trackInlineConversationAccept,
  trackInlineDone,
  trackInlineRequest,
  trackPanelActionCopy,
  trackPanelActionFollowup,
  trackPanelActionInsert,
  trackResponseCancelled,
} from "../src/services/telemetry/telemetry"
import { MSFT_TELEMETRY_ENDPOINT } from "../src/services/telemetry/types"

type MsftPayload = {
  name: string
  data: {
    baseData: {
      name: string
      properties: Record<string, string | boolean>
      measurements?: Record<string, number>
    }
  }
}

type RequestCall = {
  url: string
  options: {
    body: string
    headers?: Record<string, string>
  }
}

let originalRandom: typeof Math.random
let originalSetTimeout: typeof globalThis.setTimeout

beforeEach(() => {
  originalRandom = Math.random
  originalSetTimeout = globalThis.setTimeout
  Math.random = () => 0
  mockTelemetryEnabled = true
  requestMock.mockClear()
  state.copilotTrackingId = undefined
  initTelemetry("tid=test-user;exp=9999999999;sku=pro")
})

afterEach(() => {
  mockTelemetryEnabled = false
  Math.random = originalRandom
  globalThis.setTimeout = originalSetTimeout
  mock.restore()
})

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function getRequestCall(index = 0): RequestCall {
  const call = requestMock.mock.calls.at(index) as Array<unknown> | undefined
  if (!call) {
    throw new TypeError(`request call not found at index ${index}`)
  }

  const [url, options] = call
  if (typeof url !== "string") {
    throw new TypeError("request url missing")
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError("request options missing")
  }

  return url === MSFT_TELEMETRY_ENDPOINT ?
      { url, options: options as RequestCall["options"] }
    : (() => {
        throw new TypeError(`unexpected request url: ${url}`)
      })()
}

function getPayload(index = 0): MsftPayload {
  const call = getRequestCall(index)
  const parsed: unknown = JSON.parse(call.options.body)

  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("MSFT telemetry payload missing")
  }

  return parsed as MsftPayload
}

function getEventNames(): Array<string> {
  return requestMock.mock.calls.map((_, index) => getPayload(index).name)
}

describe("telemetry: MSFT wrappers - response and inline", () => {
  it("omits operating-system fingerprint fields from OneCollector events", async () => {
    trackInlineRequest({ requestId: "req-private", model: "gpt-test" })
    await flushMicrotasks()
    const properties = getPayload().data.baseData.properties
    expect(Object.hasOwn(properties, "common.os")).toBe(false)
    expect(Object.hasOwn(properties, "common.nodeArch")).toBe(false)
    expect(Object.hasOwn(properties, "common.platformversion")).toBe(false)
    expect(properties["common.vscodemachineid"]).toBeString()
    expect(properties["common.devDeviceId"]).toBeString()
  })

  it("trackResponseCancelled sends response.cancelled properties and measurements", async () => {
    trackResponseCancelled({
      requestId: "req-cancel-1",
      command: "apply",
      languageId: "typescript",
      currentTime: 1710000001,
    })
    await flushMicrotasks()

    expect(requestMock).toHaveBeenCalledTimes(1)
    const payload = getPayload()
    expect(payload.name).toBe("response.cancelled")
    expect(payload.data.baseData.name).toBe("response.cancelled")
    expect(payload.data.baseData.properties.requestId).toBe("req-cancel-1")
    expect(payload.data.baseData.properties.command).toBe("apply")
    expect(payload.data.baseData.properties.languageId).toBe("typescript")
    expect(payload.data.baseData.measurements).toEqual({
      current_time: 1710000001,
    })
  })

  it("trackInlineRequest sends inline.request payload with inline stats", async () => {
    trackInlineRequest({
      command: "inline",
      contextTypes: "selection",
      promptTypes: "user:12,assistant:0",
      conversationId: "conv-1",
      requestId: "req-inline-1",
      languageId: "typescript",
      responseType: "success",
      replyType: "message",
      model: "gpt-5.4",
      apiType: "chat_completions",
      diagnosticsProvider: "tsserver",
      diagnosticCodes: "TS2322",
      selectionDiagnosticCodes: "TS2554",
      outcomeAnnotations: "fixed",
      toolCounts: '{"read":1}',
      firstTurn: 1,
      isNotebook: 0,
      withIntentDetection: 1,
      messageTokenCount: 21,
      promptTokenCount: 34,
      responseTokenCount: 55,
      implicitCommand: 0,
      attemptCount: 2,
      selectionLineCount: 3,
      wholeRangeLineCount: 8,
      editCount: 2,
      editLineCount: 4,
      markdownCharCount: 99,
      problemsCount: 1,
      selectionProblemsCount: 1,
      diagnosticsCount: 2,
      selectionDiagnosticsCount: 1,
      timeToRequest: 7,
      timeToFirstToken: 44,
      timeToComplete: 120,
      numToolCalls: 1,
      availableToolCount: 3,
      toolTokenCount: 18,
      userSelectionLength: 26,
      adjustedSelectionLength: 30,
      isBYOK: 0,
      isAuto: 1,
    })
    await flushMicrotasks()

    const payload = getPayload()
    expect(payload.name).toBe("inline.request")
    expect(payload.data.baseData.properties.conversationId).toBe("conv-1")
    expect(payload.data.baseData.properties.requestId).toBe("req-inline-1")
    expect(payload.data.baseData.properties.languageId).toBe("typescript")
    expect(payload.data.baseData.properties.model).toBe("gpt-5.4")
    expect(payload.data.baseData.properties.toolCounts).toBe('{"read":1}')
    expect(payload.data.baseData.measurements).toMatchObject({
      messageTokenCount: 21,
      promptTokenCount: 34,
      responseTokenCount: 55,
      editCount: 2,
      editLineCount: 4,
      markdownCharCount: 99,
      timeToRequest: 7,
      timeToFirstToken: 44,
      timeToComplete: 120,
      numToolCalls: 1,
      availableToolCount: 3,
      toolTokenCount: 18,
      userSelectionLength: 26,
      adjustedSelectionLength: 30,
      isAuto: 1,
    })
  })

  it("trackInlineDone sends inline.done acceptance measurements", async () => {
    trackInlineDone({
      languageId: "python",
      replyType: "message",
      conversationId: "conv-2",
      requestId: "req-inline-done-1",
      command: "inline",
      accepted: 1,
      selectionLineCount: 2,
      wholeRangeLineCount: 6,
      editCount: 3,
      editLineCount: 5,
      problemsCount: 0,
      selectionProblemsCount: 0,
      diagnosticsCount: 1,
      selectionDiagnosticsCount: 1,
      isNotebook: 0,
    })
    await flushMicrotasks()

    const payload = getPayload()
    expect(payload.name).toBe("inline.done")
    expect(payload.data.baseData.properties.languageId).toBe("python")
    expect(payload.data.baseData.properties.conversationId).toBe("conv-2")
    expect(payload.data.baseData.properties.requestId).toBe("req-inline-done-1")
    expect(payload.data.baseData.measurements).toMatchObject({
      accepted: 1,
      selectionLineCount: 2,
      wholeRangeLineCount: 6,
      editCount: 3,
      editLineCount: 5,
      diagnosticsCount: 1,
      selectionDiagnosticsCount: 1,
    })
  })

  it("trackInlineConversationAccept sends inlineConversation.accept payload", async () => {
    trackInlineConversationAccept({
      requestId: "req-inline-accept-1",
      headerRequestId: "req-inline-accept-1",
      command: "ask",
      participant: "workspace",
      languageId: "go",
      mode: "ask",
      model: "gpt-5.4",
      apiType: "chat_completions",
      responseType: "success",
      conversationId: "conv-3",
      responseId: "resp-3",
      messageId: "msg-3",
      copilotTrackingId: "track-3",
      reason: "accepted",
      replyType: "inlineEdit",
      currentTime: 1710000003,
      timeToComplete: 245,
      timeToFirstToken: 81,
      accepted: 1,
      codeBlockIndex: 0,
      characterCount: 128,
      lineCount: 8,
      totalLines: 10,
      copiedLines: 7,
      copiedCharacters: 120,
      selectionLineCount: 4,
      wholeRangeLineCount: 10,
      editCount: 2,
      editLineCount: 3,
      isNotebook: 0,
      isNotebookCell: 0,
    })
    await flushMicrotasks()

    const payload = getPayload()
    expect(payload.name).toBe("inlineConversation.accept")
    expect(payload.data.baseData.properties.requestId).toBe(
      "req-inline-accept-1",
    )
    expect(payload.data.baseData.properties.messageId).toBe("msg-3")
    expect(payload.data.baseData.properties.copilot_trackingId).toBe("track-3")
    expect(payload.data.baseData.properties.replyType).toBe("inlineEdit")
    expect(payload.data.baseData.measurements).toMatchObject({
      current_time: 1710000003,
      timeToComplete: 245,
      timeToFirstToken: 81,
      accepted: 1,
      characterCount: 128,
      lineCount: 8,
      totalLines: 10,
      copiedLines: 7,
      copiedCharacters: 120,
      editCount: 2,
      editLineCount: 3,
    })
  })

  it("trackInlineConversationAccept falls back to cached copilot tracking id", async () => {
    state.copilotTrackingId = "state-track-id"

    trackInlineConversationAccept({
      requestId: "req-inline-accept-2",
      headerRequestId: "req-inline-accept-2",
      conversationId: "conv-4",
      responseId: "resp-4",
      messageId: "msg-4",
    })
    await flushMicrotasks()

    const payload = getPayload()
    expect(payload.name).toBe("inlineConversation.accept")
    expect(payload.data.baseData.properties.copilot_trackingId).toBe(
      "state-track-id",
    )
  })
})

describe("telemetry: MSFT wrappers - panel actions", () => {
  it("trackPanelActionCopy sends panel.action.copy code block stats", async () => {
    trackPanelActionCopy({
      languageId: "rust",
      requestId: "req-copy-1",
      participant: "terminal",
      command: "ask",
      codeBlockIndex: 2,
      copyType: 1,
      characterCount: 144,
      lineCount: 9,
    })
    await flushMicrotasks()

    const payload = getPayload()
    expect(payload.name).toBe("panel.action.copy")
    expect(payload.data.baseData.properties.languageId).toBe("rust")
    expect(payload.data.baseData.properties.participant).toBe("terminal")
    expect(payload.data.baseData.measurements).toEqual({
      codeBlockIndex: 2,
      copyType: 1,
      characterCount: 144,
      lineCount: 9,
    })
  })

  it("trackPanelActionInsert sends panel.action.insert insert stats", async () => {
    trackPanelActionInsert({
      languageId: "java",
      requestId: "req-insert-1",
      participant: "workspace",
      command: "ask",
      codeBlockIndex: 1,
      characterCount: 222,
      newFile: 0,
    })
    await flushMicrotasks()

    const payload = getPayload()
    expect(payload.name).toBe("panel.action.insert")
    expect(payload.data.baseData.properties.requestId).toBe("req-insert-1")
    expect(payload.data.baseData.properties.participant).toBe("workspace")
    expect(payload.data.baseData.measurements).toEqual({
      codeBlockIndex: 1,
      characterCount: 222,
      newFile: 0,
    })
  })

  it("trackPanelActionFollowup sends panel.action.followup without extra measurements", async () => {
    trackPanelActionFollowup({
      languageId: "markdown",
      requestId: "req-followup-1",
      participant: "search",
      command: "ask",
    })
    await flushMicrotasks()

    const payload = getPayload()
    expect(payload.name).toBe("panel.action.followup")
    expect(payload.data.baseData.properties.languageId).toBe("markdown")
    expect(payload.data.baseData.properties.requestId).toBe("req-followup-1")
    expect(payload.data.baseData.properties.participant).toBe("search")
    expect(payload.data.baseData.measurements).toEqual({})
  })
})

describe("telemetry: MSFT wrappers - conversation actions", () => {
  it("trackConversationAcceptedCopy sends conversation.acceptedCopy payload", async () => {
    trackConversationAcceptedCopy({
      codeBlockIndex: "3",
      messageId: "msg-copy-1",
      headerRequestId: "req-copy-accept-1",
      participant: "workspace",
      languageId: "typescript",
      modelId: "gpt-5.4",
      compType: "full",
      mode: "ask",
      totalCharacters: 512,
      totalLines: 22,
      copiedCharacters: 256,
      copiedLines: 11,
      isAgent: 0,
      cursorLocation: 240,
    })
    await flushMicrotasks()

    const payload = getPayload()
    expect(payload.name).toBe("conversation.acceptedCopy")
    expect(payload.data.baseData.properties.codeBlockIndex).toBe("3")
    expect(payload.data.baseData.properties.messageId).toBe("msg-copy-1")
    expect(payload.data.baseData.properties.modelId).toBe("gpt-5.4")
    expect(payload.data.baseData.properties.comp_type).toBe("full")
    expect(payload.data.baseData.measurements).toEqual({
      totalCharacters: 512,
      totalLines: 22,
      copiedCharacters: 256,
      copiedLines: 11,
      isAgent: 0,
      cursorLocation: 240,
    })
  })

  it("trackConversationAcceptedInsert sends conversation.acceptedInsert payload", async () => {
    trackConversationAcceptedInsert({
      codeBlockIndex: "4",
      messageId: "msg-insert-1",
      headerRequestId: "req-insert-accept-1",
      participant: "default",
      languageId: "python",
      modelId: "gpt-5.4",
      compType: "delta",
      mode: "edit",
      totalCharacters: 320,
      totalLines: 14,
      isAgent: 1,
      cursorLocation: 88,
    })
    await flushMicrotasks()

    const payload = getPayload()
    expect(payload.name).toBe("conversation.acceptedInsert")
    expect(payload.data.baseData.properties.codeBlockIndex).toBe("4")
    expect(payload.data.baseData.properties.messageId).toBe("msg-insert-1")
    expect(payload.data.baseData.properties.comp_type).toBe("delta")
    expect(payload.data.baseData.properties.mode).toBe("edit")
    expect(payload.data.baseData.measurements).toEqual({
      totalCharacters: 320,
      totalLines: 14,
      isAgent: 1,
      cursorLocation: 88,
    })
  })

  it("trackConversationAppliedCodeblock sends conversation.appliedCodeblock payload", async () => {
    trackConversationAppliedCodeblock({
      codeBlockIndex: "1",
      messageId: "msg-applied-1",
      headerRequestId: "req-applied-1",
      participant: "testing",
      languageId: "yaml",
      modelId: "gpt-5-mini",
      mode: "ask",
      isAgent: 0,
      totalLines: 16,
    })
    await flushMicrotasks()

    const payload = getPayload()
    expect(payload.name).toBe("conversation.appliedCodeblock")
    expect(payload.data.baseData.properties.codeBlockIndex).toBe("1")
    expect(payload.data.baseData.properties.messageId).toBe("msg-applied-1")
    expect(payload.data.baseData.properties.participant).toBe("testing")
    expect(payload.data.baseData.measurements).toEqual({
      isAgent: 0,
      totalLines: 16,
    })
  })
})

describe("telemetry: schedulePostResponseEvents", () => {
  it("schedules the copy-path MSFT events with staggered delays", async () => {
    const timers: Array<{ fn: () => void; delay: number }> = []

    globalThis.setTimeout = ((
      fn: Parameters<typeof setTimeout>[0],
      ms?: number,
    ) => {
      if (typeof fn !== "function") {
        throw new TypeError("expected function timer callback")
      }
      timers.push({ fn, delay: ms ?? 0 })
      return timers.length as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout

    schedulePostResponseEvents("req-post-1", "gpt-5.4")

    expect(timers.map((timer) => timer.delay)).toEqual([
      2350, 2900, 3450, 4000, 4450,
    ])

    globalThis.setTimeout = originalSetTimeout

    for (const timer of timers) {
      timer.fn()
    }
    await flushMicrotasks()

    expect(getEventNames()).toEqual([
      "inline.request",
      "inline.done",
      "inlineConversation.accept",
      "panel.action.copy",
      "conversation.acceptedCopy",
    ])

    const inlineRequest = getPayload(0)
    expect(inlineRequest.data.baseData.properties.requestId).toBe("req-post-1")
    expect(inlineRequest.data.baseData.properties.model).toBe("gpt-5.4")
    expect(inlineRequest.data.baseData.measurements).toMatchObject({
      editCount: 1,
      editLineCount: 0,
      markdownCharCount: 0,
      timeToFirstToken: 33,
      timeToComplete: 100,
    })

    const copyAction = getPayload(3)
    expect(copyAction.data.baseData.properties.participant).toBe("workspace")
    expect(copyAction.data.baseData.measurements).toEqual({
      codeBlockIndex: 0,
      copyType: 1,
      characterCount: 50,
      lineCount: 1,
    })

    const acceptedCopy = getPayload(4)
    expect(acceptedCopy.data.baseData.properties.headerRequestId).toBe(
      "req-post-1",
    )
    expect(acceptedCopy.data.baseData.properties.modelId).toBe("gpt-5.4")
    expect(acceptedCopy.data.baseData.measurements).toEqual({
      totalCharacters: 50,
      totalLines: 1,
      copiedCharacters: 50,
      copiedLines: 1,
      isAgent: 0,
      cursorLocation: 240,
    })
  })
})
