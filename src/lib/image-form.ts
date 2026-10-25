/** Form field names OpenAI image edit clients use for uploaded images. */
export const IMAGE_FIELD_NAMES: Record<string, true> = {
  image: true,
  "image[]": true,
  images: true,
  "images[]": true,
}

/** Form field names OpenAI image edit clients use for the optional mask. */
export const MASK_FIELD_NAMES: Record<string, true> = {
  mask: true,
  "mask[]": true,
}

function startsWith(bytes: Uint8Array, signature: Array<number>): boolean {
  return signature.every((byte, index) => bytes[index] === byte)
}

/**
 * Resolves the media type of an uploaded image: a declared image type wins,
 * otherwise magic bytes decide, and the file name is the last resort.
 */
export function resolveImageMime(
  declared: string,
  bytes: Uint8Array,
  fileName?: string,
): string {
  const mediaType = declared.trim().toLowerCase()
  if (mediaType.startsWith("image/")) return mediaType

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8])) return "image/jpeg"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46])) return "image/gif"

  const extension = fileName?.split(".").pop()?.toLowerCase()
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg"
  if (extension === "webp") return "image/webp"
  if (extension === "gif") return "image/gif"
  return "image/png"
}
