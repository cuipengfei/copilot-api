import { Hono } from "hono"
import { z } from "zod"

import { forwardError } from "~/lib/error"
import { getModelMappings, setModelMappings } from "~/lib/config"
import { reloadServerConfig } from "~/lib/config-reload"
import { PATHS } from "~/lib/paths"

export const configRoutes = new Hono()

const modelMappingsRequestSchema = z.object({
  modelMappings: z.record(z.string(), z.string()),
})

configRoutes.post("/reload", async (c) => {
  try {
    await reloadServerConfig()
    return c.json({ configPath: PATHS.CONFIG_PATH, reloaded: true })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.get("/model-mappings", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    modelMappings: getModelMappings(),
  })
})

configRoutes.post("/model-mappings", async (c) => {
  try {
    const parseResult = modelMappingsRequestSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const updatedModelMappings = setModelMappings(
      parseResult.data.modelMappings,
    )

    return c.json({
      configPath: PATHS.CONFIG_PATH,
      modelMappings: updatedModelMappings,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
