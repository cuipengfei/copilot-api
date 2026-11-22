import consola from "consola"
import { arch, platform, release } from "node:os"
import { request } from "undici"

import { COPILOT_VERSION } from "~/lib/providers/api-config"
import { getConfig } from "~/lib/config"
import { state } from "~/lib/state"

import {
  getCommonProperties,
  getDevDeviceId,
  getMachineId,
  SESSION_ID,
} from "./identity"
import {
  nextUiKind,
  nextLanguageId,
  nextParticipant,
  nextCommand,
  randomLineStats,
  randomFeedbackDelay,
  randomConversationId,
  randomMessageId,
  randomTurnId,
  randomCodeBlockStats,
  randomInlineStats,
  randomTimingMs,
} from "./mock-values"
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  EVENT_AUTH_NEW_TOKEN,
  EVENT_EDIT_FEEDBACK,
  EVENT_EDIT_HUNK_ACTION,
  EVENT_MSFT_CONVERSATION_ACCEPTED_COPY,
  EVENT_MSFT_CONVERSATION_ACCEPTED_INSERT,
  EVENT_MSFT_CONVERSATION_APPLIED_CODEBLOCK,
  EVENT_MSFT_INLINE_CONVERSATION_ACCEPT,
  EVENT_MSFT_INLINE_DONE,
  EVENT_MSFT_INLINE_REQUEST,
  EVENT_MSFT_PANEL_ACTION_COPY,
  EVENT_MSFT_PANEL_ACTION_FOLLOWUP,
  EVENT_MSFT_PANEL_ACTION_INSERT,
  EVENT_MSFT_RESPONSE_CANCELLED,
  EVENT_PANEL_REQUEST,
  EVENT_GHOST_TEXT_SHOWN,
  EVENT_REQUEST_SENT,
  EVENT_RESPONSE_ERROR,
  EVENT_RESPONSE_SUCCESS,
  MSFT_TELEMETRY_API_KEY,
  MSFT_TELEMETRY_ENDPOINT,
  type MsftTelemetryEnvelope,
  TELEMETRY_ENVELOPE_NAME,
  TELEMETRY_IKEY,
  TELEMETRY_SDK_VERSION,
  parseSku,
  parseTid,
  type TelemetryEnvelope,
} from "./types"

/* eslint-disable max-lines -- payload-aligned telemetry wrappers keep this module intentionally verbose */

// Module-level cached state (internal, not exported)
let _tid: string | null = null
let _endpoint: string = DEFAULT_TELEMETRY_ENDPOINT
let _sku: string = ""

const buildTelemetryHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
})

function createMsftEnvelope(
  eventName: string,
  properties: Record<string, string>,
  measurements?: Record<string, number>,
): MsftTelemetryEnvelope {
  const machineId = getMachineId()

  return {
    name: eventName,
    time: new Date(Date.now() - 10).toISOString(),
    ver: "4.0",
    iKey: `o:${MSFT_TELEMETRY_API_KEY.split("-")[0]}`,
    ext: {
      sdk: { ver: "1DS-Web-JS-4.3.10" },
      web: { consentDetails: '{"GPC_DataSharingOptIn":false}' },
    },
    data: {
      baseData: {
        name: eventName,
        properties: {
          ...properties,
          "abexp.assignmentcontext": "",
          "common.os": platform(),
          "common.nodeArch": arch(),
          "common.platformversion": release(),
          "common.telemetryclientversion": "1.5.0",
          "common.extname": "copilot-chat",
          "common.extversion": COPILOT_VERSION,
          "common.vscodemachineid": machineId,
          "common.vscodesessionid": SESSION_ID,
          "common.vscodecommithash": "",
          "common.sqmid": "",
          "common.devDeviceId": getDevDeviceId(),
          "common.vscodeversion": state.vsCodeVersion ?? "",
          "common.vscodereleasedate": "unknown",
          "common.isnewappinstall": false,
          "common.product": "desktop",
          "common.uikind": "desktop",
          "common.remotename": "none",
          version: "PostChannel=4.3.10",
          ...(_tid ? { "common.tid": _tid } : {}),
          ...(_sku ? { "common.sku": _sku } : {}),
        },
        ...(measurements ? { measurements } : {}),
      },
    },
  }
}

