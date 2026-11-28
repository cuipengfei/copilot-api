// Synthetic telemetry values only.

import type { TelemetryMode, TelemetryRequestContext } from "./types"

export interface UpstreamTelemetryHeaders {
  requestId?: string
  gitHubRequestId?: string
  copilotServiceRequestId?: string
  gitHubCopilotRequestTe?: string
}

export function extractUpstreamTelemetryHeaders(
  headers: Headers,
): UpstreamTelemetryHeaders {
  const requestId = headers.get("x-request-id")
  const gitHubRequestId = headers.get("x-github-request-id") ?? undefined
  const copilotServiceRequestId =
    headers.get("x-copilot-service-request-id") ?? undefined
  const rawTe = headers.get("x-github-copilot-request-te")
  const gitHubCopilotRequestTe = rawTe && rawTe.length > 0 ? rawTe : undefined

  return {
    ...(requestId && { requestId }),
    ...(gitHubRequestId !== undefined && { gitHubRequestId }),
    ...(copilotServiceRequestId !== undefined && { copilotServiceRequestId }),
    ...(gitHubCopilotRequestTe !== undefined && { gitHubCopilotRequestTe }),
  }
}

const LANGUAGE_IDS = [
  "typescript",
  "python",
  "javascript",
  "go",
  "rust",
  "java",
  "cpp",
  "markdown",
  "json",
  "yaml",
]
const UI_KINDS = [
  "conversationPanel",
  "conversationInline",
  "editingSession",
  "editingSessionAgent",
]
const MODES = ["agent", "edit", "ask", "plan"] as const

export function nextLanguageId(): string {
  return LANGUAGE_IDS[Math.floor(Math.random() * LANGUAGE_IDS.length)]
}

export function nextMode(): TelemetryMode {
  return MODES[Math.floor(Math.random() * MODES.length)]
}

export function nextUiKind(): string {
  return UI_KINDS[Math.floor(Math.random() * UI_KINDS.length)]
}

export function randomLineStats(): {
  lineCount: number
  linesAdded: number
  linesRemoved: number
} {
  const lineCount = Math.floor(Math.random() * 196) + 5 // 5-200
  const linesAdded = Math.floor(Math.random() * lineCount)
  const linesRemoved = Math.floor(Math.random() * (lineCount - linesAdded))
  return { lineCount, linesAdded, linesRemoved }
}

export function randomFeedbackDelay(): number {
  return Math.floor(Math.random() * 13001) + 2000 // 2000-15000ms
}

/** UUID v4 for messageId fields (e.g. conversation.appliedCodeblock messageId) */
export function randomMessageId(): string {
  return crypto.randomUUID()
}

const telemetryConversations = new Map<
  string,
  { conversationId: string; nextTurnIndex: number }
>()

export function clearTelemetryConversations(): void {
  telemetryConversations.clear()
}

/** Synthetic code block stats.
 *  characterCount: 50-500
 *  lineCount: 1-30
 */
export function randomCodeBlockStats(): {
  characterCount: number
  lineCount: number
} {
  const lineCount = Math.floor(Math.random() * 30) + 1 // 1-30
  const characterCount = Math.floor(Math.random() * 451) + 50 // 50-500
  return { characterCount, lineCount }
}

/** Synthetic edit stats.
 *  editCount: 1-5
 *  lines per edit: 1-20
 */
export function randomInlineStats(): {
  editLineCount: number
  editCount: number
} {
  const editCount = Math.floor(Math.random() * 5) + 1 // 1-5
  let editLineCount = 0
  for (let i = 0; i < editCount; i++) {
    editLineCount += Math.floor(Math.random() * 20) + 1
  }
  return { editLineCount, editCount }
}

export function createMockRequestContext({
  requestId,
  model,
  sessionId,
}: {
  requestId: string
  model: string
  sessionId?: string
}): TelemetryRequestContext {
  const sampled = Math.random() <= 0.3
  let conversation =
    sessionId ? telemetryConversations.get(sessionId) : undefined
  if (!conversation) {
    conversation = { conversationId: randomMessageId(), nextTurnIndex: 0 }
    if (sessionId) telemetryConversations.set(sessionId, conversation)
  }
  const turnIndex = conversation.nextTurnIndex
  conversation.nextTurnIndex += 2
  const conversationId = conversation.conversationId
  const issuedAt = Date.now()
  const mode = nextMode()
  const languageId = nextLanguageId()
  const { characterCount, lineCount: totalLines } = randomCodeBlockStats()
  const { lineCount, linesAdded, linesRemoved } = randomLineStats()
  const { editCount, editLineCount } = randomInlineStats()
  const messageId = randomMessageId()
  const clientCompletionId = randomMessageId()

  return {
    requestId,
    conversationId,
    turnIndex,
    sampled,
    issuedAt,
    model,
    mode,
    languageId,
    participant:
      mode === "agent" ? "github.copilot.editsAgent"
      : mode === "edit" ? "github.copilot.editingSession"
      : "github.copilot.default",
    isAgent: mode === "agent" ? 1 : 0,
    messageId,
    clientCompletionId,
    totalCharacters: characterCount,
    totalLines,
    lineCount,
    linesAdded,
    linesRemoved,
    editCount,
    editLineCount,
  }
}
