import type { CopilotUsageTokens } from "~/lib/token-usage"
import { normalizeOptionalToken } from "~/lib/token-usage"
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "~/lib/types/responses"

type ResponseWithUsageStreamEvent = Extract<
  ResponseStreamEvent,
  { response: ResponsesResult }
>

// 顶层用量为空对象时，使用 response 中的用量数据。
export const resolveResponsesStreamCopilotUsage = (
  responseEvent: ResponseWithUsageStreamEvent,
): {
  totalNanoAiu: number | undefined
  copilotUsage: CopilotUsageTokens | null
} => {
  const topLevelCopilotUsage =
    "copilot_usage" in responseEvent ? responseEvent.copilot_usage : undefined
  const totalNanoAiu = normalizeOptionalToken(
    topLevelCopilotUsage?.total_nano_aiu
      ?? responseEvent.response.copilot_usage?.total_nano_aiu,
  )
  const copilotUsage =
    topLevelCopilotUsage && Object.keys(topLevelCopilotUsage).length > 0 ?
      topLevelCopilotUsage
    : (responseEvent.response.copilot_usage ?? null)
  return { totalNanoAiu, copilotUsage }
}