function createEnvelope(
  eventName: string,
  properties: Record<string, string>,
  measurements?: Record<string, number>,
): TelemetryEnvelope {
  const machineId = getMachineId()

  return {
    ver: 1,
    name: TELEMETRY_ENVELOPE_NAME,
    time: new Date().toISOString(),
    iKey: TELEMETRY_IKEY,
    sampleRate: 100,
    tags: {
      "ai.user.id": _tid ?? "",
      "ai.session.id": SESSION_ID,
      "ai.internal.sdkVersion": TELEMETRY_SDK_VERSION,
      "ai.cloud.roleInstance": "REDACTED",
    },
    data: {
      baseType: "EventData",
      baseData: {
        ver: 2,
        name: eventName,
        properties: {
          ...getCommonProperties({
            machineId,
            sessionId: SESSION_ID,
            vsCodeVersion: state.vsCodeVersion ?? "",
            sku: _sku,
            organizationList: state.organizationList,
            enterpriseList: state.enterpriseList,
          }),
          ...properties,
        },
        measurements,
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

function parseMsftAccepted(text: string | null): number | null {
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

  const accepted = (parsed as { acc?: unknown }).acc
  return typeof accepted === "number" ? accepted : null
}

async function sendMsftTelemetryEnvelope(
  eventName: string,
  envelope: MsftTelemetryEnvelope,
): Promise<void> {
  const { statusCode, body } = await request(MSFT_TELEMETRY_ENDPOINT, {
    method: "POST",
    headers: {
      "Client-Id": "NO_AUTH",
      "client-version": "1DS-Web-JS-4.3.10",
      apikey: MSFT_TELEMETRY_API_KEY,
      "upload-time": String(Date.now()),
      "time-delta-to-apply-millis": "use-collector-delta",
      "cache-control": "no-cache, no-store",
      "content-type": "application/x-json-stream",
      "User-Agent": `GitHubCopilotChat/${COPILOT_VERSION}`,
    },
    body: JSON.stringify(envelope),
    headersTimeout: 5000,
    bodyTimeout: 5000,
  })
  const text = await body.text().catch(() => null)
  const accepted = parseMsftAccepted(text)

  if (statusCode < 200 || statusCode >= 300) {
    consola.warn(
      "[telemetry] non-200 response:",
      eventName,
      `status=${statusCode}`,
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
  }
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
  if (getConfig().telemetry !== true) {
    return
  }

  if (state.copilotTelemetryEnabled === false) {
    return
  }

  // Sample at 30% to reduce telemetry volume
  if (Math.random() > 0.3) {
    return
  }

  sendTelemetryEnvelope(
    {
      endpoint: _endpoint,
      headers: buildTelemetryHeaders(),
    },
    eventName,
    createEnvelope(eventName, properties, measurements),
  )
}

function trackMsftEvent(
  eventName: string,
  properties: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  if (getConfig().telemetry !== true) {
    return
  }

  if (Math.random() > 0.3) {
    return
  }

  void sendMsftTelemetryEnvelope(
    eventName,
    createMsftEnvelope(eventName, properties, measurements),
  ).catch((err: unknown) => {
    consola.warn(
      "[telemetry] send failed",
      err instanceof Error ? err.message : String(err),
    )
  })
}

function mergeStringDefaults(
  defaults: Record<string, string>,
  overrides: Record<string, string | undefined>,
): Record<string, string> {
  const merged = { ...defaults }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      merged[key] = value
    }
  }
  return merged
}

function mergeNumberDefaults(
  defaults: Record<string, number>,
  overrides: Record<string, number | undefined>,
): Record<string, number> {
  const merged = { ...defaults }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      merged[key] = value
    }
  }
  return merged
}

function withDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value
}

// --- Convenience wrappers ---

// eslint-disable-next-line max-params
export function trackRequestSent(
  model: string,
  accountType: string,
  requestId?: string,
  modelCallId?: string,
): void {
  trackEvent(
    EVENT_REQUEST_SENT,
    {
      model,
      accountType,
      endpoint: "completions",
      engineName: "chat",
      uiKind: nextUiKind(),
      transport: "http",
      headerRequestId: requestId ?? "",
      "request.option.model": `"${model}"`,
      ...(modelCallId !== undefined ? { modelCallId } : {}),
    },
    { maxTokenWindow: 128000 },
  )
}

/** Options for tracking a successful response. Callers provide real values. */
export interface TrackResponseSuccessOptions {
  model: string
  durationMs: number
  requestId?: string
  modelCallId?: string
  finishReason?: string
  promptTokens?: number
  completionTokens?: number
  timeToFirstToken?: number
  bytesReceived?: number
}

export function trackResponseSuccess(opts: TrackResponseSuccessOptions): void {
  trackEvent(
    EVENT_RESPONSE_SUCCESS,
    {
      model: opts.model,
      modelInvoked: opts.model,
      reason: opts.finishReason ?? "stop",
      source: "panel",
      initiatorType: "user",
      apiType: "chat_completions",
      requestId: opts.requestId ?? "",
      transport: "http",
      ...(opts.modelCallId !== undefined ?
        { modelCallId: opts.modelCallId }
      : {}),
    },
    {
      totalTokenMax: 128000,
      tokenCountMax: 8192,
      promptTokenCount: opts.promptTokens ?? 0,
      completionTokens: opts.completionTokens ?? 0,
      timeToFirstToken: opts.timeToFirstToken ?? opts.durationMs,
      timeToComplete: opts.durationMs,
      bytesReceived: opts.bytesReceived ?? 0,
    },
  )
}

/** Options for tracking an error response. */
export interface TrackResponseErrorOptions {
  model: string
  durationMs: number
  statusCode: number
  requestId?: string
  modelCallId?: string
}

export function trackResponseError(opts: TrackResponseErrorOptions): void {
  trackEvent(
    EVENT_RESPONSE_ERROR,
    {
      model: opts.model,
      modelInvoked: opts.model,
      reason: "error",
      source: "panel",
      initiatorType: "user",
      apiType: "chat_completions",
      requestId: opts.requestId ?? "",
      transport: "http",
      ...(opts.modelCallId !== undefined ?
        { modelCallId: opts.modelCallId }
      : {}),
    },
    {
      duration_ms: opts.durationMs,
      status_code: opts.statusCode,
      timeToComplete: opts.durationMs,
    },
  )
}

