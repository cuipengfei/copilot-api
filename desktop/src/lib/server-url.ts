// Renderer-side host helpers. The web bundle cannot import
// src/lib/server-host because that module depends on node:net, so the
// wildcard handling below mirrors resolveClientHostname with a display
// friendly loopback fallback.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]'])

export function resolveDisplayHost(host: string | null | undefined): string {
  const normalizedHost = host?.trim()
  if (!normalizedHost || WILDCARD_HOSTS.has(normalizedHost)) {
    return 'localhost'
  }
  return normalizedHost
}

function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export function buildServerBaseUrl(
  host: string | null | undefined,
  port: number,
): string {
  return `http://${formatHostForUrl(resolveDisplayHost(host))}:${port}`
}

// Mirrors normalizeServerHostname in src/lib/server-host so the dashboard can
// reject unsupported hosts before the server process rejects them.
const INVALID_HOST_CHARACTERS = /[\s/?#]/

export function isValidServerHost(host: string | null | undefined): boolean {
  const normalizedHost = host?.trim() ?? ''
  return !normalizedHost || !INVALID_HOST_CHARACTERS.test(normalizedHost)
}

export function resolveEffectiveServerHost(
  host: string | undefined,
  settingsHost: string | null | undefined,
): string {
  if (host === undefined) return settingsHost?.trim() ?? ''
  return host.trim()
}
