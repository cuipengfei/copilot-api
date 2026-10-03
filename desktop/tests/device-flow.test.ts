import { describe, expect, test } from 'bun:test'

import type { DeviceCodeResponse } from '../../src/services/github/get-device-code'
import {
  createDeviceFlowStarter,
  createDeviceFlowTokenHandler,
  type DeviceFlowDependencies,
  type DeviceFlowTokenDependencies,
} from '../electron/device-flow'
import { normalizeSettings } from '../electron/settings-store'
import type { DesktopSettings } from '../src/types/ipc'

const createDeviceCode = (code: string): DeviceCodeResponse => ({
  device_code: `device-${code}`,
  expires_in: 900,
  interval: 5,
  user_code: code,
  verification_uri: 'https://github.com/login/device',
})

interface PendingPoll {
  deviceCode: DeviceCodeResponse
  signal: AbortSignal
  resolve: (token: string) => void
  reject: (error: Error) => void
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function createHarness(
  getDeviceCode?: () => Promise<DeviceCodeResponse>,
  onToken?: DeviceFlowDependencies['onToken'],
) {
  const polls: PendingPoll[] = []
  const tokens: string[] = []
  const errors: string[] = []
  let codeIndex = 0
  const start = createDeviceFlowStarter({
    getDeviceCode:
      getDeviceCode
      ?? (() => Promise.resolve(createDeviceCode(`CODE-${++codeIndex}`))),
    pollAccessToken: (deviceCode, signal) =>
      new Promise<string>((resolve, reject) => {
        polls.push({ deviceCode, signal, resolve, reject })
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        })
      }),
    onToken:
      onToken
      ?? ((token) => {
        tokens.push(token)
        return Promise.resolve()
      }),
    onError: (error) => {
      errors.push(error.message)
    },
  })
  return { errors, polls, settle, start, tokens }
}

function createTokenHandlerHarness() {
  const state: {
    token: string | null
    settings: DesktopSettings
    successes: number
  } = {
    token: 'previous-token',
    settings: normalizeSettings({ verbose: true }),
    successes: 0,
  }
  const events: string[] = []
  const dependencies: DeviceFlowTokenDependencies = {
    getGitHubUser: () => {
      events.push('verify-user')
      return Promise.resolve('test-user')
    },
    getCopilotAccountType: () => {
      events.push('verify-account-type')
      return Promise.resolve('enterprise')
    },
    readSettings: () => {
      events.push('read-settings')
      return Promise.resolve(state.settings)
    },
    saveToken: (token) => {
      events.push('save-token')
      state.token = token
      return Promise.resolve()
    },
    writeSettings: (settings) => {
      events.push('write-settings')
      state.settings = settings
      return Promise.resolve()
    },
    onSuccess: () => {
      events.push('success')
      state.successes++
    },
  }

  return {
    dependencies,
    events,
    onToken: createDeviceFlowTokenHandler(dependencies),
    state,
  }
}