export function trackAuthNewToken(): void {
  trackEvent(EVENT_AUTH_NEW_TOKEN, {
    trackingId: state.copilotTrackingId ?? "",
    telemetryEnabled:
      state.copilotTelemetryEnabled === undefined ?
        ""
      : String(state.copilotTelemetryEnabled),
  })
}

/** Send panel.edit.feedback event (simulates user accepting/rejecting an edit). */
export function trackEditFeedback(requestId: string): void {
  const outcome = Math.random() < 0.55 ? "accepted" : "rejected"
  trackEvent(
    EVENT_EDIT_FEEDBACK,
    {
      languageId: nextLanguageId(),
      requestId,
      participant: nextParticipant(),
      command: nextCommand(),
      outcome,
      hasRemainingEdits: "false",
    },
    {
      isNotebook: 0,
      isNotebookCell: 0,
    },
  )
}

/** Send edit.hunk.action event (simulates accepting/rejecting a code hunk). */
export function trackEditHunkAction(requestId: string): void {
  const outcome = Math.random() < 0.55 ? "accepted" : "rejected"
  const stats = randomLineStats()
  trackEvent(
    EVENT_EDIT_HUNK_ACTION,
    {
      requestId,
      languageId: nextLanguageId(),
      outcome,
    },
    {
      hasRemainingEdits: 0,
      isNotebook: 0,
      isNotebookCell: 0,
      lineCount: stats.lineCount,
      linesAdded: stats.linesAdded,
      linesRemoved: stats.linesRemoved,
    },
  )
}

/**
 * Schedule delayed feedback events after a successful response.
 * Each event is independently sampled at 30% by trackEvent.
 * Fire-and-forget: no await, no error propagation.
 */
export function scheduleFeedbackEvents(requestId: string): void {
  if (!requestId) return
  // Sampling handled by trackEvent — no additional gate here
  const delayMs = randomFeedbackDelay()
  setTimeout(() => {
    trackEditFeedback(requestId)
    trackEditHunkAction(requestId)
  }, delayMs)
}

/** Options for tracking a panel.request event. */
export interface TrackPanelRequestOptions {
  command?: string
  contextTypes?: string
  promptTypes?: string
  responseType?: string
  languageId?: string
  apiType?: string
  headerRequestId?: string
  modelCallId?: string
}

/** Send panel.request event (fire-and-forget). */
export function trackPanelRequest(opts: TrackPanelRequestOptions): void {
  trackMsftEvent(
    EVENT_PANEL_REQUEST,
    {
      command: opts.command ?? "",
      contextTypes: opts.contextTypes ?? "",
      promptTypes: opts.promptTypes ?? "",
      responseType: opts.responseType ?? "",
      languageId: opts.languageId ?? "",
      apiType: opts.apiType ?? "chat_completions",
      headerRequestId: opts.headerRequestId ?? "",
      ...(opts.modelCallId !== undefined ?
        { modelCallId: opts.modelCallId }
      : {}),
    },
    {
      current_time: Math.floor(Date.now() / 1000),
    },
  )
}

export interface TrackResponseCancelledOptions {
  requestId?: string
  command?: string
  languageId?: string
  currentTime?: number
}

/** Payload: /home/cpf/code-inside/copilot-api/.sis/payloads/msft-response.cancelled.json */
export function trackResponseCancelled(
  opts: TrackResponseCancelledOptions,
): void {
  trackMsftEvent(
    EVENT_MSFT_RESPONSE_CANCELLED,
    {
      requestId: opts.requestId ?? "",
      command: opts.command ?? nextCommand(),
      languageId: opts.languageId ?? nextLanguageId(),
    },
    {
      current_time: opts.currentTime ?? Math.floor(Date.now() / 1000),
    },
  )
}

export interface TrackInlineRequestOptions {
  command?: string
  contextTypes?: string
  promptTypes?: string
  conversationId?: string
  requestId?: string
  languageId?: string
  responseType?: string
  replyType?: string
  model?: string
  apiType?: string
  diagnosticsProvider?: string
  diagnosticCodes?: string
  selectionDiagnosticCodes?: string
  outcomeAnnotations?: string
  toolCounts?: string
  firstTurn?: number
  isNotebook?: number
  withIntentDetection?: number
  messageTokenCount?: number
  promptTokenCount?: number
  responseTokenCount?: number
  implicitCommand?: number
  attemptCount?: number
  selectionLineCount?: number
  wholeRangeLineCount?: number
  editCount?: number
  editLineCount?: number
  markdownCharCount?: number
  problemsCount?: number
  selectionProblemsCount?: number
  diagnosticsCount?: number
  selectionDiagnosticsCount?: number
  timeToRequest?: number
  timeToFirstToken?: number
  timeToComplete?: number
  numToolCalls?: number
  availableToolCount?: number
  toolTokenCount?: number
  userSelectionLength?: number
  adjustedSelectionLength?: number
  isBYOK?: number
  isAuto?: number
}

