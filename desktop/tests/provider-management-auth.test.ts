import { describe, expect, mock, test } from 'bun:test'
import { refreshProviderAuthStatus } from '../src/lib/provider-management-auth'

describe('provider management authorization', () => {
  test('returns to the dashboard after re-enabling the last stored provider', async () => {
    const onSuccess = mock(() => {})
    const status = {
      success: true,
      mode: 'provider' as const,
      providers: ['codex'],
    }
    await refreshProviderAuthStatus(
      () => Promise.resolve(status),
      onSuccess,
      true,
    )
    expect(onSuccess).toHaveBeenCalledWith(status)
  })
  test('keeps authorization available when all providers are disabled or invalid', async () => {
    const onSuccess = mock(() => {})
    await refreshProviderAuthStatus(
      () => Promise.resolve({ success: false, mode: 'none' }),
      onSuccess,
      true,
    )
    await refreshProviderAuthStatus(
      () => Promise.resolve({ success: true, mode: 'none' }),
      onSuccess,
      true,
    )
    expect(onSuccess).not.toHaveBeenCalled()
  })
  test('propagates status errors for the authorization screen to display', async () => {
    await expect(
      refreshProviderAuthStatus(
        () => Promise.reject(new Error('IPC unavailable')),
        () => {},
        true,
      ),
    ).rejects.toThrow('IPC unavailable')
  })
  test('keeps the change-authorization form open with an existing valid session', async () => {
    const getStatus = mock(() =>
      Promise.resolve({
        success: true,
        mode: 'provider' as const,
        providers: ['codex'],
      }),
    )
    const onSuccess = mock(() => {})
    await refreshProviderAuthStatus(getStatus, onSuccess, false)
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(onSuccess).not.toHaveBeenCalled()
  })
})
