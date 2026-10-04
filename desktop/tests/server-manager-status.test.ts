import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('broadcasts the bound address after startup and automatic restart', () => {
  // Use the real manager without inheriting other suites' Electron/IPC mocks.
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      '--eval',
      `
      import assert from 'node:assert/strict'
      import { mock } from 'bun:test'
      import { EventEmitter } from 'node:events'
      await mock.module('electron', () => ({
        app: { isPackaged: false, getAppPath: () => process.cwd() },
        utilityProcess: { fork() {
          const proc = new EventEmitter()
          return Object.assign(proc, {
            stdout: null, stderr: null,
            kill() { queueMicrotask(() => proc.emit('exit', 0)); return true },
          })
        } },
      }))
      globalThis.fetch = () => Promise.resolve(new Response('ready'))
      const manager = await import('./electron/server-manager')
      const events = []
      manager.onStatusChange((status) => events.push(status))
      try {
        const initial = await manager.startServer(0, { host: '127.0.0.1' })
        assert.equal(initial.running, true)
        assert.deepEqual(events, [initial])
        events.length = 0
        const restarted = await manager.startServer(0, { host: '0.0.0.0' })
        assert.equal(restarted.running, true)
        assert.equal(manager.isRunning(), true)
        assert.deepEqual(events, [{ running: false }, restarted])
        assert.deepEqual(restarted, { running: true, port: 0, host: '0.0.0.0' })
      } finally {
        manager.clearCallbacks()
        await manager.stopServer()
      }
    `,
    ],
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    timeout: 10_000,
  })
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
})
