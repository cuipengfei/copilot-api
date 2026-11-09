import { Hono } from "hono"

import { resolveMappedModel } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { setPluginRequestModel } from "~/lib/request-events"
import {
  getAttachedResponseHeaders,
  jsonWithForwardedHeaders,
} from "~/lib/response-headers"
import {
  createCopilotTokenUsageRecorder,
  normalizeResponsesUsage,
} from "~/lib/token-usage"
import {
  createDecisions,
  type DecisionsRequest,
} from "~/services/copilot/create-decisions"

export const decisionRoutes = new Hono()

decisionRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<DecisionsRequest>()
    setPluginRequestModel(payload.model)
    payload.model = resolveMappedModel(payload.model)

    const response = await createDecisions(payload)
    if (response.usage) {
      const recordUsage = createCopilotTokenUsageRecorder({
        endpoint: "decisions",
        model: payload.model,
      })
      recordUsage(normalizeResponsesUsage(response.usage))
    }

    return jsonWithForwardedHeaders(
      response,
      getAttachedResponseHeaders(response),
    )
  } catch (error) {
    return await forwardError(c, error)
  }
})