describe('createDeviceFlowStarter', () => {
  test('reports the token of the current flow', async () => {
    const { polls, settle, start, tokens, errors } = createHarness()

    const deviceCode = await start()
    polls[0]?.resolve('gho_token')
    await settle()

    expect(deviceCode.user_code).toBe('CODE-1')
    expect(tokens).toEqual(['gho_token'])
    expect(errors).toEqual([])
  })

  test('passes the flow cancellation signal to token handling', async () => {
    let handledSignal: AbortSignal | undefined
    const { polls, settle, start } = createHarness(
      undefined,
      (_token, signal) => {
        handledSignal = signal
        return Promise.resolve()
      },
    )

    await start()
    polls[0]?.resolve('gho_token')
    await settle()

    expect(handledSignal).toBe(polls[0]?.signal)
  })

  test('cancels token handling that has already started', async () => {
    const started = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let handledSignal: AbortSignal | undefined
    let reportedSuccess = false
    const { polls, settle, start, errors } = createHarness(
      undefined,
      async (_token, signal) => {
        handledSignal = signal
        started.resolve()
        await resume.promise
        handledSignal?.throwIfAborted()
        reportedSuccess = true
      },
    )

    await start()
    polls[0]?.resolve('gho_token')
    await started.promise
    await start()
    resume.resolve()
    await settle()

    expect(reportedSuccess).toBe(false)
    expect(polls[1]?.signal.aborted).toBe(false)
    expect(errors).toEqual([])
  })

  test('reports failures of the current flow', async () => {
    const { polls, settle, start, errors } = createHarness()

    await start()
    polls[0]?.reject(new Error('GitHub device code expired'))
    await settle()

    expect(errors).toEqual(['GitHub device code expired'])
  })

  test('aborts a superseded flow and ignores its failure', async () => {
    const { polls, settle, start, tokens, errors } = createHarness()

    await start()
    await start()
    await settle()

    expect(polls).toHaveLength(2)
    expect(polls[0]?.signal.aborted).toBe(true)
    expect(polls[1]?.signal.aborted).toBe(false)
    expect(errors).toEqual([])

    polls[1]?.resolve('gho_second')
    await settle()

    expect(tokens).toEqual(['gho_second'])
    expect(errors).toEqual([])
  })

  test('aborts the previous poll before the next device code arrives', async () => {
    const nextCode = Promise.withResolvers<DeviceCodeResponse>()
    let requests = 0
    const { polls, settle, start, errors } = createHarness(() =>
      ++requests === 1 ?
        Promise.resolve(createDeviceCode('CODE-1'))
      : nextCode.promise,
    )

    await start()
    const next = start()

    expect(polls[0]?.signal.aborted).toBe(true)
    await settle()
    expect(errors).toEqual([])

    nextCode.resolve(createDeviceCode('CODE-2'))
    await next
    expect(polls[1]?.signal.aborted).toBe(false)
  })

  test('rejects an older device code without aborting the latest poll', async () => {
    const firstCode = Promise.withResolvers<DeviceCodeResponse>()
    const latestCode = Promise.withResolvers<DeviceCodeResponse>()
    let requests = 0
    const { polls, start, tokens, errors, settle } = createHarness(() =>
      ++requests === 1 ? firstCode.promise : latestCode.promise,
    )

    const first = start().catch((error: unknown) => error)
    const latest = start()
    latestCode.resolve(createDeviceCode('LATEST'))
    expect((await latest).user_code).toBe('LATEST')

    firstCode.resolve(createDeviceCode('OLDER'))
    expect(await first).toMatchObject({ name: 'AbortError' })
    expect(polls).toHaveLength(1)
    expect(polls[0]?.deviceCode.user_code).toBe('LATEST')
    expect(polls[0]?.signal.aborted).toBe(false)

    polls[0]?.resolve('gho_latest')
    await settle()
    expect(tokens).toEqual(['gho_latest'])
    expect(errors).toEqual([])
  })

  test('does not deliver a resolved token after a newer request starts', async () => {
    const { polls, start, tokens, errors, settle } = createHarness()

    await start()
    polls[0]?.resolve('gho_superseded')
    await start()
    await settle()

    expect(polls[0]?.signal.aborted).toBe(true)
    expect(tokens).toEqual([])
    expect(errors).toEqual([])

    polls[1]?.resolve('gho_current')
    await settle()
    expect(tokens).toEqual(['gho_current'])
  })

  test('keeps superseded device-code failures from affecting the latest poll', async () => {
    const firstCode = Promise.withResolvers<DeviceCodeResponse>()
    let requests = 0
    const { polls, start, errors } = createHarness(() =>
      ++requests === 1 ?
        firstCode.promise
      : Promise.resolve(createDeviceCode('LATEST')),
    )

    const first = start().catch((error: unknown) => error)
    await start()
    firstCode.reject(new Error('old request failed'))

    expect(await first).toMatchObject({ name: 'AbortError' })
    expect(polls).toHaveLength(1)
    expect(polls[0]?.signal.aborted).toBe(false)
    expect(errors).toEqual([])
  })

  test('reports device-code failures to the caller and permits retrying', async () => {
    const failure = new Error('device code request failed')
    let requests = 0
    const { polls, start, errors } = createHarness(() =>
      ++requests === 1 ?
        Promise.reject(failure)
      : Promise.resolve(createDeviceCode('RETRY')),
    )

    const result = await start().catch((error: unknown) => error)
    expect(result).toBe(failure)
    expect(polls).toHaveLength(0)
    expect(errors).toEqual([])

    expect((await start()).user_code).toBe('RETRY')
    expect(polls[0]?.signal.aborted).toBe(false)
  })

  test('does not let a superseded poll cleanup clear the latest flow', async () => {
    const { polls, start, settle } = createHarness()

    await start()
    await start()
    await settle()
    await start()
    await settle()

    expect(polls).toHaveLength(3)
    expect(polls[0]?.signal.aborted).toBe(true)
    expect(polls[1]?.signal.aborted).toBe(true)
    expect(polls[2]?.signal.aborted).toBe(false)
  })

  test('normalizes non-Error poll failures', async () => {
    const errors: string[] = []
    const start = createDeviceFlowStarter({
      getDeviceCode: () => Promise.resolve(createDeviceCode('CODE-1')),
      pollAccessToken: () =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        new Promise((_resolve, reject) => reject('failed')),
      onToken: () => Promise.resolve(),
      onError: (error) => {
        errors.push(error.message)
      },
    })

    await start()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(errors).toEqual(['failed'])
  })

  test('reports errors thrown while handling the token', async () => {
    const errors: string[] = []
    const start = createDeviceFlowStarter({
      getDeviceCode: () => Promise.resolve(createDeviceCode('CODE-1')),
      pollAccessToken: () => Promise.resolve('gho_token'),
      onToken: () => Promise.reject(new Error('save failed')),
      onError: (error) => {
        errors.push(error.message)
      },
    })

    await start()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(errors).toEqual(['save failed'])
  })
})

