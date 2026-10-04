import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

function runManagerScenario(scenario: string): void {
  // Use the real manager without inheriting other suites' Electron/IPC mocks.
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      '--eval',
      `
      import assert from 'node:assert/strict'
      import { mock } from 'bun:test'
      import { EventEmitter } from 'node:events'
      let stopExitCode = 0
      let forkError
      let startupExitCode
      const processes = []
      await mock.module('electron', () => ({
        app: { isPackaged: false, getAppPath: () => process.cwd() },
        utilityProcess: { fork() {
          if (forkError) throw forkError
          const proc = new EventEmitter()
          Object.assign(proc, {
            stdout: null, stderr: null,
            kill() { queueMicrotask(() => proc.emit('exit', stopExitCode)); return true },
          })
          processes.push(proc)
          if (startupExitCode !== undefined) {
            queueMicrotask(() => proc.emit('exit', startupExitCode))
          }
          return proc
        } },
      }))
      await mock.module('./electron/i18n', () => ({
        tMain: (key, vars) => Promise.resolve(key + (vars ? ':' + JSON.stringify(vars) : '')),
      }))
      globalThis.fetch = () => Promise.resolve(new Response('ready'))
      const manager = await import('./electron/server-manager')
      const events = []
      manager.onStatusChange((status) => events.push(status))
      try {
        ${scenario}
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
}

test.each([0, 1])(
  'broadcasts a planned proxy restart when termination exits with code %i',
  (exitCode) => {
    runManagerScenario(`
      stopExitCode = ${exitCode}
      const initial = await manager.startServer(0, { host: '127.0.0.1' })
      assert.equal(initial.running, true)
      assert.deepEqual(events, [initial])
      events.length = 0
      const restarted = await manager.startServer(0, {
        host: '0.0.0.0',
        proxy: { mode: 'direct', http_proxy: '', https_proxy: '', no_proxy: '' },
      })
      assert.equal(manager.isRunning(), true)
      assert.deepEqual(events, [{ running: false, restarting: true }, restarted])
      assert.deepEqual(restarted, { running: true, port: 0, host: '0.0.0.0' })
    `)
  },
)

test('broadcasts the startup failure after an automatic restart', () => {
  runManagerScenario(`
    await manager.startServer(0)
    events.length = 0
    startupExitCode = 7
    const status = await manager.startServer(0)
    assert.equal(status.running, false)
    assert.equal(status.error, 'server.startFailed:{"code":7}')
    assert.equal(manager.isRunning(), false)
    assert.deepEqual(events, [{ running: false, restarting: true }, status])
  `)
})

test('broadcasts a terminal failure if launching the replacement process throws', () => {
  runManagerScenario(`
    await manager.startServer(0)
    events.length = 0
    forkError = new Error('cannot launch server')
    await assert.rejects(manager.startServer(0), /cannot launch server/)
    assert.equal(manager.isRunning(), false)
    assert.deepEqual(events, [
      { running: false, restarting: true },
      { running: false, error: 'cannot launch server' },
    ])
  `)
})

test('stops deliberately without reporting a nonzero exit as a crash', () => {
  runManagerScenario(`
    await manager.startServer(0)
    events.length = 0
    stopExitCode = 1
    await manager.stopServer()
    assert.equal(manager.isRunning(), false)
    assert.deepEqual(events, [{ running: false }])
  `)
})

test.each([0, 9])(
  'still broadcasts an unexpected exit with code %i',
  (code) => {
    runManagerScenario(`
    await manager.startServer(0)
    events.length = 0
    processes.at(-1).emit('exit', ${code})
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(manager.isRunning(), false)
    assert.deepEqual(events, [${code === 0 ? '{ running: false }' : '{ running: false, error: \'server.processExit:{"code":"9"}\' }'}])
  `)
  },
)

test('rejects an invalid host without stopping the healthy server', () => {
  runManagerScenario(`
    await manager.startServer(0)
    events.length = 0
    const status = await manager.startServer(0, { host: 'http://bad-host' })
    assert.equal(status.running, false)
    assert.equal(status.error, 'server.invalidHost')
    assert.equal(manager.isRunning(), true)
    assert.deepEqual(events, [])
  `)
})
