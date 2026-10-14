import { getConfig } from "~/lib/config-store"
import { parseProviderModelAlias } from "~/lib/provider-model"

export type ConfiguredXaiImageModel =
  | { status: "disabled" }
  | { status: "invalid"; message: string }
  | { model: string; status: "xai" }

/**
 * Resolves one image-route model setting. Empty values keep the OpenAI
 * protocol. Only an xai/model alias selects the xAI Imagine API.
 */
export function resolveConfiguredXaiImageModel(
  configured: unknown,
  settingName: string,
): ConfiguredXaiImageModel {
  if (configured === undefined || configured === null) {
    return { status: "disabled" }
  }
  if (typeof configured !== "string") {
    return {
      message: `${settingName} must be an xai/model alias`,
      status: "invalid",
    }
  }

  const trimmed = configured.trim()
  if (!trimmed) return { status: "disabled" }

  const alias = parseProviderModelAlias(trimmed)
  if (alias?.provider.toLowerCase() !== "xai") {
    return {
      message: `${settingName} only supports an xai/model alias, received '${trimmed}'`,
      status: "invalid",
    }
  }

  return { model: alias.model, status: "xai" }
}

export function getImageGenerationModel(): ConfiguredXaiImageModel {
  return resolveConfiguredXaiImageModel(
    getConfig().imageGenerationModel,
    "imageGenerationModel",
  )
}

export function getImageEditModel(): ConfiguredXaiImageModel {
  return resolveConfiguredXaiImageModel(
    getConfig().imageEditModel,
    "imageEditModel",
  )
}
