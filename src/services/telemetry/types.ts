// Telemetry instrumentation key (Application Insights)
export const TELEMETRY_IKEY = "7d7048df-6dd0-4048-bb23-b716c1461f8f"

// Application Insights envelope name requires iKey without hyphens
export const TELEMETRY_ENVELOPE_NAME = `Microsoft.ApplicationInsights.${TELEMETRY_IKEY.replaceAll("-", "")}.Event`

// SDK version tag (matches VS Code Copilot extension)
export const TELEMETRY_SDK_VERSION = "javascript:3.3.11"

// Default telemetry endpoint
export const DEFAULT_TELEMETRY_ENDPOINT =
  "https://copilot-telemetry.githubusercontent.com/telemetry"

// Event name constants
export const EVENT_REQUEST_SENT = "copilot-chat/request.sent"
export const EVENT_RESPONSE_SUCCESS = "copilot-chat/response.success"
export const EVENT_RESPONSE_ERROR = "copilot-chat/response.error"
export const EVENT_AUTH_NEW_TOKEN = "copilot-chat/auth.new_token"
export const EVENT_EDIT_FEEDBACK = "copilot-chat/panel.edit.feedback"
export const EVENT_EDIT_HUNK_ACTION = "copilot-chat/edit.hunk.action"
export const EVENT_PANEL_REQUEST = "copilot-chat/panel_request"
export const EVENT_GHOST_TEXT_SHOWN = "copilot/ghostText.shown"
export const EVENT_GHOST_TEXT_ACCEPTED = "copilot/ghostText.accepted"
export const EVENT_CONVERSATION_MESSAGE = "copilot-chat/conversation.message"
export const EVENT_EDITING_SESSION_MESSAGE =
  "copilot-chat/editingSession.message"
export const EVENT_INLINE_CONVERSATION_MESSAGE =
  "copilot-chat/inlineConversation.message"
export const EVENT_INLINE_CONVERSATION_ACCEPT =
  "copilot-chat/inlineConversation.accept"
export const EVENT_INLINE_DONE = "copilot-chat/inline.done"
export const EVENT_CONVERSATION_ACCEPTED_COPY =
  "copilot-chat/conversation.acceptedCopy"
export const EVENT_CONVERSATION_ACCEPTED_INSERT =
  "copilot-chat/conversation.acceptedInsert"
export const EVENT_CONVERSATION_APPLIED_CODEBLOCK =
  "copilot-chat/conversation.appliedCodeblock"

// Application Insights envelope structure
// Reference: .local/telemetry-fixtures/generate_fixtures.py build_envelope()
export interface TelemetryEnvelope {
  ver: number
  name: string
  time: string // ISO 8601
  iKey: string
  sampleRate: number
  tags: Record<string, string>
  data: {
    baseType: "EventData"
    baseData: {
      ver: number
      name: string
      properties: Record<string, string>
      measurements?: Record<string, number>
    }
  }
}

export type TelemetryMode = "agent" | "edit" | "ask" | "plan"

export interface TelemetryRequestContext {
  requestId: string
  model: string
  modelInvoked?: string
  languageId: string
  mode: TelemetryMode
  participant: string
  isAgent: 0 | 1
  messageId: string
  clientCompletionId: string
  totalCharacters: number
  totalLines: number
  lineCount: number
  linesAdded: number
  linesRemoved: number
  editCount: number
  editLineCount: number
  conversationId: string
  turnIndex: number
  sampled: boolean
  issuedAt: number
  gitHubRequestId?: string
  copilotServiceRequestId?: string
  gitHubCopilotRequestTe?: string
}

// Allowed property keys (non-sensitive data only)
export type TelemetryProperties = {
  model?: string
  accountType?: string
  duration_ms?: string
  status_code?: string
  [key: string]: string | undefined
}

// Extract tid field from Copilot token
// Token format: "tid=xxx;exp=xxx;sku=xxx:signature" (not standard JWT)
export function parseTid(token: string): string | null {
  const match = token.match(/(?:^|;)tid=([^;:]+)/)
  return match ? match[1] : null
}

// Extract sku field from Copilot token
// Token format: "tid=xxx;exp=xxx;sku=xxx:signature" (not standard JWT)
export function parseSku(token: string): string {
  const match = token.match(/(?:^|;)sku=([^;:]+)/)
  return match ? match[1] : ""
}
