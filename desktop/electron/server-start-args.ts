// The GitHub token is deliberately not passed here: process arguments are
// visible to every local user through the process list. server-manager hands
// it to the server process through COPILOT_API_GITHUB_TOKEN instead, and the
// server otherwise reads the token file written by `auth login`.
export function buildServerStartArgs(
  port: number,
  host?: string | null,
): string[] {
  const args = ['start', '--port', String(port)]
  const normalizedHost = host?.trim()

  if (normalizedHost) {
    args.push('--host', normalizedHost)
  }

  return args
}
