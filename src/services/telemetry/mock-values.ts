// Synthetic telemetry values only.

import type { TelemetryMode, TelemetryRequestContext } from "./types"

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
const UI_KINDS = ["panel", "inline", "terminal", "notebook"]
const MODES = ["agent", "edit", "ask"] as const

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
 *  lineCountDiff: 0-20
 *  editCount: 1-5
 */
export function randomInlineStats(): {
  lineCountDiff: number
  editCount: number
} {
  const editCount = Math.floor(Math.random() * 5) + 1 // 1-5
  const lineCountDiff = Math.floor(Math.random() * 21) // 0-20
  return { lineCountDiff, editCount }
}

export function createMockRequestContext(
  requestId: string,
  model: string,
): TelemetryRequestContext {
  const mode = nextMode()
  const languageId = nextLanguageId()
  const { characterCount, lineCount: totalLines } = randomCodeBlockStats()
  const { lineCount, linesAdded, linesRemoved } = randomLineStats()
  const { editCount, lineCountDiff } = randomInlineStats()
  const messageId = randomMessageId()

  return {
    requestId,
    model,
    mode,
    languageId,
    participant:
      mode === "agent" ? "editsAgent"
      : mode === "edit" ? "editingSession"
      : "default",
    isAgent: mode === "agent" ? 1 : 0,
    messageId,
    totalCharacters: characterCount,
    totalLines,
    lineCount,
    linesAdded,
    linesRemoved,
    editCount,
    editLineCount: lineCountDiff,
  }
}
