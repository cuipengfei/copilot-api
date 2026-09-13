import { utilityProcess, app } from 'electron'
import type { UtilityProcess } from 'electron'
import net from 'node:net'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type { DesktopProxySettings, ServerStatus } from '../src/types/ipc'
import {
  DEFAULT_SERVER_HOST,
  formatServerUrl,
  isInvalidBindErrorCode,
  normalizeServerHostname,
  resolveClientHostnameOrDefault,
} from '../../src/lib/server-host'
import { applyDesktopProxySettingsToEnv } from './electron-proxy-config'
import { tMain } from './i18n'
import { buildServerStartArgs } from './server-start-args'

let serverProcess: UtilityProcess | null = null
let currentPort = 4141
let currentHost = ''
let statusCallback: ((status: ServerStatus) => void) | null = null
let logCallback: ((log: string) => void) | null = null
// Ring buffer for logs, capped at 2000 entries for log panel replay.
const LOG_BUFFER_MAX = 2000
const STOP_TIMEOUT_MS = 5000
const logBuffer: string[] = []
const ESC_CHAR_CODE = 27
const BEL_CHAR_CODE = 7
const CSI_CHAR_CODE = 0x9b

function codeAt(input: string, index: number): number {
  return input.codePointAt(index) ?? -1
}

function skipCsiSequence(input: string, startIndex: number): number {
  const inputLength = input.length
  let index = startIndex

  while (index < inputLength) {
    const code = codeAt(input, index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
    index += 1
  }

  return inputLength
}

function skipStringTerminatedSequence(
  input: string,
  startIndex: number,
): number {
  const inputLength = input.length
  let index = startIndex

  while (index < inputLength) {
    const code = codeAt(input, index)

    if (code === BEL_CHAR_CODE) return index + 1
    if (code === ESC_CHAR_CODE && codeAt(input, index + 1) === 92) {
      return Math.min(index + 2, inputLength)
    }

    index += 1
  }

  return inputLength
}

function stripAnsi(input: string): string {
  const inputLength = input.length
  let lastIndex = 0
  let index = 0
  let stripped = false
  const parts: Array<string> = []

  while (index < inputLength) {
    const code = codeAt(input, index)
    if (code !== ESC_CHAR_CODE && code !== CSI_CHAR_CODE) {
      index += 1
      continue
    }

    stripped = true
    if (index > lastIndex) parts.push(input.slice(lastIndex, index))

    if (code === CSI_CHAR_CODE) {
      index = skipCsiSequence(input, index + 1)
      lastIndex = index
      continue
    }

    const next = input[index + 1]
    if (next === '[') {
      index = skipCsiSequence(input, index + 2)
      lastIndex = index
      continue
    }

    if (
      next === ']'
      || next === 'P'
      || next === 'X'
      || next === '^'
      || next === '_'
    ) {
      index = skipStringTerminatedSequence(input, index + 2)
      lastIndex = index
      continue
    }

    index = Math.min(index + 2, inputLength)
    lastIndex = index
  }

  if (!stripped) return input
  if (lastIndex < inputLength) parts.push(input.slice(lastIndex))
  return parts.join('')
}

function emitLog(message: string): void {
  const sanitizedMessage = stripAnsi(message)
  if (sanitizedMessage.length === 0) return

  logBuffer.push(sanitizedMessage)
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift()
  logCallback?.(sanitizedMessage)
}

function createLogStream() {
  const decoder = new StringDecoder('utf8')
  let flushed = false

  return {
    handleData: (data: Buffer) => {
      emitLog(decoder.write(data))
    },
    flush: () => {
      if (flushed) return
      flushed = true
      emitLog(decoder.end())
    },
  }
}

export function onStatusChange(cb: (status: ServerStatus) => void): void {
  statusCallback = cb
}

export function onLog(cb: (log: string) => void): void {
  logCallback = cb
}

type PortProbeResult = { available: true } | { available: false; code?: string }

function checkPortAvailable(
  port: number,
  hostname: string,
): Promise<PortProbeResult> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err: NodeJS.ErrnoException) =>
      resolve({ available: false, code: err?.code }),
    )
    server.once('listening', () => {
      server.close()
      resolve({ available: true })
    })
    // Probe the address the server process will actually bind. A wildcard
    // probe refuses hosts the server could still bind (::1 or 127.0.0.1 while
    // another process holds 0.0.0.0) and misses loopback-only listeners.
    server.listen(port, hostname)
  })
}

function getServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'main.js')
  }
  // In development, use dist/main.js from the project root.
  return path.join(app.getAppPath(), '..', 'dist', 'main.js')
}

