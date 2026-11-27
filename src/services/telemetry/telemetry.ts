import consola from "consola"
import { getConfig } from "~/lib/config"
import { state } from "~/lib/state"

import { getCommonProperties } from "./identity"
import {
  nextUiKind,
  randomFeedbackDelay,
  type UpstreamTelemetryHeaders,
} from "./mock-values"
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  EVENT_AUTH_NEW_TOKEN,
  EVENT_CONVERSATION_ACCEPTED_COPY,
  EVENT_CONVERSATION_ACCEPTED_INSERT,
  EVENT_CONVERSATION_APPLIED_CODEBLOCK,
  EVENT_CONVERSATION_MESSAGE,
  EVENT_EDIT_FEEDBACK,
  EVENT_EDIT_HUNK_ACTION,
  EVENT_EDITING_SESSION_MESSAGE,
  EVENT_GHOST_TEXT_ACCEPTED,
  EVENT_GHOST_TEXT_SHOWN,
  EVENT_INLINE_CONVERSATION_ACCEPT,
  EVENT_INLINE_CONVERSATION_MESSAGE,
  EVENT_PANEL_REQUEST,
  EVENT_REQUEST_SENT,
  EVENT_RESPONSE_ERROR,
  EVENT_RESPONSE_SUCCESS,
  TELEMETRY_ENVELOPE_NAME,
  TELEMETRY_IKEY,
  TELEMETRY_SDK_VERSION,
  parseSku,
  parseTid,
  type TelemetryEnvelope,
  type TelemetryRequestContext,
} from "./types"

// Module-level cached state (internal, not exported)
let _tid: string | null = null
let _endpoint: string = DEFAULT_TELEMETRY_ENDPOINT
let _sku: string = ""
const acceptedCounts = new Map<string, number>()

const buildTelemetryHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
})

function createEnvelope(
  eventName: string,
  properties: Record<string, string>,
  measurements?: Record<string, number>,
): TelemetryEnvelope {
  return {
    ver: 1,
    name: TELEMETRY_ENVELOPE_NAME,
    time: new Date().toISOString(),
    iKey: TELEMETRY_IKEY,
    sampleRate: 100,
    tags: {
      "ai.user.id": _tid ?? "",
      "ai.internal.sdkVersion": TELEMETRY_SDK_VERSION,
    },
    data: {
      baseType: "EventData",
      baseData: {
        ver: 2,
        name: eventName,
        properties: {
          ...getCommonProperties({
            vsCodeVersion: state.vsCodeVersion ?? "",
            sku: _sku,
          }),
          unique_id: crypto.randomUUID(),
          ...properties,
        },
        measurements: { timeSinceIssuedMs: 0, ...measurements },
      },
    },
  }
}

function sendTelemetryEnvelope(
  request: { endpoint: string; headers: Record<string, string> },
  eventName: string,
  envelope: TelemetryEnvelope,
): void {
  fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify([envelope]),
    signal: AbortSignal.timeout(5000),
  })
    .then(async (res) => {
      const text = await res.text().catch(() => null)
      const accepted = parseItemsAccepted(text)

      if (!res.ok) {
        consola.warn(
          "[telemetry] non-200 response:",
          eventName,
          `status=${res.status}`,
        )
        return
      }
      if (accepted === null) {
        consola.warn(
          "[telemetry] missing itemsAccepted:",
          eventName,
          `body=${text}`,
        )
      } else if (accepted <= 0) {
        consola.warn("[telemetry] rejected:", eventName, `accepted=${accepted}`)
      } else {
        const count = (acceptedCounts.get(eventName) ?? 0) + 1
        acceptedCounts.set(eventName, count)
        if (count === 1 || count % 10 === 0) {
          consola.info("[telemetry] accepted:", eventName, `count=${count}`)
        }
      }
    })
    .catch((err: unknown) => {
      consola.warn(
        "[telemetry] send failed",
        err instanceof Error ? err.message : String(err),
      )
    })
}

function parseItemsAccepted(text: string | null): number | null {
  if (!text) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null
  }

  const accepted = (parsed as { itemsAccepted?: unknown }).itemsAccepted
  return typeof accepted === "number" ? accepted : null
}

/**
 * Initialize telemetry with Copilot token and optional endpoint.
 * Called from token.ts after token refresh.
 */
export function initTelemetry(copilotToken: string, endpoint?: string): void {
  _tid = parseTid(copilotToken)
  _sku = parseSku(copilotToken)
  const base = endpoint ?? DEFAULT_TELEMETRY_ENDPOINT
  const normalizedEndpoint =
    base.endsWith("/telemetry") ? base : `${base}/telemetry`
  _endpoint = normalizedEndpoint
  acceptedCounts.clear()
}