function buildInlineRequestProperties(
  opts: TrackInlineRequestOptions,
  conversationId: string,
): Record<string, string> {
  return mergeStringDefaults(
    {
      command: "inline",
      contextTypes: "none",
      promptTypes: "user:48,assistant:0",
      conversationId,
      requestId: "",
      languageId: nextLanguageId(),
      responseType: "success",
      replyType: "message",
      model: "gpt-5-mini",
      apiType: "chat_completions",
      diagnosticsProvider: "none",
      diagnosticCodes: "",
      selectionDiagnosticCodes: "",
      outcomeAnnotations: "",
      toolCounts: "{}",
    },
    {
      command: opts.command,
      contextTypes: opts.contextTypes,
      promptTypes: opts.promptTypes,
      requestId: opts.requestId,
      languageId: opts.languageId,
      responseType: opts.responseType,
      replyType: opts.replyType,
      model: opts.model,
      apiType: opts.apiType,
      diagnosticsProvider: opts.diagnosticsProvider,
      diagnosticCodes: opts.diagnosticCodes,
      selectionDiagnosticCodes: opts.selectionDiagnosticCodes,
      outcomeAnnotations: opts.outcomeAnnotations,
      toolCounts: opts.toolCounts,
    },
  )
}

function buildInlineRequestMeasurements(
  opts: TrackInlineRequestOptions,
  inlineStats: ReturnType<typeof randomInlineStats>,
  completionMs: number,
): Record<string, number> {
  return mergeNumberDefaults(
    {
      firstTurn: 1,
      isNotebook: 0,
      withIntentDetection: 0,
      messageTokenCount: 12,
      promptTokenCount: 24,
      responseTokenCount: 36,
      implicitCommand: 1,
      attemptCount: 0,
      selectionLineCount: 1,
      wholeRangeLineCount: 3,
      editCount: inlineStats.editCount,
      editLineCount: inlineStats.lineCountDiff,
      markdownCharCount: inlineStats.charCountDiff,
      problemsCount: 0,
      selectionProblemsCount: 0,
      diagnosticsCount: 0,
      selectionDiagnosticsCount: 0,
      timeToRequest: 5,
      timeToFirstToken: Math.max(10, Math.floor(completionMs / 3)),
      timeToComplete: completionMs,
      numToolCalls: 0,
      availableToolCount: 0,
      toolTokenCount: 0,
      userSelectionLength: 18,
      adjustedSelectionLength: 24,
      isBYOK: 0,
      isAuto: 0,
    },
    {
      firstTurn: opts.firstTurn,
      isNotebook: opts.isNotebook,
      withIntentDetection: opts.withIntentDetection,
      messageTokenCount: opts.messageTokenCount,
      promptTokenCount: opts.promptTokenCount,
      responseTokenCount: opts.responseTokenCount,
      implicitCommand: opts.implicitCommand,
      attemptCount: opts.attemptCount,
      selectionLineCount: opts.selectionLineCount,
      wholeRangeLineCount: opts.wholeRangeLineCount,
      editCount: opts.editCount,
      editLineCount: opts.editLineCount,
      markdownCharCount: opts.markdownCharCount,
      problemsCount: opts.problemsCount,
      selectionProblemsCount: opts.selectionProblemsCount,
      diagnosticsCount: opts.diagnosticsCount,
      selectionDiagnosticsCount: opts.selectionDiagnosticsCount,
      timeToRequest: opts.timeToRequest,
      timeToFirstToken: opts.timeToFirstToken,
      timeToComplete: opts.timeToComplete,
      numToolCalls: opts.numToolCalls,
      availableToolCount: opts.availableToolCount,
      toolTokenCount: opts.toolTokenCount,
      userSelectionLength: opts.userSelectionLength,
      adjustedSelectionLength: opts.adjustedSelectionLength,
      isBYOK: opts.isBYOK,
      isAuto: opts.isAuto,
    },
  )
}

/** Payload: /home/cpf/code-inside/copilot-api/.sis/payloads/msft-inline.request-round2.json */
export function trackInlineRequest(opts: TrackInlineRequestOptions): void {
  const inlineStats = randomInlineStats()
  const completionMs = randomTimingMs()
  const conversationId = withDefault(
    opts.conversationId,
    randomConversationId(),
  )

  trackMsftEvent(
    EVENT_MSFT_INLINE_REQUEST,
    buildInlineRequestProperties(opts, conversationId),
    buildInlineRequestMeasurements(opts, inlineStats, completionMs),
  )
}

export interface TrackInlineDoneOptions {
  languageId?: string
  replyType?: string
  conversationId?: string
  requestId?: string
  command?: string
  accepted?: number
  selectionLineCount?: number
  wholeRangeLineCount?: number
  editCount?: number
  editLineCount?: number
  problemsCount?: number
  selectionProblemsCount?: number
  diagnosticsCount?: number
  selectionDiagnosticsCount?: number
  isNotebook?: number
}

/** Payload: /home/cpf/code-inside/copilot-api/.sis/payloads/msft-inline.done-round2.json */
export function trackInlineDone(opts: TrackInlineDoneOptions): void {
  const inlineStats = randomInlineStats()
  trackMsftEvent(
    EVENT_MSFT_INLINE_DONE,
    {
      languageId: opts.languageId ?? nextLanguageId(),
      replyType: opts.replyType ?? "message",
      conversationId: opts.conversationId ?? randomConversationId(),
      requestId: opts.requestId ?? "",
      command: opts.command ?? "inline",
    },
    {
      accepted: opts.accepted ?? 1,
      selectionLineCount: opts.selectionLineCount ?? 1,
      wholeRangeLineCount: opts.wholeRangeLineCount ?? 3,
      editCount: opts.editCount ?? inlineStats.editCount,
      editLineCount: opts.editLineCount ?? inlineStats.lineCountDiff,
      problemsCount: opts.problemsCount ?? 0,
      selectionProblemsCount: opts.selectionProblemsCount ?? 0,
      diagnosticsCount: opts.diagnosticsCount ?? 0,
      selectionDiagnosticsCount: opts.selectionDiagnosticsCount ?? 0,
      isNotebook: opts.isNotebook ?? 0,
    },
  )
}