export async function startServer(
  port: number,
  githubToken: string | null,
  serverOptions?: {
    verbose?: boolean
    showToken?: boolean
    host?: string
    proxy?: DesktopProxySettings
  },
): Promise<ServerStatus> {
  const host = serverOptions?.host?.trim() ?? ''
  let bindHostname: string
  try {
    bindHostname = host ? normalizeServerHostname(host) : DEFAULT_SERVER_HOST
  } catch {
    return {
      running: false,
      error: await tMain('server.invalidHost'),
    }
  }
  // Validate the host before touching a running server, so an invalid host
  // never stops a healthy instance.
  // When the port changes, a conflicting listener cannot be our own
  // previous instance. Probe first so an occupied new port fails fast
  // without stopping the running server. The same-port case still stops
  // first, because our own listener would otherwise report as a conflict
  // (including wildcard/loopback overlap on the same port).
  if (serverProcess && port !== currentPort) {
    const preProbe = await checkPortAvailable(port, bindHostname)
    if (!preProbe.available) {
      if (isInvalidBindErrorCode(preProbe.code)) {
        return {
          running: false,
          error: await tMain('server.invalidHost'),
        }
      }
      return {
        running: false,
        error: await tMain('server.portInUse', { port }),
      }
    }
  }

  // Stop the previous instance first, so its own listener is never reported as
  // a conflicting process holding the port.
  if (serverProcess) {
    await stopServer()
  }

  const probe = await checkPortAvailable(port, bindHostname)
  if (!probe.available) {
    if (isInvalidBindErrorCode(probe.code)) {
      return {
        running: false,
        error: await tMain('server.invalidHost'),
      }
    }
    return {
      running: false,
      error: await tMain('server.portInUse', { port }),
    }
  }

  // Clear the previous log buffer before each new server start.
  logBuffer.length = 0

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
  }
  const normalizedGithubToken = githubToken?.trim()
  if (normalizedGithubToken) {
    // Never pass the token as an argument: process arguments are readable by
    // every local user through the process list.
    env.COPILOT_API_GITHUB_TOKEN = normalizedGithubToken
  } else {
    // Drop any inherited value, otherwise a token exported in the shell that
    // launched the app would silently switch the server to Copilot mode and
    // ignore the configured providers.
    delete env.COPILOT_API_GITHUB_TOKEN
  }
  const proxyEnabled =
    serverOptions?.proxy ?
      applyDesktopProxySettingsToEnv(env, serverOptions.proxy)
    : false

  const serverPath = getServerPath()
  const args = buildServerStartArgs(port, host)
  if (proxyEnabled) args.push('--proxy-env')
  if (serverOptions?.verbose) args.push('--verbose')
  if (serverOptions?.showToken) args.push('--show-token')

  // utilityProcess.fork is an official Electron API and does not start another
  // Electron instance, so packaged macOS builds do not show a second Dock icon.
  const proc = utilityProcess.fork(serverPath, args, {
    env,
    stdio: 'pipe',
    serviceName: 'copilot-api-server',
  })
  serverProcess = proc

  // Decode streamed UTF-8 safely so chunk boundaries do not corrupt Chinese or box-drawing characters.
  const stdoutLogStream = createLogStream()
  const stderrLogStream = createLogStream()

  proc.stdout?.on('data', stdoutLogStream.handleData)
  proc.stdout?.once('end', stdoutLogStream.flush)
  proc.stdout?.once('close', stdoutLogStream.flush)
  proc.stderr?.on('data', stderrLogStream.handleData)
  proc.stderr?.once('end', stderrLogStream.flush)
  proc.stderr?.once('close', stderrLogStream.flush)

  // Wait for the server to become ready while also detecting early process exit.
  const startResult = await waitForServer(host, port, proc)
  if (!startResult.ok) {
    proc.kill()
    if (serverProcess === proc) {
      serverProcess = null
    }
    const msg =
      startResult.exitCode !== undefined ?
        await tMain('server.startFailed', { code: startResult.exitCode })
      : await tMain('server.startTimeout', { port })
    return { running: false, error: msg }
  }

  // Register the runtime exit handler only after startup succeeds.
  proc.on('exit', (code) => {
    stdoutLogStream.flush()
    stderrLogStream.flush()
    if (serverProcess !== proc) return

    serverProcess = null

    if (code === 0) {
      statusCallback?.({ running: false })
      return
    }

    void tMain('server.processExit', { code: String(code ?? 'unknown') }).then(
      (error) => {
        statusCallback?.({
          running: false,
          error,
        })
      },
    )
  })

  currentPort = port
  currentHost = host

  return { running: true, port, host }
}

// Wait for server readiness or process exit, whichever happens first.
async function waitForServer(
  host: string,
  port: number,
  proc: UtilityProcess,
): Promise<{ ok: boolean; exitCode?: number }> {
  return new Promise((resolve) => {
    let settled = false

    const finish = (result: { ok: boolean; exitCode?: number }) => {
      if (settled) return
      settled = true
      proc.removeListener('exit', onExit)
      resolve(result)
    }

    const onExit = (code: number) => {
      finish({ ok: false, exitCode: code ?? undefined })
    }

    proc.once('exit', onExit)

    ;(async () => {
      const url = `${formatServerUrl(resolveClientHostnameOrDefault(host), port)}/`
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((r) => setTimeout(r, 500))
        if (settled) return
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
          if (res.ok || res.status === 404) {
            finish({ ok: true })
            return
          }
        } catch {
          // Keep waiting.
        }
      }
      finish({ ok: false }) // Timed out.
    })().catch(() => finish({ ok: false }))
  })
}

function waitForProcessExit(proc: UtilityProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      proc.removeListener('exit', onExit)
      resolve()
    }

    const onExit = () => finish()
    const timeout = setTimeout(finish, STOP_TIMEOUT_MS)

    proc.once('exit', onExit)
    if (!proc.kill()) finish()
  })
}

export async function stopServer(): Promise<void> {
  if (!serverProcess) return
  const proc = serverProcess
  await waitForProcessExit(proc)

  if (serverProcess === proc) {
    serverProcess = null
    statusCallback?.({ running: false })
  }
}

export function isRunning(): boolean {
  return serverProcess !== null
}

export function clearCallbacks(): void {
  statusCallback = null
  logCallback = null
}

export function getPort(): number {
  return currentPort
}

export function getHost(): string {
  return currentHost
}

export function getServerBaseUrl(): string {
  return formatServerUrl(
    resolveClientHostnameOrDefault(currentHost),
    currentPort,
  )
}

export function getLogs(): string[] {
  return [...logBuffer]
}
