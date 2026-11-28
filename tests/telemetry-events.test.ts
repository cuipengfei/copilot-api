/**
 * Fixed-context GitHub telemetry event payloads.
 */
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

import { state } from "~/lib/state"

import type {
  TelemetryEnvelope,
  TelemetryMode,
  TelemetryRequestContext,
} from "../src/services/telemetry/types"
import {
  clearTelemetryConversations,
  createMockRequestContext,
  extractUpstreamTelemetryHeaders,
  nextMode,
} from "../src/services/telemetry/mock-values"
import {
  initTelemetry,
  scheduleFeedbackEvents,
  schedulePostResponseEvents,
  trackConversationAcceptedCopy,
  trackConversationAcceptedInsert,
  trackConversationAppliedCodeblock,
  trackEditFeedback,
  trackEditHunkAction,
  trackEvent,
  trackGhostTextAccepted,
  trackGhostTextShown,
  trackInlineConversationAccept,
  trackInlineConversationMessage,
  trackPanelRequest,
} from "../src/services/telemetry/telemetry"

type FetchCall = {
  url: string
  options: {
    method: string
    headers: Record<string, string>
    body: string
  }
}

let fetchCalls: Array<FetchCall> = []
let scheduledTimers: Array<{ fn: () => void; delay: number }> = []
let originalFetch: typeof globalThis.fetch
let originalRandom: typeof Math.random
let originalSetTimeout: typeof globalThis.setTimeout

beforeEach(() => {
  mockTelemetryEnabled = true
  clearTelemetryConversations()
  state.vsCodeSessionId = "editor-events"
  fetchCalls = []
  scheduledTimers = []
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
    scheduledTimers.push({ fn, delay: delay ?? 0 })
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
  scheduledTimers = []
  mock.restore()
})

function contextFor(mode: TelemetryMode): TelemetryRequestContext {
  const participant =
    mode === "agent" ? "github.copilot.editsAgent"
    : mode === "edit" ? "github.copilot.editingSession"
    : "github.copilot.default"
  return {
    requestId: `req-${mode}`,
    model: "gpt-5.4",
    sampled: true,
    conversationId: `conversation-${mode}`,
    turnIndex: 0,
    issuedAt: 1000,
    languageId: "typescript",
    mode,
    participant,
    isAgent: mode === "agent" ? 1 : 0,
    messageId: `message-${mode}`,
    clientCompletionId: `completion-${mode}`,
    totalCharacters: 240,
    totalLines: 12,
    lineCount: 20,
    linesAdded: 7,
    linesRemoved: 3,
    editCount: 2,
    editLineCount: 4,
  }
}

function envelopes(): Array<TelemetryEnvelope> {
  return fetchCalls.flatMap((call) => {
    const parsed: unknown = JSON.parse(call.options.body)
    return Array.isArray(parsed) ? (parsed as Array<TelemetryEnvelope>) : []
  })
}

function event(name: string, source?: string): TelemetryEnvelope {
  const match = envelopes().find(
    (envelope) =>
      envelope.data.baseData.name === name
      && (source === undefined
        || envelope.data.baseData.properties.source === source),
  )
  if (!match) throw new TypeError(`${name} envelope missing`)
  return match
}

function eventNames(): Array<string> {
  return envelopes().map((envelope) => envelope.data.baseData.name)
}

async function flushMicrotasks(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  originalSetTimeout(resolve, 20)
  return promise
}

