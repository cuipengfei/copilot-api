import { describe, expect, mock, test } from 'bun:test'
import { createOAuthLoginFlow } from '../electron/oauth-login'
import type { AuthResult } from '../src/types/ipc'

function setup() {
  const pending = Promise.withResolvers<AuthResult>()
  let callbacks:
    | {
        signal: AbortSignal
        onAuth: (info: string) => void
        onSaving: () => void
      }
    | undefined
  const onAuth = mock((_info: string) => {})
  const onSaving = mock(() => {})
  const login = mock(
    (_input: string, options: NonNullable<typeof callbacks>) => {
      callbacks = options
      options.signal.addEventListener(
        'abort',
        () => pending.reject(options.signal.reason as Error),
        { once: true },
      )
      return pending.promise
    },
  )
  const flow = createOAuthLoginFlow({
    login,
    onAuth,
    onSaving,
    formatError: (error) => Promise.resolve((error as Error).message),
    inProgressError: () => Promise.resolve('already signing in'),
  })
  return { pending, flow, onAuth, onSaving, login, callbacks: () => callbacks! }
}

describe('shared OAuth desktop login', () => {
  test('publishes authorization info and completes successfully', async () => {
    const task = setup()
    expect(task.flow.cancel()).toBe(false)
    const result = task.flow.start('alias')
    await Promise.resolve()
    task.callbacks().onAuth('url')
    expect(task.onAuth).toHaveBeenCalledWith('url')
    expect(task.login.mock.calls[0]?.[0]).toBe('alias')
    task.pending.resolve({ success: true, mode: 'provider' })
    expect((await result).success).toBe(true)
    expect(task.flow.cancel()).toBe(false)
  })
  test('rejects duplicate starts and reports cancellation without exposing an error', async () => {
    const task = setup()
    const result = task.flow.start('first')
    await Promise.resolve()
    expect((await task.flow.start('second')).error).toBe('already signing in')
    expect(task.flow.cancel()).toBe(true)
    task.callbacks().onAuth('late-url')
    expect(task.onAuth).not.toHaveBeenCalled()
    expect(await result).toEqual({
      success: false,
      mode: 'none',
      cancelled: true,
    })
  })
  test('keeps saving uncancellable and reports persistence failures', async () => {
    const task = setup()
    const result = task.flow.start('alias')
    await Promise.resolve()
    task.callbacks().onSaving()
    expect(task.onSaving).toHaveBeenCalled()
    expect(task.flow.cancel()).toBe(false)
    const queued = task.flow.start('other')
    expect(task.flow.cancel()).toBe(true)
    task.pending.reject(new Error('write failed'))
    expect((await result).error).toBe('write failed')
    expect((await queued).cancelled).toBe(true)
  })
  test('waits for a cancelled attempt before starting a replacement', async () => {
    const task = setup()
    const first = task.flow.start('first')
    await Promise.resolve()
    const oldCallbacks = task.callbacks()
    task.flow.cancel()
    const replacement = Promise.withResolvers<AuthResult>()
    task.login.mockImplementationOnce((_input, callbacks) => {
      callbacks.onAuth('new-url')
      return replacement.promise
    })
    const second = task.flow.start('second')
    await first
    oldCallbacks.onAuth('old-url')
    await Promise.resolve()
    expect(task.onAuth).toHaveBeenCalledWith('new-url')
    expect(task.onAuth).not.toHaveBeenCalledWith('old-url')
    replacement.resolve({ success: true })
    expect((await second).success).toBe(true)
  })
})
