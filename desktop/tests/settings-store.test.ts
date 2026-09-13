import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

test('uses the OS fallback when the settings file does not exist', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-api-settings-'))
  const moduleUrl = pathToFileURL(
    path.join(import.meta.dir, '../electron/settings-store.ts'),
  ).href
  const script = `
    import { readSettings, readSettingsSync, setLaunchAtLoginFallback } from ${JSON.stringify(moduleUrl)}
    setLaunchAtLoginFallback(true)
    process.stdout.write(JSON.stringify([
      readSettingsSync().launchAtLogin,
      (await readSettings()).launchAtLogin,
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
    expect(stdout).toBe('[true,true]')
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
