import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

test('uses new installation defaults and OS login state without a settings file', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-api-settings-'))
  const moduleUrl = pathToFileURL(
    path.join(import.meta.dir, '../electron/settings-store.ts'),
  ).href
  const script = `
    import { readSettings, readSettingsSync, setLaunchAtLoginFallback } from ${JSON.stringify(moduleUrl)}
    setLaunchAtLoginFallback(true)
    const syncSettings = readSettingsSync()
    const asyncSettings = await readSettings()
    process.stdout.write(JSON.stringify([
      syncSettings.launchAtLogin,
      asyncSettings.launchAtLogin,
      syncSettings.serverRuntime,
      asyncSettings.serverRuntime,
    ]))
  `

  try {
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('[true,true,"bun","bun"]')
  } finally {
    await fs.rm(home, { force: true, recursive: true })
  }
})

test('preserves legacy system proxy settings and persists an explicit runtime selection', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-api-settings-'))
  const settingsPath = path.join(
    home,
    '.local',
    'share',
    'copilot-api',
    'desktop-config.json',
  )
  const proxy = {
    mode: 'system',
    http_proxy: 'http://127.0.0.1:7890',
    https_proxy: 'http://127.0.0.1:7890',
    no_proxy: 'localhost,127.0.0.1',
  }
  const moduleUrl = pathToFileURL(
    path.join(import.meta.dir, '../electron/settings-store.ts'),
  ).href
  const script = `
    import fs from 'node:fs/promises'
    import { readSettings, readSettingsSync, writeSettings } from ${JSON.stringify(moduleUrl)}
    const settingsPath = ${JSON.stringify(settingsPath)}
    const original = await fs.readFile(settingsPath, 'utf8')
    const syncSettings = readSettingsSync()
    const asyncSettings = await readSettings()
    const unchangedAfterRead = (await fs.readFile(settingsPath, 'utf8')) === original
    await writeSettings({ ...asyncSettings, verbose: true })
    const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    await writeSettings({ ...asyncSettings, serverRuntime: 'bun' })
    process.stdout.write(JSON.stringify({
      legacyRuntimes: [syncSettings.serverRuntime, asyncSettings.serverRuntime],
      proxy: asyncSettings.proxy,
      autoStartServer: asyncSettings.autoStartServer,
      unchangedAfterRead,
      persistedRuntime: persisted.serverRuntime,
      persistedProxy: persisted.proxy,
      selectedRuntimes: [readSettingsSync().serverRuntime, (await readSettings()).serverRuntime],
    }))
  `

  try {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ proxy, autoStartServer: true }),
    )
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      legacyRuntimes: ['node', 'node'],
      proxy,
      autoStartServer: true,
      unchangedAfterRead: true,
      persistedRuntime: 'node',
      persistedProxy: proxy,
      selectedRuntimes: ['bun', 'bun'],
    })
  } finally {
    await fs.rm(home, { force: true, recursive: true })
  }
})

test('trims the configured listening host', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-api-settings-'))
  const moduleUrl = pathToFileURL(
    path.join(import.meta.dir, '../electron/settings-store.ts'),
  ).href
  const script = [
    'import { normalizeSettings } from ' + JSON.stringify(moduleUrl),
    'process.stdout.write(JSON.stringify([',
    "  normalizeSettings({ host: '  0.0.0.0  ' }).host,",
    "  normalizeSettings({ host: '' }).host,",
    '  normalizeSettings(null).host,',
    '  normalizeSettings({ host: 42 }).host,',
    ']))',
  ].join('\n')

  try {
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('["0.0.0.0","","",""]')
  } finally {
    await fs.rm(home, { force: true, recursive: true })
  }
})
