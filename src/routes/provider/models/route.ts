import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { getOpencodeGoModelRecords } from "~/lib/models-dev-cache"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  handleCodexModelsProxy,
  isCodexUserAgent,
} from "~/routes/models/codex-models"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import {
  createProviderProxyResponse,
  forwardProviderModels,
} from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("provider-models-handler")

export const providerModelRoutes = new Hono()

providerModelRoutes.get("/", async (c) => {
  const provider = c.req.param("provider") ?? ""

  try {
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig) {
      return c.json(
        {
          error: {
            message: `Provider '${provider}' not found or disabled`,
            type: "invalid_request_error",
          },
        },
        404,
      )
    }

    if (providerConfig.name === "codex") {
      if (isCodexUserAgent(c.req.header("user-agent"))) {
        return await handleCodexModelsProxy(c, providerConfig)
      }

      const models = getCodexModels()
      return c.json({
        object: "list",
        data: models.data,
        has_more: false,
      })
    }

    if (providerConfig.name === "opencode-go") {
      const models = getOpencodeGoModelRecords()
      if (models.length === 0) {
        return c.json(
          {
            error: {
              message: "OpenCode Go model catalog is unavailable",
              type: "service_unavailable",
            },
          },
          503,
        )
      }
      return c.json({ object: "list", data: models, has_more: false })
    }

    const upstreamResponse = await forwardProviderModels(
      providerConfig,
      c.req.raw.headers,
    )

    logger.debug("provider.models.response", {
      provider,
      statusCode: upstreamResponse.status,
    })

    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error("provider.models.error", {
      provider,
      error,
    })
    return await forwardError(c, error)
  }
})