export interface TrackInlineConversationAcceptOptions {
  requestId?: string
  headerRequestId?: string
  command?: string
  participant?: string
  languageId?: string
  mode?: string
  model?: string
  apiType?: string
  responseType?: string
  conversationId?: string
  responseId?: string
  messageId?: string
  copilotTrackingId?: string
  reason?: string
  replyType?: string
  currentTime?: number
  timeToComplete?: number
  timeToFirstToken?: number
  accepted?: number
  codeBlockIndex?: number
  characterCount?: number
  lineCount?: number
  totalLines?: number
  copiedLines?: number
  copiedCharacters?: number
  selectionLineCount?: number
  wholeRangeLineCount?: number
  editCount?: number
  editLineCount?: number
  isNotebook?: number
  isNotebookCell?: number
}

function buildInlineConversationAcceptProperties(
  opts: TrackInlineConversationAcceptOptions,
): Record<string, string> {
  const requestId = withDefault(opts.requestId, "")
  const headerRequestId = withDefault(opts.headerRequestId, requestId)

  return mergeStringDefaults(
    {
      requestId,
      headerRequestId,
      command: nextCommand(),
      participant: nextParticipant(),
      languageId: nextLanguageId(),
      mode: "ask",
      model: "gpt-5-mini",
      apiType: "chat_completions",
      responseType: "success",
      conversationId: randomConversationId(),
      responseId: randomTurnId(),
      messageId: randomMessageId(),
      copilot_trackingId: state.copilotTrackingId ?? randomTurnId(),
      reason: "accepted",
      replyType: "inlineEdit",
    },
    {
      command: opts.command,
      participant: opts.participant,
      languageId: opts.languageId,
      mode: opts.mode,
      model: opts.model,
      apiType: opts.apiType,
      responseType: opts.responseType,
      conversationId: opts.conversationId,
      responseId: opts.responseId,
      messageId: opts.messageId,
      copilot_trackingId: opts.copilotTrackingId,
      reason: opts.reason,
      replyType: opts.replyType,
    },
  )
}

function buildInlineConversationAcceptMeasurements(params: {
  opts: TrackInlineConversationAcceptOptions
  inlineStats: ReturnType<typeof randomInlineStats>
  codeStats: ReturnType<typeof randomCodeBlockStats>
  completionMs: number
}): Record<string, number> {
  const { opts, inlineStats, codeStats, completionMs } = params
  const lineCount = withDefault(opts.lineCount, codeStats.lineCount)
  const totalLines = withDefault(opts.totalLines, lineCount + 2)
  const copiedLines = withDefault(opts.copiedLines, Math.max(1, lineCount - 1))
  const characterCount = withDefault(
    opts.characterCount,
    codeStats.characterCount,
  )

  return mergeNumberDefaults(
    {
      current_time: Math.floor(Date.now() / 1000),
      timeToComplete: completionMs,
      timeToFirstToken: Math.max(10, Math.floor(completionMs / 3)),
      accepted: 1,
      codeBlockIndex: 0,
      characterCount,
      lineCount,
      totalLines,
      copiedLines,
      copiedCharacters: Math.max(copiedLines, characterCount - 20),
      selectionLineCount: Math.max(1, lineCount / 2),
      wholeRangeLineCount: totalLines,
      editCount: inlineStats.editCount,
      editLineCount: inlineStats.lineCountDiff,
      isNotebook: 0,
      isNotebookCell: 0,
    },
    {
      current_time: opts.currentTime,
      timeToComplete: opts.timeToComplete,
      timeToFirstToken: opts.timeToFirstToken,
      accepted: opts.accepted,
      codeBlockIndex: opts.codeBlockIndex,
      characterCount: opts.characterCount,
      lineCount: opts.lineCount,
      totalLines: opts.totalLines,
      copiedLines: opts.copiedLines,
      copiedCharacters: opts.copiedCharacters,
      selectionLineCount: opts.selectionLineCount,
      wholeRangeLineCount: opts.wholeRangeLineCount,
      editCount: opts.editCount,
      editLineCount: opts.editLineCount,
      isNotebook: opts.isNotebook,
      isNotebookCell: opts.isNotebookCell,
    },
  )
}

/** Payload: /home/cpf/code-inside/copilot-api/.sis/payloads/msft-inlineConversation.accept-1773755801333.json */
export function trackInlineConversationAccept(
  opts: TrackInlineConversationAcceptOptions,
): void {
  const inlineStats = randomInlineStats()
  const codeStats = randomCodeBlockStats()
  const completionMs = randomTimingMs()

  trackMsftEvent(
    EVENT_MSFT_INLINE_CONVERSATION_ACCEPT,
    buildInlineConversationAcceptProperties(opts),
    buildInlineConversationAcceptMeasurements({
      opts,
      inlineStats,
      codeStats,
      completionMs,
    }),
  )
}

export interface TrackPanelActionCopyOptions {
  languageId?: string
  requestId?: string
  participant?: string
  command?: string
  codeBlockIndex?: number
  copyType?: number
  characterCount?: number
  lineCount?: number
}

