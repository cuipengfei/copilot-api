import { VIDEO_IMAGE_MAX_BYTES, type MediaUpload } from '../types/media'

function jpegName(name: string): string {
  const stem = name.trim().replace(/\.[^.]+$/u, '')
  return stem ? `${stem}.jpg` : 'frame.jpg'
}

export async function serializeMediaFile(file: File): Promise<MediaUpload> {
  return {
    name: file.name,
    type: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  }
}

/** Electron nativeImage cannot decode WebP, so convert oversized frames first. */
export async function transcodeOversizedWebp(file: File): Promise<MediaUpload> {
  const bitmap = await createImageBitmap(file)
  try {
    if (bitmap.width < 1 || bitmap.height < 1)
      throw new Error('Could not read the video image')
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not decode the video image')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92),
    )
    if (!blob || !blob.size)
      throw new Error('Could not convert the video image')
    return {
      name: jpegName(file.name),
      type: 'image/jpeg',
      bytes: new Uint8Array(await blob.arrayBuffer()),
    }
  } finally {
    bitmap.close()
  }
}

export async function serializeVideoMediaFile(
  file: File,
): Promise<MediaUpload> {
  if (file.type !== 'image/webp' || file.size <= VIDEO_IMAGE_MAX_BYTES)
    return await serializeMediaFile(file)
  return await transcodeOversizedWebp(file)
}
