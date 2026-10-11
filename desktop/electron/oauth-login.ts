import type { AuthResult } from '../src/types/ipc'

interface OAuthLoginDependencies<Input, AuthInfo> {
  login: (
    input: Input,
    callbacks: {
      signal: AbortSignal
      onAuth: (info: AuthInfo) => void
      onSaving: () => void
    },
  ) => Promise<AuthResult>
  onAuth: (info: AuthInfo) => void
  onSaving: () => void
  formatError: (error: unknown) => Promise<string>
  inProgressError: () => Promise<string>
}

// Codex and xAI share cancellation and persistence rules; only login differs.
export function createOAuthLoginFlow<Input, AuthInfo>(
  dependencies: OAuthLoginDependencies<Input, AuthInfo>,
) {
  let controller: AbortController | undefined
  let task: Promise<AuthResult> | undefined
  let saving = false

  return {
    cancel(): boolean {
      if (!controller || saving) return false
      controller.abort(new Error('Login cancelled'))
      return true
    },
    async start(input: Input): Promise<AuthResult> {
      const previousTask = task
      if (previousTask && !controller?.signal.aborted && !saving) {
        return {
          success: false,
          mode: 'none',
          error: await dependencies.inProgressError(),
        }
      }
      const attempt = new AbortController()
      controller = attempt
      saving = false
      let attemptSaving = false
      task = (async () => {
        try {
          await previousTask
          attempt.signal.throwIfAborted()
          return await dependencies.login(input, {
            signal: attempt.signal,
            onAuth: (info) => {
              if (controller === attempt && !attempt.signal.aborted)
                dependencies.onAuth(info)
            },
            onSaving: () => {
              attemptSaving = true
              if (controller === attempt) {
                saving = true
                dependencies.onSaving()
              }
            },
          })
        } catch (error) {
          if (
            !attemptSaving
            && attempt.signal.aborted
            && (error === attempt.signal.reason
              || (error instanceof Error && error.name === 'AbortError'))
          ) {
            return { success: false, mode: 'none', cancelled: true }
          }
          return {
            success: false,
            mode: 'none',
            error: await dependencies.formatError(error),
          }
        } finally {
          if (controller === attempt) {
            controller = undefined
            task = undefined
            saving = false
          }
        }
      })()
      return await task
    },
  }
}
