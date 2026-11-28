import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"

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

import type {
  TelemetryEnvelope,
  TelemetryRequestContext,
} from "../src/services/telemetry/types"
import {
  initTelemetry,
  schedulePostResponseEvents,
} from "../src/services/telemetry/telemetry"

type FetchCall = {
  url: string
  options: { method: string; headers: Record<string, string>; body: string }
}

let fetchCalls: Array<FetchCall> = []
let timers: Array<{ fn: () => void; delay: number }> = []
let originalFetch: typeof globalThis.fetch
let originalRandom: typeof Math.random
let originalSetTimeout: typeof globalThis.setTimeout

const context: TelemetryRequestContext = {
  requestId: "req-post",
  model: "gpt-5.4",
  sampled: true,
  conversationId: "conversation-post",
  turnIndex: 0,
  issuedAt: 1000,
  gitHubRequestId: "gh-post",
  copilotServiceRequestId: "service-post",
  gitHubCopilotRequestTe: "te-post",
  languageId: "typescript",
  mode: "ask",
  participant: "github.copilot.default",
  clientCompletionId: "completion-post",
  isAgent: 0,
  messageId: "message-post",
  totalCharacters: 240,
  totalLines: 12,
  lineCount: 20,
  linesAdded: 7,
  linesRemoved: 3,
  editCount: 2,
  editLineCount: 4,
}

beforeEach(() => {
  mockTelemetryEnabled = true
  fetchCalls = []
  timers = []
  originalFetch = globalThis.fetch
  originalRandom = Math.random
  originalSetTimeout = globalThis.setTimeout
  Math.random = () => 0.1

  globalThis.fetch = mock((url: string, options: FetchCall["options"]) => {
    fetchCalls.push({ url, options })
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve('{"itemsReceived":1,"itemsAccepted":1}'),
    } as Response)
  }) as unknown as typeof fetch
  globalThis.setTimeout = ((
    fn: Parameters<typeof setTimeout>[0],
    delay?: number,
  ) => {
    if (typeof fn !== "function") {
      throw new TypeError("expected function timer callback")
    }
    timers.push({ fn, delay: delay ?? 0 })
    return 0 as never
  }) as unknown as typeof setTimeout

  initTelemetry("tid=test-user;exp=9999999999;sku=pro")
  spyOn(Date, "now").mockReturnValue(1025)
})

afterEach(() => {
  mockTelemetryEnabled = false
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
  Math.random = originalRandom
  timers = []
  mock.restore()
})

function envelopes(): Array<TelemetryEnvelope> {
  return fetchCalls.flatMap((call) => {
    const parsed: unknown = JSON.parse(call.options.body)
    return Array.isArray(parsed) ? (parsed as Array<TelemetryEnvelope>) : []
  })
}

function event(name: string): TelemetryEnvelope {
  const match = envelopes().find(
    (envelope) => envelope.data.baseData.name === name,
  )
  if (!match) throw new TypeError(`${name} envelope missing`)
  return match
}

function runPostResponseEvents(actionRoll: number): Array<string> {
  Math.random = () => actionRoll
  schedulePostResponseEvents(context)

  expect(fetchCalls).toHaveLength(0)
  expect(timers).toHaveLength(1)
  expect(timers[0].delay).toBeGreaterThanOrEqual(2000)
  expect(timers[0].delay).toBeLessThanOrEqual(15000)
  Math.random = () => 0.1
  timers[0].fn()

  return envelopes().map((envelope) => envelope.data.baseData.name)
}

