import type { AuthResult, AuthStatus } from '../types/ipc'

// Re-enabling a stored provider can make the initial authorization screen usable
// without restarting the desktop application.
export async function refreshProviderAuthStatus(
  getStatus: () => Promise<AuthStatus>,
  onSuccess: (result: AuthResult) => void,
  shouldNavigate: boolean,
): Promise<void> {
  const status = await getStatus()
  if (shouldNavigate && status.success && status.mode !== 'none')
    onSuccess(status)
}