function trackEventWithOptions(options: {
  eventName: string
  properties: Record<string, string>
  measurements?: Record<string, number>
  sampled: boolean
}): void {
  if (getConfig().telemetry !== true || !options.sampled) return

  sendTelemetryEnvelope(
    { endpoint: _endpoint, headers: buildTelemetryHeaders() },
    options.eventName,
    createEnvelope(options.eventName, options.properties, options.measurements),
  )
}

/**
 * Send a telemetry event (fire-and-forget).
 * No-op if config.telemetry !== true (default: disabled).
 */
export function trackEvent(
  eventName: string,
  properties: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  if (getConfig().telemetry !== true) return

  trackEventWithOptions({
    eventName,
    properties,
    measurements,
    sampled: Math.random() <= 0.3,
  })
}

function upstreamTelemetryProperties(
  headers: UpstreamTelemetryHeaders,
): Record<string, string> {
  return {
    ...(headers.gitHubRequestId !== undefined ?
      { gitHubRequestId: headers.gitHubRequestId }
    : {}),
    ...(headers.copilotServiceRequestId !== undefined ?
      { copilotServiceRequestId: headers.copilotServiceRequestId }
    : {}),
    ...(headers.gitHubCopilotRequestTe !== undefined ?
      { gitHubCopilotRequestTe: headers.gitHubCopilotRequestTe }
    : {}),
  }
}

function trackContextEvent(
  context: TelemetryRequestContext,
  eventName: string,
  properties: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  trackEventWithOptions({
    eventName,
    properties: {
      conversationId: context.conversationId,
      ...upstreamTelemetryProperties(context),
      ...properties,
    },
    measurements: {
      ...measurements,
      timeSinceIssuedMs: Date.now() - context.issuedAt,
    },
    sampled: context.sampled,
  })
}

// --- Convenience wrappers ---

export function trackRequestSent(options: {
  context: TelemetryRequestContext
  modelCallId?: string
}): void {
  trackContextEvent(
    options.context,
    EVENT_REQUEST_SENT,
    {
      endpoint: "completions",
      engineName: "chat",
      uiKind: nextUiKind(),
      transport: "http",
      headerRequestId: options.context.requestId,
      request_option_model: `"${options.context.model}"`,
      ...(options.modelCallId !== undefined ?
        { modelCallId: options.modelCallId }
      : {}),
    },
    { maxTokenWindow: 128000 },
  )
}

export type TelemetryApiType = "chatCompletions" | "messages" | "responses"

/** Options for tracking a successful response. Callers provide real values. */
export interface TrackResponseSuccessOptions {
  model: string
  apiType?: TelemetryApiType
  durationMs: number
  requestId?: string
  modelCallId?: string
  sampled: boolean
  conversationId: string
  gitHubRequestId?: string
  copilotServiceRequestId?: string
  gitHubCopilotRequestTe?: string
  finishReason?: string
  promptTokens?: number
  completionTokens?: number
  timeToFirstToken?: number
  bytesReceived?: number
}

export function trackResponseSuccess(opts: TrackResponseSuccessOptions): void {
  trackEventWithOptions({
    eventName: EVENT_RESPONSE_SUCCESS,
    properties: {
      model: opts.model,
      modelInvoked: opts.model,
      reason: opts.finishReason ?? "stop",
      source: "panel",
      initiatorType: "user",
      apiType: opts.apiType ?? "chatCompletions",
      requestId: opts.requestId ?? "",
      transport: "http",
      ...(opts.modelCallId !== undefined ?
        { modelCallId: opts.modelCallId }
      : {}),
      conversationId: opts.conversationId,
      ...upstreamTelemetryProperties(opts),
    },
    measurements: {
      totalTokenMax: 128000,
      tokenCountMax: 8192,
      promptTokenCount: opts.promptTokens ?? 0,
      completionTokens: opts.completionTokens ?? 0,
      timeToFirstToken:
        opts.timeToFirstToken
        ?? Math.min(
          opts.durationMs,
          Math.max(1, Math.floor(opts.durationMs / 3)),
        ),
      timeToComplete: opts.durationMs,
      bytesReceived: opts.bytesReceived ?? 0,
      timeSinceIssuedMs: opts.durationMs,
    },
    sampled: opts.sampled,
  })
}

/** Options for tracking an error response. */
export interface TrackResponseErrorOptions {
  model: string
  apiType?: TelemetryApiType
  durationMs: number
  statusCode: number
  requestId?: string
  modelCallId?: string
  sampled: boolean
  conversationId: string
  gitHubRequestId?: string
  copilotServiceRequestId?: string
  gitHubCopilotRequestTe?: string
}