/** Payload: /home/cpf/code-inside/copilot-api/.sis/payloads/msft-panel.action.copy-round2.json */
export function trackPanelActionCopy(opts: TrackPanelActionCopyOptions): void {
  const codeStats = randomCodeBlockStats()
  trackMsftEvent(
    EVENT_MSFT_PANEL_ACTION_COPY,
    {
      languageId: opts.languageId ?? nextLanguageId(),
      requestId: opts.requestId ?? "",
      participant: opts.participant ?? nextParticipant(),
      command: opts.command ?? "ask",
    },
    {
      codeBlockIndex: opts.codeBlockIndex ?? 0,
      copyType: opts.copyType ?? 1,
      characterCount: opts.characterCount ?? codeStats.characterCount,
      lineCount: opts.lineCount ?? codeStats.lineCount,
    },
  )
}

export interface TrackPanelActionInsertOptions {
  languageId?: string
  requestId?: string
  participant?: string
  command?: string
  codeBlockIndex?: number
  characterCount?: number
  newFile?: number
}

/** Payload: /home/cpf/code-inside/copilot-api/.sis/payloads/msft-panel.action.insert-round2.json */
export function trackPanelActionInsert(
  opts: TrackPanelActionInsertOptions,
): void {
  const codeStats = randomCodeBlockStats()
  trackMsftEvent(
    EVENT_MSFT_PANEL_ACTION_INSERT,
    {
      languageId: opts.languageId ?? nextLanguageId(),
      requestId: opts.requestId ?? "",
      participant: opts.participant ?? nextParticipant(),
      command: opts.command ?? "ask",
    },
    {
      codeBlockIndex: opts.codeBlockIndex ?? 0,
      characterCount: opts.characterCount ?? codeStats.characterCount,
      newFile: opts.newFile ?? 0,
    },
  )
}

export interface TrackPanelActionFollowupOptions {
  languageId?: string
  requestId?: string
  participant?: string
  command?: string
}

/** Payload: /home/cpf/code-inside/copilot-api/.sis/payloads/msft-panel.action.followup-round2.json */
export function trackPanelActionFollowup(
  opts: TrackPanelActionFollowupOptions,
): void {
  trackMsftEvent(
    EVENT_MSFT_PANEL_ACTION_FOLLOWUP,
    {
      languageId: opts.languageId ?? nextLanguageId(),
      requestId: opts.requestId ?? "",
      participant: opts.participant ?? nextParticipant(),
      command: opts.command ?? "ask",
    },
    {},
  )
}

export interface TrackConversationAcceptedCopyOptions {
  codeBlockIndex?: string
  messageId?: string
  headerRequestId?: string
  participant?: string
  languageId?: string
  modelId?: string
  compType?: string
  mode?: string
  totalCharacters?: number
  totalLines?: number
  copiedCharacters?: number
  copiedLines?: number
  isAgent?: number
  cursorLocation?: number
}

/** Payload: /home/cpf/code-inside/copilot-api/.sis/payloads/msft-conversation.acceptedCopy-round2.json */
export function trackConversationAcceptedCopy(
  opts: TrackConversationAcceptedCopyOptions,
): void {
  const codeStats = randomCodeBlockStats()
  const totalLines = opts.totalLines ?? codeStats.lineCount
  const totalCharacters = opts.totalCharacters ?? codeStats.characterCount
  trackMsftEvent(
    EVENT_MSFT_CONVERSATION_ACCEPTED_COPY,
    {
      codeBlockIndex: opts.codeBlockIndex ?? "0",
      messageId: opts.messageId ?? randomMessageId(),
      headerRequestId: opts.headerRequestId ?? "",
      participant: opts.participant ?? nextParticipant(),
      languageId: opts.languageId ?? nextLanguageId(),
      modelId: opts.modelId ?? "gpt-5-mini",
      comp_type: opts.compType ?? "full",
      mode: opts.mode ?? "ask",
    },
    {
      totalCharacters,
      totalLines,
      copiedCharacters: opts.copiedCharacters ?? totalCharacters,
      copiedLines: opts.copiedLines ?? totalLines,
      isAgent: opts.isAgent ?? 0,
      cursorLocation: opts.cursorLocation ?? 240,
    },
  )
}

export interface TrackConversationAcceptedInsertOptions {
  codeBlockIndex?: string
  messageId?: string
  headerRequestId?: string
  participant?: string
  languageId?: string
  modelId?: string
  compType?: string
  mode?: string
  totalCharacters?: number
  totalLines?: number
  isAgent?: number
  cursorLocation?: number
}

/** Payload: /home/cpf/code-inside/copilot-api/.sis/payloads/msft-conversation.acceptedInsert-round2.json */
export function trackConversationAcceptedInsert(
  opts: TrackConversationAcceptedInsertOptions,
): void {
  const codeStats = randomCodeBlockStats()
  trackMsftEvent(
    EVENT_MSFT_CONVERSATION_ACCEPTED_INSERT,
    {
      codeBlockIndex: opts.codeBlockIndex ?? "0",
      messageId: opts.messageId ?? randomMessageId(),
      headerRequestId: opts.headerRequestId ?? "",
      participant: opts.participant ?? nextParticipant(),
      languageId: opts.languageId ?? nextLanguageId(),
      modelId: opts.modelId ?? "gpt-5-mini",
      comp_type: opts.compType ?? "full",
      mode: opts.mode ?? "ask",
    },
    {
      totalCharacters: opts.totalCharacters ?? codeStats.characterCount,
      totalLines: opts.totalLines ?? codeStats.lineCount,
      isAgent: opts.isAgent ?? 0,
      cursorLocation: opts.cursorLocation ?? 240,
    },
  )
}

