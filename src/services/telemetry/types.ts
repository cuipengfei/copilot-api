// Telemetry instrumentation key (Application Insights)
export const TELEMETRY_IKEY = "7d7048df-6dd0-4048-bb23-b716c1461f8f"

// Application Insights envelope name requires iKey without hyphens
export const TELEMETRY_ENVELOPE_NAME = `Microsoft.ApplicationInsights.${TELEMETRY_IKEY.replaceAll("-", "")}.Event`

// SDK version tag (matches VS Code Copilot extension)
export const TELEMETRY_SDK_VERSION = "javascript:3.3.11"

// Default telemetry endpoint
export const DEFAULT_TELEMETRY_ENDPOINT =
  "https://copilot-telemetry.githubusercontent.com/telemetry"

// VS Code / Microsoft telemetry endpoint used by panel.request-like events
export const MSFT_TELEMETRY_ENDPOINT =
  "https://mobile.events.data.microsoft.com/OneCollector/1.0?cors=true&content-type=application/x-json-stream"

export const MSFT_TELEMETRY_API_KEY =
  "0c6ae279ed8443289764825290e4f9e2-1a736e7c-1324-4338-be46-fc2a58ae4d14-7255"

// Event name constants
export const EVENT_REQUEST_SENT = "copilot-chat/request.sent"
export const EVENT_RESPONSE_SUCCESS = "copilot-chat/response.success"
export const EVENT_RESPONSE_ERROR = "copilot-chat/response.error"
export const EVENT_AUTH_NEW_TOKEN = "copilot-chat/auth.new_token"
export const EVENT_EDIT_FEEDBACK = "copilot-chat/panel.edit.feedback"
export const EVENT_EDIT_HUNK_ACTION = "copilot-chat/edit.hunk.action"
export const EVENT_PANEL_REQUEST = "panel.request"
export const EVENT_GHOST_TEXT_SHOWN = "copilot/ghostText.shown"

// MSFT OneCollector event name constants
export const EVENT_MSFT_RESPONSE_CANCELLED = "response.cancelled"
export const EVENT_MSFT_INLINE_REQUEST = "inline.request"
export const EVENT_MSFT_INLINE_DONE = "inline.done"
export const EVENT_MSFT_INLINE_CONVERSATION_ACCEPT = "inlineConversation.accept"
export const EVENT_MSFT_PANEL_ACTION_COPY = "panel.action.copy"
export const EVENT_MSFT_PANEL_ACTION_INSERT = "panel.action.insert"
export const EVENT_MSFT_PANEL_ACTION_FOLLOWUP = "panel.action.followup"
export const EVENT_MSFT_CONVERSATION_ACCEPTED_COPY = "conversation.acceptedCopy"
export const EVENT_MSFT_CONVERSATION_ACCEPTED_INSERT =
  "conversation.acceptedInsert"
export const EVENT_MSFT_CONVERSATION_APPLIED_CODEBLOCK =
  "conversation.appliedCodeblock"

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

export interface MsftTelemetryEnvelope {
  name: string
  time: string
  ver: string
  iKey: string
  ext: {
    sdk: { ver: string }
    web: { consentDetails: string }
  }
  data: {
    baseData: {
      name: string
      properties: Record<string, string | boolean>
      measurements?: Record<string, number>
    }
  }
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
