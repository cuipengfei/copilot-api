export const RELEASES_URL = 'https://github.com/caozhiyuan/copilot-api/releases'
export const LATEST_RELEASE_API =
  'https://api.github.com/repos/caozhiyuan/copilot-api/releases/latest'

export interface ReleaseUpdate {
  version: string
  releaseUrl: string
}

function parseVersion(value: string) {
  const match =
    /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(
      value,
    )
  if (!match) return null
  return {
    parts: match.slice(1, 4).map(BigInt),
    prerelease: Boolean(match[4]),
  }
}

export function isNewerStableVersion(
  candidate: string,
  current: string,
): boolean {
  const next = parseVersion(candidate)
  const previous = parseVersion(current)
  if (!next || !previous || next.prerelease) return false
  for (let index = 0; index < 3; index += 1) {
    if (next.parts[index] !== previous.parts[index]) {
      return next.parts[index] > previous.parts[index]
    }
  }
  return previous.prerelease
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Only offer releases that actually contain an installer for this machine.
// Construct the link locally rather than opening a URL from remote JSON.
export function getReleaseUpdate(
  release: unknown,
  currentVersion: string,
  platform: NodeJS.Platform,
  arch: string,
): ReleaseUpdate | null {
  if (
    !isRecord(release)
    || release.draft !== false
    || release.prerelease !== false
    || typeof release.tag_name !== 'string'
    || !isNewerStableVersion(release.tag_name, currentVersion)
    || !Array.isArray(release.assets)
  )
    return null

  const version = release.tag_name.replace(/^v/, '')
  const assetName =
    platform === 'win32' && arch === 'x64' ? `Copilot.API.Setup.${version}.exe`
    : platform === 'darwin' && arch === 'arm64' ?
      `Copilot.API-${version}-arm64.dmg`
    : platform === 'linux' && arch === 'x64' ?
      `Copilot-API-${version}-linux-x86_64.AppImage`
    : null
  if (
    !assetName
    || !release.assets.some(
      (asset: unknown) => isRecord(asset) && asset.name === assetName,
    )
  )
    return null

  return {
    version,
    releaseUrl: `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`,
  }
}

export async function checkReleaseUpdate(
  fetchRelease: (url: string, options?: RequestInit) => Promise<Response>,
  currentVersion: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<ReleaseUpdate | null> {
  const response = await fetchRelease(LATEST_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`GitHub release check failed (HTTP ${response.status})`)
  }
  const release: unknown = await response.json()
  return getReleaseUpdate(release, currentVersion, platform, arch)
}