export interface TrackConversationAppliedCodeblockOptions {
  codeBlockIndex?: string
  messageId?: string
  headerRequestId?: string
  participant?: string
  languageId?: string
  modelId?: string
  mode?: string
  isAgent?: number
  totalLines?: number
}

type PostResponseActionType = "copy" | "insert" | "followup"

interface PostResponseEventContext {
  requestId: string
  model: string
  baseDelay: number
  languageId: string
  participant: string
  command: string
  conversationId: string
  messageId: string
  responseId: string
  inlineStats: ReturnType<typeof randomInlineStats>
  codeStats: ReturnType<typeof randomCodeBlockStats>
  completionMs: number
}

function createPostResponseEventContext(
  requestId: string,
  model: string,
): PostResponseEventContext {
  return {
    requestId,
    model,
    baseDelay: Math.max(2000, randomFeedbackDelay() - 3000),
    languageId: nextLanguageId(),
    participant: nextParticipant(),
    command: "ask",
    conversationId: randomConversationId(),
    messageId: randomMessageId(),
    responseId: randomTurnId(),
    inlineStats: randomInlineStats(),
    codeStats: randomCodeBlockStats(),
    completionMs: randomTimingMs(),
  }
}

function pickPostResponseActionType(): PostResponseActionType {
  const actionRoll = Math.random()
  if (actionRoll < 0.45) {
    return "copy"
  }
  if (actionRoll < 0.85) {
    return "insert"
  }
  return "followup"
}

function scheduleInlineRequestEvent(context: PostResponseEventContext): void {
  setTimeout(() => {
    trackInlineRequest({
      command: "inline",
      contextTypes: "none",
      promptTypes: "user:48,assistant:0",
      conversationId: context.conversationId,
      requestId: context.requestId,
      languageId: context.languageId,
      responseType: "success",
      replyType: "message",
      model: context.model,
      apiType: "chat_completions",
      diagnosticsProvider: "none",
      toolCounts: "{}",
      editCount: context.inlineStats.editCount,
      editLineCount: context.inlineStats.lineCountDiff,
      markdownCharCount: context.inlineStats.charCountDiff,
      timeToFirstToken: Math.max(10, Math.floor(context.completionMs / 3)),
      timeToComplete: context.completionMs,
    })
  }, context.baseDelay + 350)
}

function scheduleInlineDoneEvent(context: PostResponseEventContext): void {
  setTimeout(() => {
    trackInlineDone({
      languageId: context.languageId,
      replyType: "message",
      conversationId: context.conversationId,
      requestId: context.requestId,
      command: "inline",
      accepted: 1,
      editCount: context.inlineStats.editCount,
      editLineCount: context.inlineStats.lineCountDiff,
      selectionLineCount: 1,
      wholeRangeLineCount: Math.max(3, context.inlineStats.lineCountDiff + 2),
      isNotebook: 0,
    })
  }, context.baseDelay + 900)
}

function scheduleInlineConversationAcceptEvent(
  context: PostResponseEventContext,
): void {
  setTimeout(() => {
    trackInlineConversationAccept({
      requestId: context.requestId,
      headerRequestId: context.requestId,
      command: context.command,
      participant: context.participant,
      languageId: context.languageId,
      mode: "ask",
      model: context.model,
      apiType: "chat_completions",
      responseType: "success",
      conversationId: context.conversationId,
      responseId: context.responseId,
      messageId: context.messageId,
      copilotTrackingId: randomTurnId(),
      reason: "accepted",
      replyType: "inlineEdit",
      timeToComplete: context.completionMs,
      timeToFirstToken: Math.max(10, Math.floor(context.completionMs / 3)),
      accepted: 1,
      codeBlockIndex: 0,
      characterCount: context.codeStats.characterCount,
      lineCount: context.codeStats.lineCount,
      totalLines: context.codeStats.lineCount + 2,
      copiedLines: Math.max(1, context.codeStats.lineCount - 1),
      copiedCharacters: Math.max(
        context.codeStats.lineCount,
        context.codeStats.characterCount - 20,
      ),
      selectionLineCount: Math.max(
        1,
        Math.floor(context.codeStats.lineCount / 2),
      ),
      wholeRangeLineCount: context.codeStats.lineCount + 2,
      editCount: context.inlineStats.editCount,
      editLineCount: context.inlineStats.lineCountDiff,
      isNotebook: 0,
      isNotebookCell: 0,
    })
  }, context.baseDelay + 1450)
}

function scheduleBasePostResponseEvents(
  context: PostResponseEventContext,
): void {
  scheduleInlineRequestEvent(context)
  scheduleInlineDoneEvent(context)
  scheduleInlineConversationAcceptEvent(context)
}

