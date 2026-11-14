import consola from "consola"
import { z } from "zod"

import { copilotBaseUrl, copilotModelsHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface FusionSelectionResponse {
  planVersion: "1" | "2"
  fusionPattern: string
  steps: Array<{ modelId: string; role?: string }>
  sessionToken: string
  expiresAt: number
  scores?: Record<string, number>
}

const fusionSelectionSchema = z.object({
  plan_version: z.enum(["1", "2"]).optional(),
  fusion_pattern: z.string().refine((value) => value.trim().length > 0),
  steps: z
    .array(
      z.object({
        model_id: z.string().refine((value) => value.trim().length > 0),
        role: z.string().optional(),
      }),
    )
    .min(1),
  session: z.object({
    token: z.string().refine((value) => value.trim().length > 0),
    expires_at: z.number().refine((expiresAt) => expiresAt > Date.now() / 1000),
  }),
  hydra_scores: z.object({}).catchall(z.number()).optional(),
})

export const parseFusionSelection = (
  value: unknown,
  planVersion: "1" | "2",
): FusionSelectionResponse => {
  const parsed = fusionSelectionSchema.safeParse(value)
  if (
    !parsed.success
    || (parsed.data.plan_version !== undefined
      && parsed.data.plan_version !== planVersion)
    || (planVersion === "2"
      && (parsed.data.fusion_pattern !== "solo"
        || parsed.data.steps.length !== 1))
  ) {
    throw new Error("Invalid Fusion selection response: invalid_body")
  }
  return {
    planVersion,
    fusionPattern: parsed.data.fusion_pattern,
    steps: parsed.data.steps.map((step) => ({
      modelId: step.model_id,
      ...(step.role === undefined ? {} : { role: step.role }),
    })),
    sessionToken: parsed.data.session.token,
    expiresAt: parsed.data.session.expires_at,
    ...(parsed.data.hydra_scores === undefined ?
      {}
    : { scores: parsed.data.hydra_scores }),
  }
}

export const getFusionSelection = async (
  prompt: string,
  options: { planVersion: "1" | "2" } = { planVersion: "2" },
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
      plan_version: options.planVersion,
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
  return parseFusionSelection(body, options.planVersion)
}
