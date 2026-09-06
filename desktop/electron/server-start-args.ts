export function buildServerStartArgs(
  port: number,
  githubToken?: string | null,
  host?: string | null,
): string[] {
  const args = ['start', '--port', String(port)]
  const normalizedToken = githubToken?.trim()
  const normalizedHost = host?.trim()

  if (normalizedToken) {
    args.push('--github-token', normalizedToken)
  }

  if (normalizedHost) {
    args.push('--host', normalizedHost)
  }

  return args
}