function expectSharedBaseEvents(): void {
  const message = event("copilot-chat/inlineConversation.message")
  expect(message.data.baseData.properties).toMatchObject({
    conversationId: context.conversationId,
    headerRequestId: context.requestId,
    messageId: context.messageId,
    languageId: context.languageId,
    mode: "inline",
    uiKind: "conversationInline",
    replyType: "inlineEdit",
    turnIndex: "1",
  })
  expect(
    JSON.parse(message.data.baseData.properties.codeBlockLanguages ?? "null"),
  ).toEqual({
    0: { languageId: context.languageId, totalLines: context.totalLines },
  })
  expect(message.data.baseData.measurements).toEqual({
    messageCharLen: context.totalCharacters,
    numCodeBlocks: 1,
    timeSinceIssuedMs: 25,
  })

  const done = event("copilot-chat/inline.done")
  expect(done.data.baseData.properties).toMatchObject({
    requestId: context.requestId,
    conversationId: context.conversationId,
    languageId: context.languageId,
    replyType: "inlineEdit",
    command: "inline",
  })
  expect(done.data.baseData.measurements).toEqual({
    accepted: 1,
    editCount: context.editCount,
    editLineCount: context.editLineCount,
    timeSinceIssuedMs: 25,
  })

  const accepted = event("copilot-chat/inlineConversation.accept")
  expect(accepted.data.baseData.properties).toMatchObject({
    conversationId: context.conversationId,
    headerRequestId: context.requestId,
    messageId: context.messageId,
    model: context.model,
    languageId: context.languageId,
    mode: "inline",
    command: "inline",
    participant: "github.copilot.editor",
    action: "accept",
  })
  expect(accepted.data.baseData.properties).not.toHaveProperty("requestId")
  expect(accepted.data.baseData.measurements).toEqual({
    accepted: 1,
    lineCount: context.lineCount,
    totalLines: context.totalLines,
    editCount: context.editCount,
    editLineCount: context.editLineCount,
    documentLength: context.totalCharacters,
    timeSinceIssuedMs: 25,
  })

  const ghost = event("copilot/ghostText.accepted")
  expect(ghost.data.baseData.properties).toMatchObject({
    conversationId: context.conversationId,
    headerRequestId: context.requestId,
    languageId: context.languageId,
    clientCompletionId: context.clientCompletionId,
    completionId: context.clientCompletionId,
    choiceIndex: "0",
    compType: "full",
  })
  expect(ghost.data.baseData.measurements).toEqual({
    compCharLen: context.totalCharacters,
    numLines: context.totalLines,
    timeSinceIssuedMs: 25,
  })
}

describe("schedulePostResponseEvents", () => {
  it.each([
    {
      name: "copy",
      roll: 0.1,
      eventName: "copilot-chat/conversation.acceptedCopy",
    },
    {
      name: "insert",
      roll: 0.5,
      eventName: "copilot-chat/conversation.acceptedInsert",
    },
    {
      name: "applied",
      roll: 0.95,
      eventName: "copilot-chat/conversation.appliedCodeblock",
    },
  ])("sends base events and the $name adoption path", ({ roll, eventName }) => {
    expect(runPostResponseEvents(roll)).toEqual([
      "copilot-chat/inlineConversation.message",
      "copilot-chat/inline.done",
      "copilot-chat/inlineConversation.accept",
      "copilot/ghostText.accepted",
      eventName,
    ])
    expectSharedBaseEvents()

    const adoption = event(eventName)
    expect(adoption.data.baseData.properties).toMatchObject({
      conversationId: context.conversationId,
      codeBlockIndex: "0",
      messageId: context.messageId,
      headerRequestId: context.requestId,
      participant: context.participant,
      languageId: context.languageId,
      modelId: context.model,
      mode: context.mode,
    })
    if (eventName.endsWith("appliedCodeblock")) {
      expect(adoption.data.baseData.measurements).toEqual({
        isAgent: context.isAgent,
        totalLines: context.totalLines,
        timeSinceIssuedMs: 25,
      })
    } else {
      expect(adoption.data.baseData.measurements).toMatchObject({
        totalCharacters: context.totalCharacters,
        totalLines: context.totalLines,
        isAgent: context.isAgent,
        timeSinceIssuedMs: 25,
      })
    }
    if (eventName.endsWith("acceptedCopy")) {
      expect(adoption.data.baseData.measurements).toMatchObject({
        copiedCharacters: context.totalCharacters,
        copiedLines: context.totalLines,
      })
    }

    for (const envelope of envelopes()) {
      expect(envelope.data.baseData.properties).toMatchObject({
        conversationId: context.conversationId,
        gitHubRequestId: context.gitHubRequestId,
        copilotServiceRequestId: context.copilotServiceRequestId,
        gitHubCopilotRequestTe: context.gitHubCopilotRequestTe,
      })
    }
  })

  it("does not schedule for an empty request id or disabled telemetry", () => {
    schedulePostResponseEvents({ ...context, requestId: "" })
    mockTelemetryEnabled = false
    schedulePostResponseEvents(context)

    expect(timers).toHaveLength(0)
    expect(fetchCalls).toHaveLength(0)
  })

  it("does not schedule for an unsampled request", () => {
    Math.random = () => 0.01
    schedulePostResponseEvents({ ...context, sampled: false })

    expect(timers).toHaveLength(0)
    expect(fetchCalls).toHaveLength(0)
  })
})