export function trackResponseError(opts: TrackResponseErrorOptions): void {
  trackEventWithOptions({
    eventName: EVENT_RESPONSE_ERROR,
    properties: {
      model: opts.model,
      modelInvoked: opts.model,
      reason: "error",
      source: "panel",
      initiatorType: "user",
      apiType: opts.apiType ?? "chatCompletions",
      requestId: opts.requestId ?? "",
      transport: "http",
      ...(opts.modelCallId !== undefined ?
        { modelCallId: opts.modelCallId }
      : {}),
      conversationId: opts.conversationId,
      ...upstreamTelemetryProperties(opts),
    },
    measurements: {
      duration_ms: opts.durationMs,
      status_code: opts.statusCode,
      timeToComplete: opts.durationMs,
      timeSinceIssuedMs: opts.durationMs,
    },
    sampled: opts.sampled,
  })
}

export function trackAuthNewToken(): void {
  trackEvent(EVENT_AUTH_NEW_TOKEN, {
    telemetryEnabled:
      state.copilotTelemetryEnabled === undefined ?
        ""
      : String(state.copilotTelemetryEnabled),
  })
}

export function trackEditFeedback(
  context: TelemetryRequestContext,
  outcome?: "accepted" | "rejected",
): void {
  const resolvedOutcome =
    outcome ?? (Math.random() < 0.55 ? "accepted" : "rejected")
  trackContextEvent(
    context,
    EVENT_EDIT_FEEDBACK,
    {
      languageId: context.languageId,
      requestId: context.requestId,
      participant: context.participant,
      command: context.mode,
      outcome: resolvedOutcome,
      hasRemainingEdits: "false",
      modelId: context.model,
      mode: context.mode,
    },
    {
      isNotebook: 0,
      isNotebookCell: 0,
      isAgent: context.isAgent,
    },
  )
}

export function trackEditHunkAction(
  context: TelemetryRequestContext,
  outcome?: "accepted" | "rejected",
): void {
  const resolvedOutcome =
    outcome ?? (Math.random() < 0.55 ? "accepted" : "rejected")
  trackContextEvent(
    context,
    EVENT_EDIT_HUNK_ACTION,
    {
      requestId: context.requestId,
      languageId: context.languageId,
      outcome: resolvedOutcome,
      modelId: context.model,
      mode: context.mode,
    },
    {
      hasRemainingEdits: 0,
      isNotebook: 0,
      isNotebookCell: 0,
      lineCount: context.lineCount,
      linesAdded: context.linesAdded,
      linesRemoved: context.linesRemoved,
      isAgent: context.isAgent,
    },
  )
}

export function scheduleFeedbackEvents(context: TelemetryRequestContext): void {
  if (
    !context.requestId
    || getConfig().telemetry !== true
    || context.sampled === false
  )
    return

  setTimeout(() => {
    const outcome = Math.random() < 0.55 ? "accepted" : "rejected"
    trackEditFeedback(context, outcome)
    trackEditHunkAction(context, outcome)
  }, randomFeedbackDelay())
}

export function trackPanelRequest(context: TelemetryRequestContext): void {
  trackContextEvent(
    context,
    EVENT_PANEL_REQUEST,
    {
      requestId: context.requestId,
      responseType: "success",
      languageId: context.languageId,
      model: context.model,
      mode: context.mode,
      codeBlocks: JSON.stringify([
        {
          languageId: context.languageId,
          totalLines: context.totalLines,
        },
      ]),
    },
    { isAgent: context.isAgent },
  )
  trackUserConversationMessage(context)
  trackConversationMessage(context)
}

export function trackUserConversationMessage(
  context: TelemetryRequestContext,
): void {
  trackContextEvent(
    context,
    context.mode === "edit" ?
      EVENT_EDITING_SESSION_MESSAGE
    : EVENT_CONVERSATION_MESSAGE,
    {
      source: "user",
      turnIndex: "0",
      headerRequestId: context.requestId,
      uiKind: context.mode === "edit" ? "editingSession" : "panel",
      mode: context.mode,
      languageId: context.languageId,
      offTopic: "false",
    },
    {
      promptTokenLen: Math.max(1, Math.floor(context.totalCharacters / 4)),
      messageCharLen: context.totalCharacters,
    },
  )
}

export function trackConversationMessage(
  context: TelemetryRequestContext,
): void {
  trackContextEvent(
    context,
    context.mode === "edit" ?
      EVENT_EDITING_SESSION_MESSAGE
    : EVENT_CONVERSATION_MESSAGE,
    {
      source: "model",
      turnIndex: "1",
      headerRequestId: context.requestId,
      mode: context.mode,
      languageId: context.languageId,
      codeBlockLanguages: JSON.stringify({
        0: {
          languageId: context.languageId,
          totalLines: context.totalLines,
        },
      }),
    },
    {
      messageCharLen: context.totalCharacters,
      numCodeBlocks: 1,
    },
  )
}

