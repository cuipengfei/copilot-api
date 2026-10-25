import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'

import {
  serializeMediaFile,
  serializeVideoMediaFile,
} from '../src/lib/media-upload'
import { VIDEO_IMAGE_MAX_BYTES } from '../src/types/media'

let win: Window
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()

function setGlobal(name: string, value: unknown): void {
  previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
}

beforeEach(() => {
  win = new Window({ url: 'http://localhost' })
  setGlobal('window', win)
  setGlobal('document', win.document)
})

afterEach(async () => {
  await win.happyDOM.close()
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  previousGlobals.clear()
})

function webpFile(size = 4): File {
  return new File([new Uint8Array(size)], 'frame.webp', {
    type: 'image/webp',
  })
}

describe('media upload serialization', () => {
  test('serializes regular uploads without reading them through a canvas', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'frame.png', {
      type: 'image/png',
    })
    expect(await serializeMediaFile(file)).toEqual({
      name: 'frame.png',
      type: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    })
  })

  test('keeps WebP files at the compression limit unchanged', async () => {
    const createImageBitmap = mock(() => Promise.reject(new Error('unused')))
    setGlobal('createImageBitmap', createImageBitmap)
    const file = webpFile(VIDEO_IMAGE_MAX_BYTES)
    expect(await serializeVideoMediaFile(file)).toMatchObject({
      name: 'frame.webp',
      type: 'image/webp',
    })
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  test('decodes oversized WebP through Chromium before main-process compression', async () => {
    const close = mock(() => {})
    const bitmap = { width: 640, height: 360, close }
    const createImageBitmap = mock(() => Promise.resolve(bitmap))
    setGlobal('createImageBitmap', createImageBitmap)

    const fillRect = mock(() => {})
    const drawImage = mock(() => {})
    const context = { fillStyle: '', fillRect, drawImage }
    const encoded = new Uint8Array([9, 8, 7])
    const getContext = Object.getOwnPropertyDescriptor(
      win.HTMLCanvasElement.prototype,
      'getContext',
    )
    const toBlob = Object.getOwnPropertyDescriptor(
      win.HTMLCanvasElement.prototype,
      'toBlob',
    )
    Object.defineProperty(win.HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => context,
    })
    Object.defineProperty(win.HTMLCanvasElement.prototype, 'toBlob', {
      configurable: true,
      value: (callback: BlobCallback, type?: string) => {
        expect(type).toBe('image/jpeg')
        callback(new Blob([encoded], { type: 'image/jpeg' }))
      },
    })

    try {
      const file = webpFile(VIDEO_IMAGE_MAX_BYTES + 1)
      expect(await serializeVideoMediaFile(file)).toEqual({
        name: 'frame.jpg',
        type: 'image/jpeg',
        bytes: encoded,
      })
      expect(createImageBitmap).toHaveBeenCalledWith(file)
      expect(fillRect).toHaveBeenCalledWith(0, 0, 640, 360)
      expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      if (getContext)
        Object.defineProperty(
          win.HTMLCanvasElement.prototype,
          'getContext',
          getContext,
        )
      if (toBlob)
        Object.defineProperty(win.HTMLCanvasElement.prototype, 'toBlob', toBlob)
    }
  })
})
