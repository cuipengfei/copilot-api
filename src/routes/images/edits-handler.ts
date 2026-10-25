import type { Context } from "hono"

import { forwardError } from "~/lib/error"
import {
  createCodexImageEditRequest,
  createMultipartImagesRequest,
  forwardStagedCodexImageEdits,
  handleCodexImages,
  imageEditContentTypeErrorResponse,
  imageEditsRouteDependencies,
  imageRouteDependencies,
  isMultipartImagesRequest,
  logger,
  multipartImagesErrorResponse,
  parseJsonImagesRequest,
  routeImagesRequest,
  snapshotRequestHeaders,
} from "~/routes/images/shared"
import {
  handleXaiImageEdit,
  xaiImagesRequestErrorResponse,
} from "~/routes/images/xai-handler"

export async function handleImagesEdits(c: Context): Promise<Response> {
  try {
    const configuredModel = imageRouteDependencies.getImageEditModel()
    if (configuredModel.status === "invalid") {
      return c.json(
        {
          error: {
            message: configuredModel.message,
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const contentTypeError = imageEditContentTypeErrorResponse(c)
    if (contentTypeError) return contentTypeError

    const requestHeaders = snapshotRequestHeaders(c.req.raw)
    if (isMultipartImagesRequest(requestHeaders)) {
      const staged = await imageEditsRouteDependencies.stageMultipartBodyToDisk(
        c.req.raw.body,
        requestHeaders.get("content-type") ?? "",
      )

      if (configuredModel.status === "xai") {
        return await handleXaiImageEdit(c, configuredModel.model, staged)
      }

      const model = staged.formData.get("model")
      if (typeof model !== "string") {
        // No model to route on: forward the upload to Codex as JSON.
        return await forwardStagedCodexImageEdits(c, staged, requestHeaders)
      }

      try {
        const response = await routeImagesRequest(c, "edits", {
          createRequest: (mappedModel) =>
            createMultipartImagesRequest(
              c.req.raw,
              requestHeaders,
              staged.formData,
              mappedModel,
            ),
          createCodexRequest: async (mappedModel) =>
            await createCodexImageEditRequest(
              c.req.raw,
              requestHeaders,
              staged.formData,
              mappedModel,
            ),
          model,
        })
        staged.scheduleCleanup()
        return response
      } catch (error) {
        await staged.cleanup()
        throw error
      }
    }

    if (configuredModel.status === "xai") {
      return await handleXaiImageEdit(c, configuredModel.model)
    }

    const parsed = await parseJsonImagesRequest(c.req.raw)
    if (parsed instanceof Request) {
      return await handleCodexImages(c, "edits", undefined, parsed)
    }
    return await routeImagesRequest(c, "edits", parsed)
  } catch (error) {
    const multipartError = multipartImagesErrorResponse(c, error)
    if (multipartError) return multipartError

    const invalidRequest = xaiImagesRequestErrorResponse(c, error)
    if (invalidRequest) return invalidRequest

    logger.error("images.edits.error", { error })
    return await forwardError(c, error)
  }
}
