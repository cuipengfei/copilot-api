import { describe, expect, mock, test } from 'bun:test'

import {
  checkReleaseUpdate,
  getReleaseUpdate,
  isNewerStableVersion,
  LATEST_RELEASE_API,
} from '../electron/release-update'

const release = {
  tag_name: 'v2.6.29',
  draft: false,
  prerelease: false,
  html_url: 'https://example.com/untrusted',
  assets: [
    { name: 'Copilot-API-2.6.29-linux-x86_64.AppImage' },
    { name: 'Copilot.API-2.6.29-arm64.dmg' },
    { name: 'Copilot.API.Setup.2.6.29.exe' },
  ],
}

describe('stable release selection', () => {
  test.each([
    ['2.6.30', '2.6.29', true],
    ['2.10.0', '2.9.9', true],
    ['3.0.0', '2.99.99', true],
    ['2.6.29', '2.6.29', false],
    ['2.6.28', '2.6.29', false],
    ['2.5.99', '2.6.29', false],
    ['1.99.99', '2.6.29', false],
    ['v2.6.29', '2.6.29-beta.1', true],
    ['2.6.30-beta.1', '2.6.29', false],
    ['2.6.29+build.2', '2.6.29+build.1', false],
    ['latest', '2.6.29', false],
    ['2.6.30', 'unknown', false],
    ['2.06.30', '2.6.29', false],
  ])('compares %s to %s', (candidate, current, expected) => {
    expect(isNewerStableVersion(candidate, current)).toBe(expected)
  })

  test.each([
    ['win32', 'x64'],
    ['darwin', 'arm64'],
    ['linux', 'x64'],
  ] as const)(
    'finds the supplied v2.6.29 installer on %s',
    (platform, arch) => {
      expect(getReleaseUpdate(release, '2.6.28', platform, arch)).toEqual({
        version: '2.6.29',
        releaseUrl:
          'https://github.com/caozhiyuan/copilot-api/releases/tag/v2.6.29',
      })
    },
  )

  test('does not offer an incompatible architecture or missing installer', () => {
    expect(getReleaseUpdate(release, '2.6.28', 'darwin', 'x64')).toBeNull()
    expect(getReleaseUpdate(release, '2.6.28', 'win32', 'arm64')).toBeNull()
    expect(getReleaseUpdate(release, '2.6.28', 'linux', 'arm64')).toBeNull()
    expect(getReleaseUpdate(release, '2.6.28', 'freebsd', 'x64')).toBeNull()
    expect(
      getReleaseUpdate({ ...release, assets: [] }, '2.6.28', 'win32', 'x64'),
    ).toBeNull()
    expect(
      getReleaseUpdate(
        { ...release, assets: [null, 'installer'] },
        '2.6.28',
        'win32',
        'x64',
      ),
    ).toBeNull()
  })

  test.each([
    null,
    'invalid',
    {},
    { ...release, draft: true },
    { ...release, prerelease: true },
    { ...release, tag_name: 29 },
    { ...release, tag_name: 'v2.6.29-beta' },
    { ...release, assets: null },
  ])('ignores malformed, draft and prerelease responses', (candidate) => {
    expect(getReleaseUpdate(candidate, '2.6.28', 'win32', 'x64')).toBeNull()
  })

  test('ignores the current or an older release', () => {
    expect(getReleaseUpdate(release, '2.6.29', 'win32', 'x64')).toBeNull()
    expect(getReleaseUpdate(release, '2.7.0', 'win32', 'x64')).toBeNull()
  })

  test('uses a bounded unauthenticated GitHub request and validates its response', async () => {
    const fetchRelease = mock((_url: string, options?: RequestInit) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      return Promise.resolve(Response.json(release))
    })
    expect(
      await checkReleaseUpdate(fetchRelease, '2.6.28', 'darwin', 'arm64'),
    ).toMatchObject({ version: '2.6.29' })
    expect(fetchRelease).toHaveBeenCalledWith(
      LATEST_RELEASE_API,
      expect.objectContaining({
        headers: { Accept: 'application/vnd.github+json' },
      }),
    )
  })

  test('reports HTTP and malformed JSON errors', async () => {
    await expect(
      checkReleaseUpdate(
        () => Promise.resolve(new Response('', { status: 403 })),
        '2.6.28',
        'win32',
        'x64',
      ),
    ).rejects.toThrow('HTTP 403')
    await expect(
      checkReleaseUpdate(
        () => Promise.resolve(new Response('bad JSON')),
        '2.6.28',
        'win32',
        'x64',
      ),
    ).rejects.toThrow()
  })
})
