import type { Context } from "hono"

import { stripInternalRequestHeaders } from "~/lib/internal-headers"
import {
  createModelListResponse,
  getAgentModels,
  getAggregatedModels,
  sortModels,
} from "~/routes/models/model-discovery"

export async function handleDefaultModels(c: Context): Promise<Response> {
  const getModels =
    c.req.header("user-agent")?.toLowerCase().startsWith("deepseek") ?
      getAgentModels
    : getAggregatedModels
  const models = await getModels(stripInternalRequestHeaders(c.req.raw.headers))
  return createModelListResponse(c, sortModels(models))
}