function scheduleCopyPathPostResponseEvents(
  context: PostResponseEventContext,
): void {
  setTimeout(() => {
    trackPanelActionCopy({
      languageId: context.languageId,
      requestId: context.requestId,
      participant: context.participant,
      command: context.command,
      codeBlockIndex: 0,
      copyType: 1,
      characterCount: context.codeStats.characterCount,
      lineCount: context.codeStats.lineCount,
    })
  }, context.baseDelay + 2000)

  setTimeout(() => {
    trackConversationAcceptedCopy({
      codeBlockIndex: "0",
      messageId: context.messageId,
      headerRequestId: context.requestId,
      participant: context.participant,
      languageId: context.languageId,
      modelId: context.model,
      compType: "full",
      mode: "ask",
      totalCharacters: context.codeStats.characterCount,
      totalLines: context.codeStats.lineCount,
      copiedCharacters: context.codeStats.characterCount,
      copiedLines: context.codeStats.lineCount,
      isAgent: 0,
      cursorLocation: 240,
    })
  }, context.baseDelay + 2450)
}

function scheduleInsertPathPostResponseEvents(
  context: PostResponseEventContext,
): void {
  setTimeout(() => {
    trackPanelActionInsert({
      languageId: context.languageId,
      requestId: context.requestId,
      participant: context.participant,
      command: context.command,
      codeBlockIndex: 0,
      characterCount: context.codeStats.characterCount,
      newFile: 0,
    })
  }, context.baseDelay + 2000)

  setTimeout(() => {
    trackConversationAcceptedInsert({
      codeBlockIndex: "0",
      messageId: context.messageId,
      headerRequestId: context.requestId,
      participant: context.participant,
      languageId: context.languageId,
      modelId: context.model,
      compType: "full",
      mode: "ask",
      totalCharacters: context.codeStats.characterCount,
      totalLines: context.codeStats.lineCount,
      isAgent: 0,
      cursorLocation: 240,
    })
  }, context.baseDelay + 2450)

  setTimeout(() => {
    trackConversationAppliedCodeblock({
      codeBlockIndex: "0",
      messageId: context.messageId,
      headerRequestId: context.requestId,
      participant: context.participant,
      languageId: context.languageId,
      modelId: context.model,
      mode: "ask",
      isAgent: 0,
      totalLines: context.codeStats.lineCount,
    })
  }, context.baseDelay + 2850)
}

function scheduleFollowupPathPostResponseEvent(
  context: PostResponseEventContext,
): void {
  setTimeout(() => {
    trackPanelActionFollowup({
      languageId: context.languageId,
      requestId: context.requestId,
      participant: context.participant,
      command: context.command,
    })
  }, context.baseDelay + 2000)
}

/** Payload: /home/cpf/code-inside/copilot-api/.sis/payloads/msft-conversation.appliedCodeblock-round2.json */
export function trackConversationAppliedCodeblock(
  opts: TrackConversationAppliedCodeblockOptions,
): void {
  const codeStats = randomCodeBlockStats()
  trackMsftEvent(
    EVENT_MSFT_CONVERSATION_APPLIED_CODEBLOCK,
    {
      codeBlockIndex: opts.codeBlockIndex ?? "0",
      messageId: opts.messageId ?? randomMessageId(),
      headerRequestId: opts.headerRequestId ?? "",
      participant: opts.participant ?? nextParticipant(),
      languageId: opts.languageId ?? nextLanguageId(),
      modelId: opts.modelId ?? "gpt-5-mini",
      mode: opts.mode ?? "ask",
    },
    {
      isAgent: opts.isAgent ?? 0,
      totalLines: opts.totalLines ?? codeStats.lineCount,
    },
  )
}

/**
 * Schedule delayed post-response MSFT events with staggered timing.
 * This complements scheduleFeedbackEvents and does not replace it.
 */
export function schedulePostResponseEvents(
  requestId: string,
  model: string,
): void {
  if (!requestId) return

  const context = createPostResponseEventContext(requestId, model)
  const actionType = pickPostResponseActionType()

  scheduleBasePostResponseEvents(context)

  if (actionType === "copy") {
    scheduleCopyPathPostResponseEvents(context)
    return
  }

  if (actionType === "insert") {
    scheduleInsertPathPostResponseEvents(context)
    return
  }

  scheduleFollowupPathPostResponseEvent(context)
}

/** Options for tracking a ghostText.shown event. */
export interface TrackGhostTextShownOptions {
  headerRequestId?: string
  copilot_trackingId?: string
  clientCompletionId?: string
  reason?: string
  choiceIndex?: number
  sku?: string
  timeSinceIssuedMs?: number
  timeSinceDisplayedMs?: number
  currentTime?: number
}

/** Send ghostText.shown event (fire-and-forget). */
export function trackGhostTextShown(opts: TrackGhostTextShownOptions): void {
  trackEvent(
    EVENT_GHOST_TEXT_SHOWN,
    {
      headerRequestId: opts.headerRequestId ?? "",
      copilot_trackingId: opts.copilot_trackingId ?? "",
      clientCompletionId: opts.clientCompletionId ?? "",
      reason: opts.reason ?? "",
      choiceIndex:
        opts.choiceIndex !== undefined ? String(opts.choiceIndex) : "",
      ...(opts.sku !== undefined ? { sku: opts.sku } : {}),
    },
    {
      timeSinceIssuedMs: opts.timeSinceIssuedMs ?? 0,
      timeSinceDisplayedMs: opts.timeSinceDisplayedMs ?? 0,
      current_time: opts.currentTime ?? Math.floor(Date.now() / 1000),
    },
  )
}
