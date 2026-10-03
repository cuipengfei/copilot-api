import { describe, expect, mock, test } from 'bun:test'

import { createConfigRefresher } from '../electron/config-refresh'

function createFixture(running = true) {
  let adminApiKey = 'old-admin'
  const reloadConfig = mock((_adminApiKeys: string[]) => Promise.resolve())
  const invalidateConfigCache = mock(() => {})
  const fixture = {
    running,
    reloadConfig,
    invalidateConfigCache,
    readAdminApiKey: mock(() => Promise.resolve(adminApiKey)),
    setAdminApiKey: (value: string) => {
      adminApiKey = value
    },
  }
  const { saveAndRefresh: update, setActiveAdminApiKey } =
    createConfigRefresher({
      isRunning: () => fixture.running,
      readAdminApiKey: fixture.readAdminApiKey,
      reloadConfig,
      invalidateConfigCache,
    })
  return {
    ...fixture,
    update,
    setActiveAdminApiKey,
    stop: () => {
      fixture.running = false
    },
  }
}

describe('automatic config refresh', () => {
  test('uses the startup key after an external rotation before the first save', async () => {
    const fixture = createFixture()
    fixture.setActiveAdminApiKey('startup-admin')
    fixture.setAdminApiKey('external-admin')
    await fixture.update(() => 'saved')
    expect(fixture.reloadConfig).toHaveBeenCalledWith([
      'startup-admin',
      'external-admin',
    ])
  })

  test('replaces the cached key when a new server starts', async () => {
    const fixture = createFixture()
    await fixture.update(() => 'initial')
    fixture.setActiveAdminApiKey('restarted-admin')
    fixture.setAdminApiKey('external-admin')
    await fixture.update(() => 'saved')
    expect(fixture.reloadConfig.mock.calls[1]).toEqual([
      ['restarted-admin', 'external-admin'],
    ])
  })

  test('refreshes with the active admin key when the saved key changes', async () => {
    const fixture = createFixture()
    const result = await fixture.update(() => {
      fixture.setAdminApiKey('new-admin')
      return { saved: true }
    })
    expect(result).toEqual({ saved: true })
    expect(fixture.reloadConfig).toHaveBeenCalledWith([
      'old-admin',
      'new-admin',
    ])
    expect(fixture.invalidateConfigCache).toHaveBeenCalledTimes(1)
  })

  test('only saves and invalidates the local cache while the server is stopped', async () => {
    const fixture = createFixture(false)
    expect(await fixture.update(() => 'saved')).toBe('saved')
    expect(fixture.readAdminApiKey).not.toHaveBeenCalled()
    expect(fixture.reloadConfig).not.toHaveBeenCalled()
    expect(fixture.invalidateConfigCache).toHaveBeenCalledTimes(1)
  })

  test('skips the refresh if the server stops during the save', async () => {
    const fixture = createFixture()
    await fixture.update(() => fixture.stop())
    expect(fixture.reloadConfig).not.toHaveBeenCalled()
  })

  test('serializes saves so a second rotation uses the refreshed key', async () => {
    const fixture = createFixture()
    const refreshing = Promise.withResolvers<void>()
    fixture.reloadConfig.mockImplementationOnce(() => refreshing.promise)
    const first = fixture.update(() => fixture.setAdminApiKey('second-admin'))
    const secondSave = mock(() => fixture.setAdminApiKey('third-admin'))
    const second = fixture.update(secondSave)
    await Promise.resolve()
    await Promise.resolve()
    expect(secondSave).not.toHaveBeenCalled()
    refreshing.resolve()
    await Promise.all([first, second])
    expect(fixture.reloadConfig.mock.calls).toEqual([
      [['old-admin', 'second-admin']],
      [['second-admin', 'third-admin']],
    ])
  })

  test('does not refresh a failed save and accepts a subsequent update', async () => {
    const fixture = createFixture()
    await expect(
      fixture.update(() => {
        throw new Error('write failed')
      }),
    ).rejects.toThrow('write failed')
    expect(fixture.reloadConfig).not.toHaveBeenCalled()
    expect(fixture.invalidateConfigCache).not.toHaveBeenCalled()
    expect(await fixture.update(() => 'retry')).toBe('retry')
    expect(fixture.reloadConfig).toHaveBeenCalledTimes(1)
  })

  test('reports refresh failures and keeps the update queue usable', async () => {
    const fixture = createFixture()
    fixture.reloadConfig.mockRejectedValueOnce(new Error('refresh failed'))
    await expect(fixture.update(() => 'saved')).rejects.toThrow(
      'refresh failed',
    )
    expect(await fixture.update(() => 'retry')).toBe('retry')
    expect(fixture.reloadConfig).toHaveBeenCalledTimes(2)
  })

  test('retains the running key when rotation is saved but refresh fails', async () => {
    const fixture = createFixture()
    fixture.reloadConfig.mockRejectedValueOnce(new Error('connection failed'))
    await expect(
      fixture.update(() => fixture.setAdminApiKey('new-admin')),
    ).rejects.toThrow('connection failed')
    await fixture.update(() => 'retry')
    expect(fixture.reloadConfig.mock.calls[1]).toEqual([
      ['old-admin', 'new-admin'],
    ])
  })

  test('keeps the saved key as a fallback after the server restarts', async () => {
    const fixture = createFixture()
    await fixture.update(() => 'initial')
    fixture.setAdminApiKey('restarted-admin')
    await fixture.update(() => fixture.setAdminApiKey('rotated-admin'))
    expect(fixture.reloadConfig.mock.calls[1]).toEqual([
      ['old-admin', 'restarted-admin', 'rotated-admin'],
    ])
  })
})
