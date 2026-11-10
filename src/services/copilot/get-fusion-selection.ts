import consola from "consola"
import { z } from "zod"

import { copilotBaseUrl, copilotModelsHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface FusionSelectionResponse {
  modelId: string
  sessionToken: string
  expiresAt: number
}

const fusionSelectionSchema = z.object({
  fusion_pattern: z.literal("solo"),
  steps: z
    .array(
      z.object({
        model_id: z.string().refine((value) => value.trim().length > 0),
      }),
    )
    .length(1),
  session: z.object({
    token: z.string().refine((value) => value.trim().length > 0),
    expires_at: z.number().refine((expiresAt) => expiresAt > Date.now() / 1000),
  }),
})

const parseFusionSelection = (value: unknown): FusionSelectionResponse => {
  const parsed = fusionSelectionSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error("Invalid Fusion selection response: invalid_body")
  }
  return {
    modelId: parsed.data.steps[0].model_id,
    sessionToken: parsed.data.session.token,
    expiresAt: parsed.data.session.expires_at,
  }
}

export const getFusionSelection = async (
  prompt: string,
): Promise<FusionSelectionResponse> => {
  const response = await fetch(`${copilotBaseUrl(state)}/model/fusion`, {
    method: "POST",
    headers: {
      ...copilotModelsHeaders(state),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      fusion_mode: "hydrafusion",
      plan_version: "2",
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    consola.error(`[fusion] selection request failed: HTTP ${response.status}`)
    throw new HTTPError("Failed to get Fusion selection", response)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error("Invalid Fusion selection response: invalid_json")
  }
  return parseFusionSelection(body)
}
