import { isIP } from "node:net"

export const DEFAULT_SERVER_HOST = "127.0.0.1"

export interface ServerBinding {
  hostname: string
  networkExposed: boolean
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1)
  }
  return hostname
}

function isLoopbackIpv4(hostname: string): boolean {
  return isIP(hostname) === 4 && hostname.split(".", 1)[0] === "127"
}

function isLoopbackMappedIpv4(hostname: string): boolean {
  try {
    const canonicalHostname = new URL(`http://[${hostname}]/`).hostname.slice(
      1,
      -1,
    )
    const mappedIpv4 = canonicalHostname.match(
      /^::ffff:([\da-f]{1,4}):[\da-f]{1,4}$/,
    )
    if (!mappedIpv4) {
      return false
    }

    return (Number.parseInt(mappedIpv4[1], 16) & 0xff00) === 0x7f00
  } catch {
    return false
  }
}

export function normalizeServerHostname(hostname: string): string {
  const normalized = stripIpv6Brackets(hostname.trim())
  if (!normalized || /[\s/?#]/.test(normalized)) {
    throw new Error(`Invalid server host: ${JSON.stringify(hostname)}`)
  }
  return normalized
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeServerHostname(hostname).toLowerCase()
  if (normalized === "localhost" || normalized === "localhost.") {
    return true
  }
  if (isLoopbackIpv4(normalized)) {
    return true
  }
  if (isIP(normalized) !== 6) {
    return false
  }

  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true
  }

  return isLoopbackMappedIpv4(normalized)
}

export function resolveServerBinding(
  hostname: string,
  hasApiKeys: boolean,
): ServerBinding {
  const normalizedHostname = normalizeServerHostname(hostname)
  const networkExposed = !isLoopbackHostname(normalizedHostname)

  if (networkExposed && !hasApiKeys) {
    throw new Error(
      `Refusing to listen on non-loopback host ${JSON.stringify(normalizedHostname)} without gateway API keys. Run \`npx copilot-api auth keys --add <key>\` first, or use \`--host ${DEFAULT_SERVER_HOST}\`.`,
    )
  }

  return { hostname: normalizedHostname, networkExposed }
}

export function formatServerUrl(hostname: string, port: number): string {
  const urlHostname =
    isIP(hostname) === 6 ? `[${hostname.replace("%", "%25")}]` : hostname
  return `http://${urlHostname}:${port}`
}
