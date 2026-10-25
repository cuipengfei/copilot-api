import {
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici"

import {
  IMAGE_FIELD_NAMES,
  MASK_FIELD_NAMES,
  resolveImageMime,
} from "~/lib/image-form"
import { createTimeoutDispatcher } from "~/lib/timeout-dispatcher"
import {
  buildCodexRequestHeaders,
  CODEX_API_BASE_URL,
} from "~/services/codex/create-responses"

export type CodexImagesOperation = "generations" | "edits"

const CODEX_IMAGES_TIMEOUT_MS = 15 * 60 * 1000

const codexImagesDispatcher = createTimeoutDispatcher(CODEX_IMAGES_TIMEOUT_MS)

type StreamingRequestInit = RequestInit & {
  duplex: "half"
}

const CODEX_EDIT_NUMBER_FIELDS: Record<string, true> = {
  n: true,
  output_compression: true,
  partial_images: true,
}

const CODEX_EDIT_BOOLEAN_FIELDS: Record<string, true> = {
  stream: true,
}

async function blobToImageUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const fileName = blob instanceof File ? blob.name : undefined
  const mime = resolveImageMime(blob.type, bytes, fileName)
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}

function formFieldValue(name: string, value: string): unknown {
  if (CODEX_EDIT_NUMBER_FIELDS[name] === true) {
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }
  if (
    CODEX_EDIT_BOOLEAN_FIELDS[name] === true
    && (value === "true" || value === "false")
  ) {
    return value === "true"
  }
  return value
}

/**
 * Rebuilds a multipart image edit as the JSON body Codex accepts: uploaded
 * images and masks become base64 data URL references, numeric and boolean
 * fields keep their JSON types, and every other field passes through.
 */
export async function translateCodexImageEditForm(
  formData: FormData,
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {}
  const images: Array<{ image_url: string }> = []
  let mask: { image_url: string } | undefined

  for (const [name, value] of formData.entries()) {
    const isImage = IMAGE_FIELD_NAMES[name] === true
    const isMask = MASK_FIELD_NAMES[name] === true
    if (typeof value === "string" && !isImage && !isMask) {
      payload[name] = formFieldValue(name, value)
      continue
    }

    const imageUrl =
      typeof value === "string" ? value : await blobToImageUrl(value)
    if (isImage) images.push({ image_url: imageUrl })
    else if (isMask) mask = { image_url: imageUrl }
    else payload[name] = imageUrl
  }

  if (images.length > 0) payload.images = images
  if (mask !== undefined) payload.mask = mask
  return payload
}

export function resolveCodexImagesUrl(
  requestUrl: string,
  operation: CodexImagesOperation,
): string {
  const upstreamUrl = new URL(`${CODEX_API_BASE_URL}/codex/images/${operation}`)
  upstreamUrl.search = new URL(requestUrl, "http://localhost").search
  return upstreamUrl.toString()
}

export async function forwardCodexImages(
  request: Request,
  operation: CodexImagesOperation,
): Promise<Response> {
  const headers = buildCodexRequestHeaders(request.headers)
  if (!headers.has("accept")) {
    headers.set("accept", "application/json")
  }

  if (operation === "generations" && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const init: StreamingRequestInit = {
    method: "POST",
    headers,
    body: request.body,
    duplex: "half",
    signal: AbortSignal.timeout(CODEX_IMAGES_TIMEOUT_MS),
  }

  const upstreamUrl = resolveCodexImagesUrl(request.url, operation)
  if (typeof Bun !== "undefined") {
    return await fetch(upstreamUrl, init)
  }

  // Node and Undici expose separate fetch types, but their streamed request
  // and response objects are runtime-compatible here.
  return (await undiciFetch(upstreamUrl, {
    ...init,
    dispatcher: codexImagesDispatcher,
  } as unknown as UndiciRequestInit)) as unknown as Response
}