describe('createDeviceFlowTokenHandler', () => {
  test('validates before saving and preserves unrelated settings', async () => {
    const { events, onToken, state } = createTokenHandlerHarness()

    await onToken('current-token', new AbortController().signal)

    expect(events).toEqual([
      'verify-user',
      'verify-account-type',
      'read-settings',
      'save-token',
      'write-settings',
      'success',
    ])
    expect(state.token).toBe('current-token')
    expect(state.settings.accountType).toBe('enterprise')
    expect(state.settings.verbose).toBe(true)
    expect(state.successes).toBe(1)
  })

  test('does no work when already cancelled', async () => {
    const { events, onToken, state } = createTokenHandlerHarness()
    const controller = new AbortController()
    controller.abort()

    const result = await onToken('cancelled-token', controller.signal).catch(
      (error: unknown) => error,
    )

    expect(result).toMatchObject({ name: 'AbortError' })
    expect(events).toEqual([])
    expect(state.token).toBe('previous-token')
    expect(state.successes).toBe(0)
  })

  test('preserves the existing login when verification fails', async () => {
    const { dependencies, onToken, state, events } = createTokenHandlerHarness()
    const failure = new Error('verification failed')
    dependencies.getGitHubUser = () => Promise.reject(failure)

    const result = await onToken(
      'invalid-token',
      new AbortController().signal,
    ).catch((error: unknown) => error)

    expect(result).toBe(failure)
    expect(events).not.toContain('save-token')
    expect(state.token).toBe('previous-token')
    expect(state.successes).toBe(0)
  })

  test('keeps the newer login when verification of a superseded flow finishes late', async () => {
    const { dependencies, onToken, state } = createTokenHandlerHarness()
    const oldUser = Promise.withResolvers<string>()
    dependencies.getGitHubUser = (token) =>
      token === 'old-token' ? oldUser.promise : Promise.resolve('new-user')
    const { polls, start, errors } = createHarness(undefined, onToken)

    await start()
    polls[0]?.resolve('old-token')
    await settle()
    await start()
    polls[1]?.resolve('new-token')
    await settle()

    expect(state.token).toBe('new-token')
    expect(state.successes).toBe(1)

    oldUser.resolve('old-user')
    await settle()

    expect(state.token).toBe('new-token')
    expect(state.successes).toBe(1)
    expect(errors).toEqual([])
  })

  test('checks cancellation after waiting for another persistence operation', async () => {
    const { dependencies, onToken, state } = createTokenHandlerHarness()
    const reading = Promise.withResolvers<void>()
    const settings = Promise.withResolvers<DesktopSettings>()
    let reads = 0
    dependencies.readSettings = () => {
      reads++
      if (reads === 1) {
        reading.resolve()
        return settings.promise
      }
      return Promise.resolve(state.settings)
    }
    const first = onToken('first-token', new AbortController().signal)
    await reading.promise

    const controller = new AbortController()
    const queued = onToken('cancelled-token', controller.signal).catch(
      (error: unknown) => error,
    )
    await settle()
    controller.abort()
    settings.resolve(state.settings)
    await first

    expect(await queued).toMatchObject({ name: 'AbortError' })
    expect(reads).toBe(1)
    expect(state.token).toBe('first-token')
    expect(state.successes).toBe(1)
  })

  test('checks cancellation after reading settings', async () => {
    const { dependencies, onToken, state, events } = createTokenHandlerHarness()
    const reading = Promise.withResolvers<void>()
    const settings = Promise.withResolvers<DesktopSettings>()
    dependencies.readSettings = () => {
      reading.resolve()
      return settings.promise
    }
    const controller = new AbortController()
    const result = onToken('cancelled-token', controller.signal).catch(
      (error: unknown) => error,
    )
    await reading.promise
    controller.abort()
    settings.resolve(state.settings)

    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(events).not.toContain('save-token')
    expect(state.token).toBe('previous-token')
    expect(state.successes).toBe(0)
  })

  test('serializes an in-flight superseded token write before newer credentials', async () => {
    const { dependencies, onToken, state } = createTokenHandlerHarness()
    const writing = Promise.withResolvers<void>()
    const finishWrite = Promise.withResolvers<void>()
    const writes: string[] = []
    dependencies.saveToken = async (token) => {
      writes.push(`start-${token}`)
      if (token === 'old-token') {
        writing.resolve()
        await finishWrite.promise
      }
      state.token = token
      writes.push(`finish-${token}`)
    }
    const controller = new AbortController()
    const oldResult = onToken('old-token', controller.signal).catch(
      (error: unknown) => error,
    )
    await writing.promise
    controller.abort()
    const current = onToken('new-token', new AbortController().signal)
    await settle()

    expect(writes).toEqual(['start-old-token'])
    expect(state.successes).toBe(0)

    finishWrite.resolve()
    await current

    expect(await oldResult).toMatchObject({ name: 'AbortError' })
    expect(writes).toEqual([
      'start-old-token',
      'finish-old-token',
      'start-new-token',
      'finish-new-token',
    ])
    expect(state.token).toBe('new-token')
    expect(state.settings.accountType).toBe('enterprise')
    expect(state.successes).toBe(1)
  })

  test('serializes an in-flight settings write and suppresses its stale success', async () => {
    const { dependencies, onToken, state } = createTokenHandlerHarness()
    const writing = Promise.withResolvers<void>()
    const finishWrite = Promise.withResolvers<void>()
    const writes: string[] = []
    dependencies.getCopilotAccountType = (token) =>
      Promise.resolve(token === 'old-token' ? 'business' : 'enterprise')
    dependencies.writeSettings = async (settings) => {
      writes.push(settings.accountType)
      if (settings.accountType === 'business') {
        writing.resolve()
        await finishWrite.promise
      }
      state.settings = settings
    }
    const controller = new AbortController()
    const oldResult = onToken('old-token', controller.signal).catch(
      (error: unknown) => error,
    )
    await writing.promise
    controller.abort()
    const current = onToken('new-token', new AbortController().signal)
    await settle()

    expect(writes).toEqual(['business'])
    expect(state.successes).toBe(0)

    finishWrite.resolve()
    await current

    expect(await oldResult).toMatchObject({ name: 'AbortError' })
    expect(writes).toEqual(['business', 'enterprise'])
    expect(state.token).toBe('new-token')
    expect(state.settings.accountType).toBe('enterprise')
    expect(state.successes).toBe(1)
  })

  test('releases the persistence queue after a write fails', async () => {
    const { dependencies, onToken, state } = createTokenHandlerHarness()
    const saveToken = dependencies.saveToken
    const failure = new Error('token write failed')
    dependencies.saveToken = (token) =>
      token === 'failed-token' ? Promise.reject(failure) : saveToken(token)
    const failed = onToken('failed-token', new AbortController().signal).catch(
      (error: unknown) => error,
    )
    const current = onToken('current-token', new AbortController().signal)
    await current

    expect(await failed).toBe(failure)
    expect(state.token).toBe('current-token')
    expect(state.successes).toBe(1)
  })
})
