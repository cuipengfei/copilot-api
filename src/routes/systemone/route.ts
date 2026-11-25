import { Hono } from "hono"

import { resolveMappedModel } from "~/lib/config"
import { forwardError } from "~/lib/http/error"
import { setPluginRequestModel } from "~/lib/http/request-events"
import {
  getAttachedResponseHeaders,
  jsonWithForwardedHeaders,
} from "~/lib/response-headers"
import {
  createCopilotTokenUsageRecorder,
  normalizeResponsesUsage,
} from "~/lib/token-usage"
import {
  createSystemOne,
  type SystemOneRequest,
} from "~/services/copilot/create-systemone"

export const systemOneRoutes = new Hono()

systemOneRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<SystemOneRequest>()
    setPluginRequestModel(payload.model)
    payload.model = resolveMappedModel(payload.model)

    const response = await createSystemOne(payload)
    if (response.usage) {
      const recordUsage = createCopilotTokenUsageRecorder({
        endpoint: "systemone",
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
