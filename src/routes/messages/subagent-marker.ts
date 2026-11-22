import { subagentMarkerPrefix, type SubagentMarker } from "~/lib/http/subagent"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"

export const parseSubagentMarkerFromFirstUser = (
  payload: AnthropicMessagesPayload,
): SubagentMarker | null => {
  const firstUserMessage = payload.messages.find(
    (msg) => msg.role === "user" && Array.isArray(msg.content),
  )
  if (!firstUserMessage || !Array.isArray(firstUserMessage.content)) {
    return null
  }

  for (const block of firstUserMessage.content) {
    if (block.type !== "text") {
      continue
    }

    const marker = parseSubagentMarkerFromSystemReminder(block.text)
    if (marker) {
      return marker
    }
  }

  return null
}

const isValidMarker = (parsed: unknown): parsed is SubagentMarker => {
  if (typeof parsed !== "object" || parsed === null) return false
  const candidate = parsed as Record<string, unknown>
  return (
    typeof candidate.session_id === "string"
    && candidate.session_id.trim().length > 0
    && typeof candidate.agent_id === "string"
    && candidate.agent_id.trim().length > 0
    && typeof candidate.agent_type === "string"
    && candidate.agent_type.trim().length > 0
  )
}

const parseSubagentMarkerFromSystemReminder = (
  text: string,
): SubagentMarker | null => {
  const startTag = "<system-reminder>"
  const endTag = "</system-reminder>"
  let searchFrom = 0

  while (true) {
    const reminderStart = text.indexOf(startTag, searchFrom)
    if (reminderStart === -1) {
      break
    }

    const contentStart = reminderStart + startTag.length
    const reminderEnd = text.indexOf(endTag, contentStart)
    if (reminderEnd === -1) {
      break
    }

    const reminderContent = text.slice(contentStart, reminderEnd)
    const markerIndex = reminderContent.indexOf(subagentMarkerPrefix)
    if (markerIndex === -1) {
      searchFrom = reminderEnd + endTag.length
      continue
    }

    const markerJson = reminderContent
      .slice(markerIndex + subagentMarkerPrefix.length)
      .trim()

    try {
      const parsed: unknown = JSON.parse(markerJson)
      if (!isValidMarker(parsed)) {
        searchFrom = reminderEnd + endTag.length
        continue
      }

      return parsed
    } catch {
      searchFrom = reminderEnd + endTag.length
      continue
    }
  }

  return null
}