export function trackInlineConversationMessage(
  context: TelemetryRequestContext,
): void {
  trackContextEvent(
    context,
    EVENT_INLINE_CONVERSATION_MESSAGE,
    {
      source: "model",
      headerRequestId: context.requestId,
      mode: "inline",
      languageId: context.languageId,
      codeBlockLanguages: JSON.stringify({
        0: {
          languageId: context.languageId,
          totalLines: context.totalLines,
        },
      }),
    },
    {
      messageCharLen: context.totalCharacters,
      numCodeBlocks: 1,
    },
  )
}

export function trackInlineConversationAccept(
  context: TelemetryRequestContext,
): void {
  trackContextEvent(
    context,
    EVENT_INLINE_CONVERSATION_ACCEPT,
    {
      messageId: context.messageId,
      action: "accept",
      headerRequestId: context.requestId,
      command: "inline",
      participant: "editor",
      languageId: context.languageId,
      mode: "inline",
      model: context.model,
    },
    {
      accepted: 1,
      lineCount: context.lineCount,
      totalLines: context.totalLines,
      editCount: context.editCount,
      editLineCount: context.editLineCount,
      documentLength: context.totalCharacters,
    },
  )
}

export function trackConversationAcceptedCopy(
  context: TelemetryRequestContext,
): void {
  trackContextEvent(
    context,
    EVENT_CONVERSATION_ACCEPTED_COPY,
    {
      codeBlockIndex: "0",
      messageId: context.messageId,
      headerRequestId: context.requestId,
      participant: context.participant,
      languageId: context.languageId,
      modelId: context.model,
      comp_type: "full",
      mode: context.mode,
    },
    {
      totalCharacters: context.totalCharacters,
      totalLines: context.totalLines,
      isAgent: context.isAgent,
      copiedCharacters: context.totalCharacters,
      copiedLines: context.totalLines,
    },
  )
}

export function trackConversationAcceptedInsert(
  context: TelemetryRequestContext,
): void {
  trackContextEvent(
    context,
    EVENT_CONVERSATION_ACCEPTED_INSERT,
    {
      codeBlockIndex: "0",
      messageId: context.messageId,
      headerRequestId: context.requestId,
      participant: context.participant,
      languageId: context.languageId,
      modelId: context.model,
      comp_type: "full",
      mode: context.mode,
    },
    {
      totalCharacters: context.totalCharacters,
      totalLines: context.totalLines,
      isAgent: context.isAgent,
    },
  )
}

export function trackConversationAppliedCodeblock(
  context: TelemetryRequestContext,
): void {
  trackContextEvent(
    context,
    EVENT_CONVERSATION_APPLIED_CODEBLOCK,
    {
      codeBlockIndex: "0",
      messageId: context.messageId,
      headerRequestId: context.requestId,
      participant: context.participant,
      languageId: context.languageId,
      modelId: context.model,
      mode: context.mode,
    },
    {
      isAgent: context.isAgent,
      totalLines: context.totalLines,
    },
  )
}

export function trackGhostTextShown(context: TelemetryRequestContext): void {
  trackContextEvent(
    context,
    EVENT_GHOST_TEXT_SHOWN,
    {
      headerRequestId: context.requestId,
      languageId: context.languageId,
      reason: "network",
    },
    {
      compCharLen: context.totalCharacters,
      numLines: context.totalLines,
    },
  )
}

export function trackGhostTextAccepted(context: TelemetryRequestContext): void {
  trackContextEvent(
    context,
    EVENT_GHOST_TEXT_ACCEPTED,
    {
      headerRequestId: context.requestId,
      languageId: context.languageId,
      compType: "full",
    },
    {
      compCharLen: context.totalCharacters,
      numLines: context.totalLines,
    },
  )
}

export function schedulePostResponseEvents(
  context: TelemetryRequestContext,
): void {
  if (
    !context.requestId
    || getConfig().telemetry !== true
    || context.sampled === false
  )
    return

  const actionRoll = Math.random()
  const actionType =
    actionRoll < 1 / 3 ? "copy"
    : actionRoll < 2 / 3 ? "insert"
    : "applied"

  setTimeout(() => {
    trackInlineConversationMessage(context)
    trackInlineConversationAccept(context)
    trackGhostTextAccepted(context)

    if (actionType === "copy") {
      trackConversationAcceptedCopy(context)
      return
    }
    if (actionType === "insert") {
      trackConversationAcceptedInsert(context)
      return
    }
    trackConversationAppliedCodeblock(context)
  }, randomFeedbackDelay())
}