describe("mock telemetry context", () => {
  it.each([
    { roll: 0, mode: "agent" },
    { roll: 0.3, mode: "edit" },
    { roll: 0.6, mode: "ask" },
    { roll: 0.999, mode: "plan" },
  ] as const)("maps random roll $roll to mode $mode", ({ roll, mode }) => {
    Math.random = () => roll
    expect(nextMode()).toBe(mode)
  })

  it("creates one coherent context without resampling related fields", () => {
    Math.random = () => 0
    const context = createMockRequestContext({
      requestId: "req-context",
      model: "gpt-test",
    })
    expect(context).toMatchObject({
      requestId: "req-context",
      model: "gpt-test",
      sampled: true,
      issuedAt: 1025,
      mode: "agent",
      participant: "github.copilot.editsAgent",
      isAgent: 1,
      languageId: "typescript",
      totalCharacters: 50,
      totalLines: 1,
      lineCount: 5,
      linesAdded: 0,
      linesRemoved: 0,
      editCount: 1,
      editLineCount: 1,
      turnIndex: 0,
    })
    expect(context.messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(context.clientCompletionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(context.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(context.conversationId).not.toBe(context.messageId)
  })

  it("shares conversation and advances turns within a session without exposing session ids", () => {
    const first = {
      ...createMockRequestContext({
        requestId: "first",
        model: "gpt-test",
        sessionId: "raw-session-one",
      }),
      sampled: true,
    }
    const second = {
      ...createMockRequestContext({
        requestId: "second",
        model: "gpt-test",
        sessionId: "raw-session-one",
      }),
      sampled: true,
    }
    const separate = {
      ...createMockRequestContext({
        requestId: "separate",
        model: "gpt-test",
        sessionId: "raw-session-two",
      }),
      sampled: true,
    }
    trackPanelRequest(first)
    trackPanelRequest(second)
    trackPanelRequest(separate)

    const messages = envelopes().filter(
      (envelope) =>
        envelope.data.baseData.name === "copilot-chat/conversation.message"
        || envelope.data.baseData.name
          === "copilot-chat/editingSession.message",
    )
    expect(messages).toHaveLength(6)
    const properties = messages.map(
      (message) => message.data.baseData.properties,
    )
    expect(
      properties.map(({ source, turnIndex }) => ({ source, turnIndex })),
    ).toEqual([
      { source: "user", turnIndex: "0" },
      { source: "model", turnIndex: "1" },
      { source: "user", turnIndex: "2" },
      { source: "model", turnIndex: "3" },
      { source: "user", turnIndex: "0" },
      { source: "model", turnIndex: "1" },
    ])
    expect(properties[0].conversationId).toBe(properties[1].conversationId)
    expect(properties[0].conversationId).toBe(properties[2].conversationId)
    expect(properties[0].conversationId).toBe(properties[3].conversationId)
    expect(properties[4].conversationId).toBe(properties[5].conversationId)
    expect(properties[4].conversationId).not.toBe(properties[0].conversationId)
    const payload = JSON.stringify(fetchCalls)
    expect(payload).not.toContain("raw-session-one")
    expect(payload).not.toContain("raw-session-two")
  })

  it("reserves session turns for concurrently created contexts", () => {
    const first = {
      ...createMockRequestContext({
        requestId: "first",
        model: "gpt-test",
        sessionId: "concurrent-session",
      }),
      sampled: true,
    }
    const second = {
      ...createMockRequestContext({
        requestId: "second",
        model: "gpt-test",
        sessionId: "concurrent-session",
      }),
      sampled: true,
    }
    const third = {
      ...createMockRequestContext({
        requestId: "third",
        model: "gpt-test",
        sessionId: "concurrent-session",
      }),
      sampled: true,
    }

    expect(fetchCalls).toHaveLength(0)
    expect([first.turnIndex, second.turnIndex, third.turnIndex]).toEqual([
      0, 2, 4,
    ])
    expect(second.conversationId).toBe(first.conversationId)
    expect(third.conversationId).toBe(first.conversationId)

    trackPanelRequest(third)
    trackPanelRequest(first)
    trackPanelRequest(second)

    const messages = envelopes().filter(
      (envelope) =>
        envelope.data.baseData.name === "copilot-chat/conversation.message"
        || envelope.data.baseData.name
          === "copilot-chat/editingSession.message",
    )
    expect(messages).toHaveLength(6)
    expect(
      messages.map(({ data }) => {
        const { headerRequestId, source, turnIndex, conversationId } =
          data.baseData.properties
        return { headerRequestId, source, turnIndex, conversationId }
      }),
    ).toEqual([
      {
        headerRequestId: "third",
        source: "user",
        turnIndex: "4",
        conversationId: third.conversationId,
      },
      {
        headerRequestId: "third",
        source: "model",
        turnIndex: "5",
        conversationId: third.conversationId,
      },
      {
        headerRequestId: "first",
        source: "user",
        turnIndex: "0",
        conversationId: first.conversationId,
      },
      {
        headerRequestId: "first",
        source: "model",
        turnIndex: "1",
        conversationId: first.conversationId,
      },
      {
        headerRequestId: "second",
        source: "user",
        turnIndex: "2",
        conversationId: second.conversationId,
      },
      {
        headerRequestId: "second",
        source: "model",
        turnIndex: "3",
        conversationId: second.conversationId,
      },
    ])
  })

  it.each([
    { roll: 0, editCount: 1, editLineCount: 1 },
    { roll: 0.999, editCount: 5, editLineCount: 100 },
  ])(
    "keeps inline statistics coherent at random boundary $roll",
    ({ roll, editCount, editLineCount }) => {
      Math.random = () => roll
      const context = {
        ...createMockRequestContext({
          requestId: "boundary",
          model: "gpt-test",
        }),
        sampled: true,
      }
      expect(context.editCount).toBe(editCount)
      expect(context.editLineCount).toBe(editLineCount)
      trackInlineConversationMessage(context)
      trackInlineConversationAccept(context)
      const message = event("copilot-chat/inlineConversation.message")
      expect(
        JSON.parse(
          message.data.baseData.properties.codeBlockLanguages ?? "null",
        ),
      ).toEqual({
        0: { languageId: context.languageId, totalLines: context.totalLines },
      })
      const accepted = event("copilot-chat/inlineConversation.accept")
      expect(accepted.data.baseData.measurements).toMatchObject({
        lineCount: context.lineCount,
        totalLines: context.totalLines,
        editCount: context.editCount,
        editLineCount: context.editLineCount,
      })
    },
  )

  it("creates independent conversations when session id is omitted", () => {
    const first = createMockRequestContext({
      requestId: "req-context",
      model: "gpt-test",
    })
    const second = createMockRequestContext({
      requestId: "req-context",
      model: "gpt-test",
    })
    expect(first.conversationId).not.toBe(second.conversationId)
  })
})

describe("upstream telemetry headers", () => {
  it("extracts upstream telemetry headers", () => {
    const headers = new Headers({
      "X-GitHub-Request-Id": "gh-request",
      "X-Request-Id": "server-request",
      "X-Copilot-Service-Request-Id": "service-request",
      "X-GitHub-Copilot-Request-Te": "te-value",
    })
    expect(extractUpstreamTelemetryHeaders(headers)).toEqual({
      gitHubRequestId: "gh-request",
      requestId: "server-request",
      copilotServiceRequestId: "service-request",
      gitHubCopilotRequestTe: "te-value",
    })
  })

  it("omits missing and empty upstream telemetry headers", () => {
    const headers = new Headers({
      "X-GitHub-Request-Id": "gh-only",
      "X-Request-Id": "",
      "X-GitHub-Copilot-Request-Te": "",
    })
    const extracted = extractUpstreamTelemetryHeaders(headers)
    expect(extracted).toEqual({ gitHubRequestId: "gh-only" })
    expect(extracted).not.toHaveProperty("copilotServiceRequestId")
    expect(extracted).not.toHaveProperty("gitHubCopilotRequestTe")
    expect(extractUpstreamTelemetryHeaders(new Headers())).toEqual({})
  })
})

describe("panel and conversation events", () => {
  it.each(["agent", "edit", "ask", "plan"] as const)(
    "keeps %s panel and conversation payloads on one context",
    (mode) => {
      const context = contextFor(mode)
      trackPanelRequest(context)

      const panel = event("copilot-chat/panel_request")
      expect(panel.data.baseData.properties).toMatchObject({
        requestId: context.requestId,
        responseType: "success",
        languageId: context.languageId,
        model: context.model,
        mode: context.mode,
        conversationId: context.conversationId,
      })
      expect(
        JSON.parse(panel.data.baseData.properties.codeBlocks ?? "null"),
      ).toEqual([
        { languageId: context.languageId, totalLines: context.totalLines },
      ])
      expect(panel.data.baseData.measurements).toEqual({
        isAgent: context.isAgent,
        timeSinceIssuedMs: 25,
      })

      const messageName =
        mode === "edit" ?
          "copilot-chat/editingSession.message"
        : "copilot-chat/conversation.message"
      const userMessage = event(messageName, "user")
      expect(userMessage.data.baseData.properties).toMatchObject({
        source: "user",
        turnIndex: "0",
        headerRequestId: context.requestId,
        uiKind: mode === "edit" ? "editingSession" : "conversationPanel",
        mode: context.mode,
        languageId: context.languageId,
        conversationId: context.conversationId,
      })
      expect(userMessage.data.baseData.properties.messageId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
      expect(userMessage.data.baseData.properties.messageId).not.toBe(
        context.messageId,
      )
      expect(userMessage.data.baseData.measurements).toEqual({
        promptTokenLen: 60,
        messageCharLen: context.totalCharacters,
        timeSinceIssuedMs: 25,
      })

      const modelMessage = event(messageName, "model")
      expect(modelMessage.data.baseData.properties).toMatchObject({
        source: "model",
        messageId: context.messageId,
        uiKind: mode === "edit" ? "editingSession" : "conversationPanel",
        headerRequestId: context.requestId,
        mode: context.mode,
        languageId: context.languageId,
        conversationId: context.conversationId,
      })
      expect(
        JSON.parse(
          modelMessage.data.baseData.properties.codeBlockLanguages ?? "null",
        ),
      ).toEqual({
        0: { languageId: context.languageId, totalLines: context.totalLines },
      })
      expect(modelMessage.data.baseData.measurements).toEqual({
        messageCharLen: context.totalCharacters,
        numCodeBlocks: 1,
        timeSinceIssuedMs: 25,
      })
    },
  )
})

describe("context sampling", () => {
  it("sampled context events ignore later random rolls", () => {
    const context = {
      ...contextFor("ask"),
      gitHubRequestId: "gh-request",
      copilotServiceRequestId: "service-request",
      gitHubCopilotRequestTe: "te-value",
    }
    Math.random = () => 0.99
    trackPanelRequest(context)
    trackGhostTextShown(context)
    trackEditFeedback(context, "accepted")
    trackEditHunkAction(context, "accepted")

    expect(eventNames()).toEqual([
      "copilot-chat/panel_request",
      "copilot-chat/conversation.message",
      "copilot-chat/conversation.message",
      "copilot/ghostText.shown",
      "copilot-chat/panel.edit.feedback",
      "copilot-chat/edit.hunk.action",
    ])
    expect(event("copilot-chat/conversation.message", "user")).toBeDefined()
    expect(event("copilot-chat/conversation.message", "model")).toBeDefined()
    for (const envelope of envelopes()) {
      expect(envelope.data.baseData.properties).toMatchObject({
        conversationId: context.conversationId,
        gitHubRequestId: context.gitHubRequestId,
        copilotServiceRequestId: context.copilotServiceRequestId,
        gitHubCopilotRequestTe: context.gitHubCopilotRequestTe,
      })
    }
  })

  it("unsampled context events send nothing and schedule no timers", () => {
    const context = { ...contextFor("ask"), sampled: false }
    Math.random = () => 0.01
    trackPanelRequest(context)
    trackGhostTextShown(context)
    trackEditFeedback(context, "accepted")
    scheduleFeedbackEvents(context)
    schedulePostResponseEvents(context)

    expect(fetchCalls).toHaveLength(0)
    expect(scheduledTimers).toHaveLength(0)
  })
})

describe("ghost text events", () => {
  it("uses shared context for shown and accepted payloads", () => {
    const context = contextFor("ask")
    trackGhostTextShown(context)
    trackGhostTextAccepted(context)

    const shown = event("copilot/ghostText.shown")
    expect(shown.data.baseData.properties).toMatchObject({
      headerRequestId: context.requestId,
      languageId: context.languageId,
      conversationId: context.conversationId,
      clientCompletionId: context.clientCompletionId,
      completionId: context.clientCompletionId,
      choiceIndex: "0",
      reason: "network",
      sku: "pro",
    })
    expect(shown.data.baseData.measurements).toEqual({
      compCharLen: context.totalCharacters,
      numLines: context.totalLines,
      timeSinceIssuedMs: 25,
    })

    const accepted = event("copilot/ghostText.accepted")
    expect(accepted.data.baseData.properties).toMatchObject({
      headerRequestId: context.requestId,
      languageId: context.languageId,
      conversationId: context.conversationId,
      clientCompletionId: context.clientCompletionId,
      completionId: context.clientCompletionId,
      choiceIndex: "0",
      compType: "full",
      sku: "pro",
    })
    expect(accepted.data.baseData.measurements).toEqual({
      compCharLen: context.totalCharacters,
      numLines: context.totalLines,
      timeSinceIssuedMs: 25,
    })
  })
})

describe("conversation adoption events", () => {
  const actions = [
    {
      name: "copilot-chat/conversation.acceptedCopy",
      track: trackConversationAcceptedCopy,
      measurements: (context: TelemetryRequestContext) => ({
        totalCharacters: context.totalCharacters,
        totalLines: context.totalLines,
        copiedCharacters: context.totalCharacters,
        copiedLines: context.totalLines,
        isAgent: context.isAgent,
        timeSinceIssuedMs: 25,
      }),
      compType: true,
    },
    {
      name: "copilot-chat/conversation.acceptedInsert",
      track: trackConversationAcceptedInsert,
      measurements: (context: TelemetryRequestContext) => ({
        totalCharacters: context.totalCharacters,
        totalLines: context.totalLines,
        isAgent: context.isAgent,
        timeSinceIssuedMs: 25,
      }),
      compType: true,
    },
    {
      name: "copilot-chat/conversation.appliedCodeblock",
      track: trackConversationAppliedCodeblock,
      measurements: (context: TelemetryRequestContext) => ({
        isAgent: context.isAgent,
        totalLines: context.totalLines,
        timeSinceIssuedMs: 25,
      }),
      compType: false,
    },
  ]

  for (const action of actions) {
    it(`sends ${action.name} with shared context`, () => {
      const context = contextFor("edit")
      action.track(context)

      const payload = event(action.name)
      expect(payload.data.baseData.properties).toMatchObject({
        codeBlockIndex: "0",
        messageId: context.messageId,
        headerRequestId: context.requestId,
        participant: context.participant,
        languageId: context.languageId,
        modelId: context.model,
        mode: context.mode,
        conversationId: context.conversationId,
      })
      if (action.compType) {
        expect(payload.data.baseData.properties.comp_type).toBe("full")
      } else {
        expect(payload.data.baseData.properties).not.toHaveProperty("comp_type")
      }
      expect(payload.data.baseData.measurements).toEqual(
        action.measurements(context),
      )
    })

    it.each([
      {
        model: "copilot/auto",
        modelInvoked: "actual-model",
        expected: "actual-model",
      },
      {
        model: "copilot/auto",
        modelInvoked: undefined,
        expected: "copilot/auto",
      },
      { model: "copilot/auto", modelInvoked: "", expected: "copilot/auto" },
      {
        model: "gpt-test",
        modelInvoked: "different-model",
        expected: "gpt-test",
      },
    ])(
      `sends ${action.name} modelId for model $model and modelInvoked $modelInvoked`,
      ({ model, modelInvoked, expected }) => {
        const context = { ...contextFor("ask"), model, modelInvoked }
        action.track(context)
        expect(event(action.name).data.baseData.properties.modelId).toBe(
          expected,
        )
      },
    )
  }
})

describe("inline conversation events", () => {
  it("keeps official accept fields and shared context fields", () => {
    const context = contextFor("ask")
    trackInlineConversationMessage(context)
    trackInlineConversationAccept(context)

    const message = event("copilot-chat/inlineConversation.message")
    expect(message.data.baseData.properties).toMatchObject({
      source: "model",
      messageId: context.messageId,
      uiKind: "conversationInline",
      replyType: "inlineEdit",
      turnIndex: "1",
      headerRequestId: context.requestId,
      mode: "inline",
      languageId: context.languageId,
      conversationId: context.conversationId,
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

    const accepted = event("copilot-chat/inlineConversation.accept")
    expect(accepted.data.baseData.properties).toMatchObject({
      messageId: context.messageId,
      action: "accept",
      headerRequestId: context.requestId,
      command: "inline",
      participant: "github.copilot.editor",
      languageId: context.languageId,
      mode: "inline",
      model: context.model,
      conversationId: context.conversationId,
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
  })
})

describe("feedback events", () => {
  it.each(["accepted", "rejected"] as const)(
    "sends feedback and hunk actions for %s",
    (outcome) => {
      const context = contextFor("edit")
      trackEditFeedback(context, outcome)
      trackEditHunkAction(context, outcome)

      const feedback = event("copilot-chat/panel.edit.feedback")
      expect(feedback.data.baseData.properties).toMatchObject({
        languageId: context.languageId,
        requestId: context.requestId,
        participant: context.participant,
        command: context.mode,
        outcome,
        hasRemainingEdits: "false",
        modelId: context.model,
        mode: context.mode,
        conversationId: context.conversationId,
      })
      expect(feedback.data.baseData.measurements).toEqual({
        isNotebook: 0,
        isNotebookCell: 0,
        isAgent: context.isAgent,
        timeSinceIssuedMs: 25,
      })

      const hunk = event("copilot-chat/edit.hunk.action")
      expect(hunk.data.baseData.properties).toMatchObject({
        requestId: context.requestId,
        languageId: context.languageId,
        outcome,
        modelId: context.model,
        mode: context.mode,
        conversationId: context.conversationId,
      })
      expect(hunk.data.baseData.measurements).toEqual({
        hasRemainingEdits: 0,
        isNotebook: 0,
        isNotebookCell: 0,
        lineCount: context.lineCount,
        linesAdded: context.linesAdded,
        linesRemoved: context.linesRemoved,
        isAgent: context.isAgent,
        timeSinceIssuedMs: 25,
      })
    },
  )

  it("defaults feedback and hunk actions to accepted regardless of later random rolls", () => {
    Math.random = () => 0.99
    trackEditFeedback(contextFor("ask"))
    trackEditHunkAction(contextFor("ask"))
    expect(
      event("copilot-chat/panel.edit.feedback").data.baseData.properties
        .outcome,
    ).toBe("accepted")
    expect(
      event("copilot-chat/edit.hunk.action").data.baseData.properties.outcome,
    ).toBe("accepted")
  })

  it("schedules accepted feedback and correlated edit suggestions", async () => {
    const rolls = [0.2, 0.8, 0.1, 0.1]
    Math.random = () => rolls.shift() ?? 0.1
    const context = contextFor("agent")

    scheduleFeedbackEvents(context)

    expect(fetchCalls).toHaveLength(0)
    expect(scheduledTimers).toHaveLength(1)
    expect(scheduledTimers[0].delay).toBeGreaterThanOrEqual(2000)
    expect(scheduledTimers[0].delay).toBeLessThanOrEqual(15000)
    scheduledTimers[0].fn()
    await flushMicrotasks()

    const feedback = event("copilot-chat/panel.edit.feedback")
    const hunk = event("copilot-chat/edit.hunk.action")
    expect(feedback.data.baseData.properties).toMatchObject({
      requestId: context.requestId,
      languageId: context.languageId,
      outcome: "accepted",
    })
    expect(hunk.data.baseData.properties).toMatchObject({
      requestId: context.requestId,
      languageId: context.languageId,
      outcome: "accepted",
    })

    const suggested = event("copilot-chat/vscode.editTelemetry.codeSuggested")
    const accepted = event("copilot-chat/vscode.editTelemetry.codeAccepted")
    const suggestedProperties = suggested.data.baseData.properties
    const acceptedProperties = accepted.data.baseData.properties
    expect(suggestedProperties.suggestionId).toMatch(
      /^sgt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(acceptedProperties.suggestionId).toBe(
      suggestedProperties.suggestionId,
    )
    const eventIdPattern =
      /^evt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(suggestedProperties.eventId).toMatch(eventIdPattern)
    expect(acceptedProperties.eventId).toMatch(eventIdPattern)
    expect(acceptedProperties.eventId).not.toBe(suggestedProperties.eventId)
    for (const properties of [suggestedProperties, acceptedProperties]) {
      expect(properties).toMatchObject({
        presentation: "highlightedEdit",
        feature: "sideBarChat",
        sourceExtensionId: "github.copilot-chat",
        sourceExtensionVersion: properties.common_extversion,
        sourceRequestId: context.requestId,
        conversationId: context.conversationId,
        modelId: context.model,
        modeId: "agent",
        languageId: context.languageId,
      })
      expect(properties.common_extversion).toBeTruthy()
    }
    expect(acceptedProperties).toMatchObject({
      chatSessionId: context.conversationId,
      acceptanceMethod: "accept",
    })
    const counts = {
      editLinesInserted: context.linesAdded,
      editLinesDeleted: context.linesRemoved,
      editCharsInserted: Math.floor(
        (context.totalCharacters * context.linesAdded) / context.lineCount,
      ),
      editCharsDeleted: Math.floor(
        (context.totalCharacters * context.linesRemoved) / context.lineCount,
      ),
    }
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
      expect(suggested.data.baseData.measurements?.[key]).toBe(counts[key])
      expect(
        suggested.data.baseData.measurements?.[key],
      ).toBeGreaterThanOrEqual(0)
      expect(accepted.data.baseData.measurements?.[key]).toBe(
        suggested.data.baseData.measurements?.[key],
      )
    }
  })

  it.each([
    {
      model: "copilot/auto",
      modelInvoked: "actual-model",
      expected: "actual-model",
    },
    {
      model: "copilot/auto",
      modelInvoked: undefined,
      expected: "copilot/auto",
    },
    { model: "copilot/auto", modelInvoked: "", expected: "copilot/auto" },
    { model: "gpt-test", modelInvoked: "actual-model", expected: "gpt-test" },
    {
      model: "copilot/auto",
      modelInvoked: "provider/model",
      expected: "provider/model",
    },
    {
      model: "provider/requested",
      modelInvoked: "different-model",
      expected: "provider/requested",
    },
  ])(
    "uses $expected for feedback modelId",
    async ({ model, modelInvoked, expected }) => {
      const context = { ...contextFor("ask"), model, modelInvoked }
      trackEditFeedback(context, "accepted")
      trackEditHunkAction(context, "accepted")
      expect(
        event("copilot-chat/panel.edit.feedback").data.baseData.properties
          .modelId,
      ).toBe(expected)
      expect(
        event("copilot-chat/edit.hunk.action").data.baseData.properties.modelId,
      ).toBe(expected)

      scheduleFeedbackEvents(context)
      scheduledTimers[0].fn()
      await flushMicrotasks()
      const suggested = event("copilot-chat/vscode.editTelemetry.codeSuggested")
        .data.baseData.properties
      const accepted = event("copilot-chat/vscode.editTelemetry.codeAccepted")
        .data.baseData.properties
      for (const properties of [suggested, accepted]) {
        expect(properties.modelId).toBe(expected.replace(/[/\\]/g, "|"))
        expect(properties.sourceRequestId).toBe(context.requestId)
      }
      expect(accepted.suggestionId).toBe(suggested.suggestionId)
    },
  )

  it.each(["ask", "edit", "agent", "plan"] as const)(
    "uses the %s context for scheduled suggestions",
    async (mode) => {
      const context = contextFor(mode)
      scheduleFeedbackEvents(context)
      expect(scheduledTimers).toHaveLength(1)
      scheduledTimers[0].fn()
      await flushMicrotasks()
      for (const name of [
        "copilot-chat/vscode.editTelemetry.codeSuggested",
        "copilot-chat/vscode.editTelemetry.codeAccepted",
      ]) {
        expect(event(name).data.baseData.properties).toMatchObject({
          modeId: mode === "plan" ? "custom" : mode,
          languageId: context.languageId,
          sourceRequestId: context.requestId,
        })
      }
    },
  )

  it("isolates suggestions between requests and gates all edit events", async () => {
    const first = {
      ...contextFor("ask"),
      requestId: "request-one",
      conversationId: "conversation-one",
    }
    const second = {
      ...contextFor("edit"),
      requestId: "request-two",
      conversationId: "conversation-two",
    }
    scheduleFeedbackEvents(first)
    scheduleFeedbackEvents(second)
    expect(scheduledTimers).toHaveLength(2)
    for (const timer of scheduledTimers) timer.fn()
    await flushMicrotasks()

    const all = envelopes()
    const suggested = all.filter(
      (item) =>
        item.data.baseData.name
        === "copilot-chat/vscode.editTelemetry.codeSuggested",
    )
    const accepted = all.filter(
      (item) =>
        item.data.baseData.name
        === "copilot-chat/vscode.editTelemetry.codeAccepted",
    )
    expect(suggested).toHaveLength(2)
    expect(accepted).toHaveLength(2)
    expect(suggested[0].data.baseData.properties.suggestionId).not.toBe(
      suggested[1].data.baseData.properties.suggestionId,
    )
    for (const context of [first, second]) {
      const suggestion = suggested.find(
        (item) =>
          item.data.baseData.properties.sourceRequestId === context.requestId,
      )
      const acceptance = accepted.find(
        (item) =>
          item.data.baseData.properties.sourceRequestId === context.requestId,
      )
      expect(suggestion).toBeDefined()
      expect(acceptance).toBeDefined()
      expect(acceptance?.data.baseData.properties.suggestionId).toBe(
        suggestion?.data.baseData.properties.suggestionId,
      )
    }
    for (const item of all) {
      for (const key of [
        "common_os",
        "common_platformversion",
        "common_arch",
        "common_cpu",
        "hostname",
      ]) {
        expect(item.data.baseData.properties).not.toHaveProperty(key)
        expect(item.tags).not.toHaveProperty(key)
      }
    }

    fetchCalls = []
    scheduledTimers = []
    scheduleFeedbackEvents({ ...first, sampled: false })
    scheduleFeedbackEvents({ ...first, requestId: "" })
    mockTelemetryEnabled = false
    scheduleFeedbackEvents(second)
    expect(scheduledTimers).toHaveLength(0)
    expect(fetchCalls).toHaveLength(0)
  })

  it("does not schedule for an empty request id or disabled telemetry", () => {
    scheduleFeedbackEvents({ ...contextFor("ask"), requestId: "" })
    mockTelemetryEnabled = false
    scheduleFeedbackEvents(contextFor("ask"))

    expect(scheduledTimers).toHaveLength(0)
    expect(fetchCalls).toHaveLength(0)
  })
})

describe("trackEvent sampling and gating", () => {
  it("sends only events that pass the 30% sampling gate", () => {
    trackEvent("sampled.event", { value: "sent" })
    Math.random = () => 0.95
    trackEvent("skipped.event", { value: "skipped" })

    expect(eventNames()).toEqual(["sampled.event"])
  })

  it("sends nothing when telemetry is disabled", () => {
    mockTelemetryEnabled = false
    trackEvent("disabled.event", {})

    expect(fetchCalls).toHaveLength(0)
  })
})
