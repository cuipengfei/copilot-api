import type { CopilotUsageTokens } from "~/lib/token-usage"
import { normalizeOptionalToken } from "~/lib/token-usage"
import type {
  ResponseCompletedEvent,
  ResponseFailedEvent,
  ResponseIncompleteEvent,
} from "~/lib/types/responses"

type TerminalResponseStreamEvent =
  ResponseCompletedEvent | ResponseIncompleteEvent | ResponseFailedEvent

// 顶层用量为空对象时，使用 response 中的用量数据。
export const resolveResponsesStreamCopilotUsage = (
  responseEvent: TerminalResponseStreamEvent,
): {
  totalNanoAiu: number | undefined
  copilotUsage: CopilotUsageTokens | null
} => {
  const totalNanoAiu = normalizeOptionalToken(
    responseEvent.copilot_usage?.total_nano_aiu
      ?? responseEvent.response.copilot_usage?.total_nano_aiu,
  )
  const topLevelCopilotUsage = responseEvent.copilot_usage
  const copilotUsage =
    topLevelCopilotUsage && Object.keys(topLevelCopilotUsage).length > 0 ?
      topLevelCopilotUsage
    : (responseEvent.response.copilot_usage ?? null)
  return { totalNanoAiu, copilotUsage }
}
