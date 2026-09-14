import type { Instance, UpstreamHeaderSnapshot } from "./lib"

import {
  formatError,
  getBindingKey,
  getHeaderValue,
  isRecord,
  parseModelFromBody,
  parseModelIds,
  parseModelObjects,
  parsePremiumUsageFromUsageJson,
  parseUpstreamHeaderSnapshot,
  parseUpstreamQuotaSnapshots,
} from "./lib"

const DEFAULT_ENCODER = new TextEncoder()

export const DEFAULT_HISTORY_LIMIT = 200
export const DEFAULT_SSE_RETRY_MS = 2000
export const DEFAULT_INSTANCE_COOLDOWN_MS = 18_000_000 // 300 min (5h): exhausted instance (402/429 w/o Retry-After) stays out long enough to skip dead quota

export interface ProxyContext {
  body: string
  req: Request
  url: URL
}

export interface RouteRecord {
  historyId?: string
  ts: string
  sid: string
  agent: string
  model: string
  provider: string
  port: number
  reason: string
  instanceName: string
  usage?: Record<string, unknown> | null
  copilotUsage?: Record<string, unknown> | null
}

export interface StatusPayload {
  instances: Array<{
    name: string
    port: number
    models: Array<string>
    healthy: boolean
    requestCounts: Record<string, number>
    lastActive: string | null
    cooldownUntil: string | null
    remainingCooldownMs: number
    upstreamRetryAfter: string | null
    headerSnapshot: UpstreamHeaderSnapshot
    disabled: boolean
  }>
  sessionBindings: Record<string, number>
  modelToPorts: Record<string, Array<number>>
  routeHistorySize: number
  totalNanoAiuSinceStart: number
}

export interface StickyRouterState {
  instances: Array<Instance>
  portToInstance: Map<number, Instance>
  portToModels: Map<number, Array<string>>
  modelToPorts: Map<string, Array<number>>
  sessionBindings: Map<string, number>
  routeHistory: Array<RouteRecord>
  sseClients: Set<ReadableStreamDefaultController<Uint8Array>>
  portModelCounts: Map<number, Map<string, number>>
  portLastActive: Map<number, string>
  modelDetails: Map<string, Record<string, unknown>>
  portCooldownUntil: Map<number, number>
  portCooldownRetryAfter: Map<number, string | null>
  portHeaderSnapshots: Map<number, UpstreamHeaderSnapshot>
  disabledPorts: Set<number>
  totalNanoAiuSinceStart: number
  historyNanoById: Map<string, number>
}

export interface RouterHandlerOptions {
  state: StickyRouterState
  logger: (line: string) => void
  fetchImpl?: typeof fetch
  now?: () => string
  nowMs?: () => number
  defaultCooldownMs?: number
}

export interface PortSelectionInput {
  sessionId: string | null
  agent: string
  model: string
  nowMs?: number
}

export interface ProxyToOptions {
  port: number
  context: ProxyContext
  logger: (line: string) => void
  fetchImpl?: typeof fetch
  onQuotaSnapshots?: (quotaSnapshots: unknown) => void
  onQuotaExceeded?: () => void
  onUsageResolved?: (payload: {
    usage: Record<string, unknown> | null
    copilotUsage: Record<string, unknown> | null
  }) => void
}

export interface DashboardStaticFile {
  path: string
  file: Bun.BunFile
  contentType: string
}

export interface DashboardHandlerOptions {
  state: StickyRouterState
  logger: (line: string) => void
  dashboardFile: Bun.BunFile
  staticFiles?: ReadonlyArray<DashboardStaticFile>
  fetchImpl?: typeof fetch
  encoder?: TextEncoder
  sseRetryMs?: number
  nowMs?: () => number
}

export function createStickyRouterState(
  instances: Array<Instance>,
): StickyRouterState {
  return {
    instances,
    portToInstance: new Map(
      instances.map((instance) => [instance.port, instance]),
    ),
    portToModels: new Map<number, Array<string>>(),
    modelToPorts: new Map<string, Array<number>>(),
    sessionBindings: new Map<string, number>(),
    routeHistory: [],
    sseClients: new Set<ReadableStreamDefaultController<Uint8Array>>(),
    portModelCounts: new Map<number, Map<string, number>>(),
    portLastActive: new Map<number, string>(),
    modelDetails: new Map<string, Record<string, unknown>>(),
    portCooldownUntil: new Map<number, number>(),
    portCooldownRetryAfter: new Map<number, string | null>(),
    portHeaderSnapshots: new Map<number, UpstreamHeaderSnapshot>(),
    disabledPorts: new Set<number>(),
    totalNanoAiuSinceStart: 0,
    historyNanoById: new Map<string, number>(),
  }
}

const EMPTY_UPSTREAM_HEADER_SNAPSHOT: UpstreamHeaderSnapshot = {
  premiumUsage: null,
  sessionRateLimit: null,
  weeklyRateLimit: null,
}

export function mergeUpstreamHeaderSnapshot(
  previous: UpstreamHeaderSnapshot | undefined,
  next: UpstreamHeaderSnapshot,
): UpstreamHeaderSnapshot {
  if (!previous) {
    return next
  }

  return {
    premiumUsage: next.premiumUsage ?? previous.premiumUsage,
    sessionRateLimit: next.sessionRateLimit ?? previous.sessionRateLimit,
    weeklyRateLimit: next.weeklyRateLimit ?? previous.weeklyRateLimit,
  }
}

export function updateUpstreamHeaderSnapshot(
  state: StickyRouterState,
  port: number,
  headers: Headers,
) {
  const next = parseUpstreamHeaderSnapshot(headers)
  updateUpstreamSnapshot(state, port, next)
}

export function updateUpstreamSnapshot(
  state: StickyRouterState,
  port: number,
  next: UpstreamHeaderSnapshot,
) {
  const previous = state.portHeaderSnapshots.get(port)
  state.portHeaderSnapshots.set(
    port,
    mergeUpstreamHeaderSnapshot(previous, next),
  )
}

export function updateUpstreamQuotaSnapshot(
  state: StickyRouterState,
  port: number,
  quotaSnapshots: unknown,
) {
  updateUpstreamSnapshot(
    state,
    port,
    parseUpstreamQuotaSnapshots(quotaSnapshots),
  )
}

export function getRemainingCooldownMs(
  state: StickyRouterState,
  port: number,
  nowMs: number,
): number {
  const cooldownUntil = state.portCooldownUntil.get(port)
  if (cooldownUntil === undefined) {
    return 0
  }

  const remainingCooldownMs = cooldownUntil - nowMs
  if (remainingCooldownMs <= 0) {
    state.portCooldownUntil.delete(port)
    state.portCooldownRetryAfter.delete(port)
    return 0
  }

  return remainingCooldownMs
}

export function getAvailablePorts(
  state: StickyRouterState,
  ports: Array<number>,
  nowMs: number,
): Array<number> {
  return ports.filter(
    (port) =>
      !state.disabledPorts.has(port)
      && getRemainingCooldownMs(state, port, nowMs) === 0,
  )
}

export function getMinRemainingCooldownMs(
  state: StickyRouterState,
  ports: Array<number>,
  nowMs: number,
): number {
  let minRemaining = Number.POSITIVE_INFINITY

  for (const port of ports) {
    const remainingCooldownMs = getRemainingCooldownMs(state, port, nowMs)
    if (remainingCooldownMs > 0 && remainingCooldownMs < minRemaining) {
      minRemaining = remainingCooldownMs
    }
  }

  return Number.isFinite(minRemaining) ? minRemaining : 0
}

export function parseRetryAfterMs(
  retryAfter: string | null,
  nowMs: number,
): number | null {
  if (!retryAfter) {
    return null
  }

  const value = retryAfter.trim()
  if (!value) {
    return null
  }

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000)
  }

  const dateMs = Date.parse(value)
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs)
  }

  return null
}

export function getStatusPayload(
  state: StickyRouterState,
  nowMs = Date.now(),
): StatusPayload {
  return {
    instances: state.instances.map((instance) => {
      const modelCounts = state.portModelCounts.get(instance.port)
      const requestCounts: Record<string, number> =
        modelCounts ? Object.fromEntries(modelCounts) : {}
      const remainingCooldownMs = getRemainingCooldownMs(
        state,
        instance.port,
        nowMs,
      )
      const cooldownUntil = state.portCooldownUntil.get(instance.port)
      const upstreamRetryAfter = state.portCooldownRetryAfter.get(instance.port)
      return {
        name: instance.name,
        port: instance.port,
        models: state.portToModels.get(instance.port) || [],
        healthy: state.portToModels.has(instance.port),
        requestCounts,
        lastActive: state.portLastActive.get(instance.port) || null,
        cooldownUntil:
          cooldownUntil !== undefined && remainingCooldownMs > 0 ?
            new Date(cooldownUntil).toISOString()
          : null,
        remainingCooldownMs,
        upstreamRetryAfter:
          remainingCooldownMs > 0 ? (upstreamRetryAfter ?? null) : null,
        headerSnapshot:
          state.portHeaderSnapshots.get(instance.port)
          ?? EMPTY_UPSTREAM_HEADER_SNAPSHOT,
        disabled: state.disabledPorts.has(instance.port),
      }
    }),
    sessionBindings: Object.fromEntries(state.sessionBindings),
    modelToPorts: Object.fromEntries(state.modelToPorts),
    routeHistorySize: state.routeHistory.length,
    totalNanoAiuSinceStart: state.totalNanoAiuSinceStart,
  }
}

export function incrementCount(
  state: StickyRouterState,
  port: number,
  model: string,
) {
  const modelCounts =
    state.portModelCounts.get(port) || new Map<string, number>()
  modelCounts.set(model, (modelCounts.get(model) || 0) + 1)
  state.portModelCounts.set(port, modelCounts)
}

export function writeSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: string,
  encoder = DEFAULT_ENCODER,
) {
  controller.enqueue(encoder.encode(payload))
}

export function broadcastSse(
  state: StickyRouterState,
  payload: string,
  encoder = DEFAULT_ENCODER,
) {
  for (const controller of state.sseClients) {
    try {
      writeSse(controller, payload, encoder)
    } catch {
      state.sseClients.delete(controller)
    }
  }
}

export function recordRoute(
  state: StickyRouterState,
  record: RouteRecord,
  options: { historyLimit?: number; encoder?: TextEncoder } = {},
) {
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
  const encoder = options.encoder ?? DEFAULT_ENCODER

  record.historyId ??= createHistoryId()
  state.historyNanoById.set(record.historyId, 0)
  state.routeHistory.push(record)
  if (state.routeHistory.length > historyLimit) {
    state.routeHistory.splice(0, state.routeHistory.length - historyLimit)
  }
  incrementCount(state, record.port, record.model)
  state.portLastActive.set(record.port, record.ts)
  broadcastSse(state, `data: ${JSON.stringify(record)}\n\n`, encoder)
}

function createHistoryId(): string {
  if (
    typeof globalThis.crypto !== "undefined"
    && typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID()
  }

  return `history-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function updateRouteRecord(
  state: StickyRouterState,
  historyId: string | undefined,
  patch: Pick<RouteRecord, "usage" | "copilotUsage">,
  encoder = DEFAULT_ENCODER,
): boolean {
  if (!historyId) {
    return false
  }

  const target = state.routeHistory.find(
    (entry) => entry.historyId === historyId,
  )
  if (!target) {
    return false
  }

  target.usage = patch.usage
  target.copilotUsage = patch.copilotUsage

  const previousNano = state.historyNanoById.get(historyId) ?? 0
  const nextNano = getTotalNanoAiu(patch.copilotUsage ?? null)
  state.historyNanoById.set(historyId, nextNano)
  state.totalNanoAiuSinceStart += nextNano - previousNano

  broadcastSse(
    state,
    `event: history_update\ndata: ${JSON.stringify(target)}\n\n`,
    encoder,
  )
  return true
}

export function clearRouteHistory(
  state: StickyRouterState,
  encoder = DEFAULT_ENCODER,
) {
  state.routeHistory.splice(0)
  state.historyNanoById.clear()
  broadcastSse(
    state,
    `event: reset\ndata: ${JSON.stringify({ target: "history" })}\n\n`,
    encoder,
  )
}

function getTotalNanoAiu(copilotUsage: Record<string, unknown> | null): number {
  if (!copilotUsage) {
    return 0
  }

  const value = Number(copilotUsage.total_nano_aiu)
  if (!Number.isFinite(value)) {
    return 0
  }

  return value
}

export function clearSessionBindings(
  state: StickyRouterState,
  encoder = DEFAULT_ENCODER,
) {
  state.sessionBindings.clear()
  broadcastSse(
    state,
    `event: reset\ndata: ${JSON.stringify({ target: "bindings" })}\n\n`,
    encoder,
  )
}

export function setInstanceDisabled(
  state: StickyRouterState,
  port: number,
  disabled: boolean,
  encoder = DEFAULT_ENCODER,
): void {
  if (disabled) {
    state.disabledPorts.add(port)
  } else {
    state.disabledPorts.delete(port)
  }
  broadcastSse(
    state,
    `event: reset\ndata: ${JSON.stringify({ target: "instances" })}\n\n`,
    encoder,
  )
}

export function createSseResponse(
  state: StickyRouterState,
  req: Request,
  options: { encoder?: TextEncoder; sseRetryMs?: number } = {},
): Response {
  const encoder = options.encoder ?? DEFAULT_ENCODER
  const sseRetryMs = options.sseRetryMs ?? DEFAULT_SSE_RETRY_MS

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      state.sseClients.add(controller)
      writeSse(controller, `retry: ${sseRetryMs}\n\n`, encoder)

      const cleanup = () => {
        state.sseClients.delete(controller)
      }

      req.signal.addEventListener("abort", cleanup, { once: true })
    },
    cancel() {
      return
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  })
}

function getContextWindow(model: Record<string, unknown>): number {
  if (!isRecord(model.limits)) return 0
  const ctx = model.limits.context_window
  return typeof ctx === "number" ? ctx : 0
}

export async function discoverModels(
  state: StickyRouterState,
  logger: (line: string) => void,
  fetchImpl: typeof fetch = fetch,
) {
  state.portToModels.clear()
  state.modelToPorts.clear()
  state.modelDetails.clear()
  state.portHeaderSnapshots.clear()

  for (const inst of state.instances) {
    try {
      const res = await fetchImpl(`http://localhost:${inst.port}/v1/models`)
      const data: unknown = await res.json()
      const models = parseModelIds(data)
      const allowlist = inst.allowedModels
      const filteredModels =
        allowlist !== undefined && allowlist.length > 0 ?
          models.filter((model) => allowlist.includes(model))
        : models
      state.portToModels.set(inst.port, filteredModels)
      for (const model of filteredModels) {
        const ports = state.modelToPorts.get(model) || []
        ports.push(inst.port)
        state.modelToPorts.set(model, ports)
      }
      const modelObjects = parseModelObjects(data)
      const filteredModelObjects =
        allowlist !== undefined && allowlist.length > 0 ?
          modelObjects.filter((obj) =>
            filteredModels.includes(obj.id as string),
          )
        : modelObjects
      for (const obj of filteredModelObjects) {
        const id = obj.id as string
        const existing = state.modelDetails.get(id)
        if (!existing || getContextWindow(obj) > getContextWindow(existing)) {
          state.modelDetails.set(id, obj)
        }
      }
      logger(
        `discovered ${inst.name}:${inst.port} → ${filteredModels.length} models: ${filteredModels.join(", ")}`,
      )
    } catch (error) {
      logger(
        `FAILED to discover ${inst.name}:${inst.port}: ${formatError(error)}`,
      )
    }
  }

  logger(
    `total: ${state.modelToPorts.size} unique models across ${state.portToModels.size} instances`,
  )
}

// ponytail: one-shot startup prefetch only, no runtime refresh
export async function prefetchPremiumUsage(
  state: StickyRouterState,
  logger: (line: string) => void,
  fetchImpl: typeof fetch = fetch,
) {
  for (const inst of state.instances) {
    try {
      const res = await fetchImpl(`http://localhost:${inst.port}/usage`)
      if (!res.ok) {
        logger(
          `prefetch usage ${inst.name}:${inst.port} failed: HTTP ${res.status}`,
        )
        continue
      }
      const payload: unknown = await res.json()
      if (!isRecord(payload)) {
        logger(
          `prefetch usage ${inst.name}:${inst.port} skipped: non-object body`,
        )
        continue
      }
      const snapshots = payload.quota_snapshots
      if (!isRecord(snapshots)) {
        logger(
          `prefetch usage ${inst.name}:${inst.port} skipped: no quota_snapshots`,
        )
        continue
      }
      const premium = snapshots.premium_interactions
      // unlimited accounts carry no finite quota; leave null so dashboard shows u:-/t:-
      if (isRecord(premium) && premium.unlimited === true) {
        logger(`prefetch usage ${inst.name}:${inst.port} skipped: unlimited`)
        continue
      }
      // /usage JSON has no reset_date; parse only the 3 fields u/t math needs
      const premiumUsage = parsePremiumUsageFromUsageJson(premium)
      if (!premiumUsage) {
        logger(
          `prefetch usage ${inst.name}:${inst.port} skipped: unparseable premium_interactions`,
        )
        continue
      }
      updateUpstreamSnapshot(state, inst.port, {
        premiumUsage,
        sessionRateLimit: null,
        weeklyRateLimit: null,
      })
      logger(
        `prefetched usage ${inst.name}:${inst.port} → u:${premiumUsage.used}/t:${premiumUsage.total}`,
      )
    } catch (error) {
      logger(
        `prefetch usage ${inst.name}:${inst.port} failed: ${formatError(error)}`,
      )
    }
  }
}

export function getTotalRequestCount(
  state: StickyRouterState,
  port: number,
): number {
  const modelCounts = state.portModelCounts.get(port)
  if (!modelCounts) return 0
  let total = 0
  for (const count of modelCounts.values()) {
    total += count
  }
  return total
}

export function pickLeastLoaded(
  state: StickyRouterState,
  ports: Array<number>,
): number {
  let minCount = Number.POSITIVE_INFINITY
  let candidates: Array<number> = []

  for (const port of ports) {
    const count = getTotalRequestCount(state, port)
    if (count < minCount) {
      minCount = count
      candidates = [port]
    } else if (count === minCount) {
      candidates.push(port)
    }
  }

  return candidates[Math.floor(Math.random() * candidates.length)]
}

export function pickPort(
  state: StickyRouterState,
  input: PortSelectionInput,
): { port: number; reason: string; bindingKey: string | null } | null {
  const { sessionId, agent, model } = input
  const nowMs = input.nowMs ?? Date.now()
  const ports = state.modelToPorts.get(model)
  if (!ports || ports.length === 0) {
    return null
  }

  const availablePorts = getAvailablePorts(state, ports, nowMs)
  if (availablePorts.length === 0) {
    return null
  }

  const bindingKey = getBindingKey(sessionId, agent, model)

  if (bindingKey) {
    const bound = state.sessionBindings.get(bindingKey)
    if (bound !== undefined && availablePorts.includes(bound)) {
      return { port: bound, reason: "sticky", bindingKey }
    }
  }

  const port = pickLeastLoaded(state, availablePorts)

  const hadBinding = bindingKey ? state.sessionBindings.has(bindingKey) : false
  if (bindingKey) {
    state.sessionBindings.set(bindingKey, port)
  }

  return { port, reason: hadBinding ? "rebalance" : "new", bindingKey }
}

export function getInstanceName(
  state: StickyRouterState,
  port: number,
): string {
  return state.portToInstance.get(port)?.name || `:${port}`
}

function observeResponsesSseMetadata(
  body: ReadableStream<Uint8Array> | null,
  callbacks: {
    onQuotaSnapshots?: (quotaSnapshots: unknown) => void
    onQuotaExceeded?: () => void
    onUsageResolved?: (payload: {
      usage: Record<string, unknown> | null
      copilotUsage: Record<string, unknown> | null
    }) => void
  } = {},
): ReadableStream<Uint8Array> | null {
  const { onQuotaExceeded, onQuotaSnapshots, onUsageResolved } = callbacks
  if (!body || (!onQuotaSnapshots && !onQuotaExceeded && !onUsageResolved)) {
    return body
  }

  const decoder = new TextDecoder()
  let buffered = ""
  let latestChatCopilotUsage: Record<string, unknown> | null = null

  const inspectEvent = (eventText: string) => {
    const data = eventText
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")

    if (!data || data === "[DONE]") {
      return
    }

    try {
      const parsed = JSON.parse(data) as {
        type?: unknown
        code?: unknown
        error?: { code?: unknown }
        copilot_quota_snapshots?: unknown
        usage?: unknown
        copilot_usage?: unknown
        choices?: unknown
        response?: unknown
      }
      if (parsed.copilot_quota_snapshots && onQuotaSnapshots) {
        onQuotaSnapshots(parsed.copilot_quota_snapshots)
      }
      const isResponsesTerminal =
        parsed.type === "response.completed"
        || parsed.type === "response.incomplete"
        || parsed.type === "response.failed"
      const isMessageTerminal = parsed.type === "message_delta"
      const isChatChunk = Array.isArray(parsed.choices)

      if (isChatChunk && isRecord(parsed.copilot_usage)) {
        latestChatCopilotUsage = {
          ...latestChatCopilotUsage,
          ...Object.fromEntries(
            Object.entries(parsed.copilot_usage).filter(
              ([, value]) => value !== null && value !== undefined,
            ),
          ),
        }
      }

      if (
        (isResponsesTerminal
          || isMessageTerminal
          || (isChatChunk && isRecord(parsed.usage)))
        && onUsageResolved
      ) {
        const usage =
          (isMessageTerminal || isChatChunk) && isRecord(parsed.usage) ?
            parsed.usage
          : isRecord(parsed.response) && isRecord(parsed.response.usage) ?
            parsed.response.usage
          : null
        const copilotUsage =
          isChatChunk ? latestChatCopilotUsage
          : isRecord(parsed.copilot_usage) ? parsed.copilot_usage
          : (
            isRecord(parsed.response) && isRecord(parsed.response.copilot_usage)
          ) ?
            parsed.response.copilot_usage
          : null
        onUsageResolved({ usage, copilotUsage })
      }
      if (
        parsed.code === "quota_exceeded"
        || parsed.error?.code === "quota_exceeded"
      ) {
        onQuotaExceeded?.()
      }
    } catch {
      return
    }
  }

  const inspectText = (text: string, flush = false) => {
    buffered += text

    for (;;) {
      const separator = buffered.search(/\r?\n\r?\n/u)
      if (separator === -1) break
      const eventText = buffered.slice(0, separator)
      const separatorLength = buffered[separator] === "\r" ? 4 : 2
      buffered = buffered.slice(separator + separatorLength)
      inspectEvent(eventText)
    }

    if (flush && buffered.trim()) {
      inspectEvent(buffered)
      buffered = ""
    }
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        inspectText(decoder.decode(chunk, { stream: true }))
        controller.enqueue(chunk)
      },
      flush() {
        inspectText(decoder.decode(), true)
      },
    }),
  )
}

export async function proxyTo(options: ProxyToOptions): Promise<Response> {
  const { port, context, logger } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const { body, req, url } = context
  const targetUrl = `http://localhost:${port}${url.pathname}${url.search}`
  const headers = new Headers(req.headers)
  headers.delete("host")

  try {
    const upstream = await fetchImpl(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    })

    const contentType = upstream.headers.get("content-type") || ""
    if (contentType.includes("application/json") && options.onUsageResolved) {
      try {
        const parsed = await upstream.clone().json()
        const usage =
          isRecord(parsed) && isRecord(parsed.usage) ? parsed.usage : null
        const copilotUsage =
          isRecord(parsed) && isRecord(parsed.copilot_usage) ?
            parsed.copilot_usage
          : null
        options.onUsageResolved({ usage, copilotUsage })
      } catch {
        options.onUsageResolved({ usage: null, copilotUsage: null })
      }
    }

    const responseBody =
      contentType.includes("text/event-stream") ?
        observeResponsesSseMetadata(upstream.body, {
          onQuotaSnapshots: options.onQuotaSnapshots,
          onQuotaExceeded: options.onQuotaExceeded,
          onUsageResolved: options.onUsageResolved,
        })
      : upstream.body

    return new Response(responseBody, {
      status: upstream.status,
      headers: upstream.headers,
    })
  } catch (error) {
    logger(`PROXY ERROR → :${port}: ${formatError(error)}`)
    return Response.json(
      { error: `upstream connection failed on port ${port}` },
      { status: 502 },
    )
  }
}

interface RouterRuntime {
  state: StickyRouterState
  logger: (line: string) => void
  fetchImpl: typeof fetch
  now: () => string
  nowMs: () => number
  defaultCooldownMs: number
}

interface RouterRequestContext {
  req: Request
  url: URL
  bodyText: string
  sessionId: string | null
  agent: string
  provider: string
  model: string
  requestNowMs: number
}

function handleBuiltinRoutes(
  runtime: RouterRuntime,
  req: Request,
  url: URL,
): Response | null {
  if (url.pathname === "/status" && req.method === "GET") {
    return Response.json(getStatusPayload(runtime.state, runtime.nowMs()))
  }

  if (url.pathname === "/v1/models" && req.method === "GET") {
    const allModels = new Set<string>()
    for (const models of runtime.state.portToModels.values()) {
      for (const model of models) {
        allModels.add(model)
      }
    }

    return Response.json({
      object: "list",
      data: [...allModels].map((id) => {
        const details = runtime.state.modelDetails.get(id)
        return details ?? { id, object: "model" }
      }),
    })
  }

  return null
}

function buildRequestContext(params: {
  req: Request
  url: URL
  bodyText: string
  requestNowMs: number
}): RouterRequestContext {
  const headerSessionId = (
    [
      "x-session-id",
      "x-claude-code-session-id",
      "session-id",
      "session_id",
    ] as const
  )
    .map((name) => params.req.headers.get(name)?.trim())
    .find(Boolean)
  let bodySessionId: string | null = null
  if (!headerSessionId) {
    try {
      const body: unknown = JSON.parse(params.bodyText)
      if (isRecord(body) && typeof body.prompt_cache_key === "string") {
        bodySessionId = body.prompt_cache_key.trim() || null
      }
    } catch {
      // Non-JSON bodies have no prompt cache key.
    }
  }
  const sessionId = headerSessionId ?? bodySessionId
  const agent = getHeaderValue(params.req, "x-oc-agent")
  const provider = getHeaderValue(params.req, "x-oc-provider")
  const headerModel = getHeaderValue(params.req, "x-oc-model")
  const model =
    parseModelFromBody(params.bodyText)
    || (headerModel === "_" ? "" : headerModel)

  return {
    req: params.req,
    url: params.url,
    bodyText: params.bodyText,
    sessionId,
    agent,
    provider,
    model,
    requestNowMs: params.requestNowMs,
  }
}

// 429 = upstream rate-limit, 402 = quota/credit exhausted (new
// X-GitHub-Api-Version quota_exceeded semantics). Both mean this instance
// cannot serve now, so cool it down and stop routing here.
const COOLDOWN_STATUSES = new Set([429, 402])

function applyCooldownOnExhaustion(
  runtime: RouterRuntime,
  proxied: Response,
  params: {
    port: number
    instanceName: string
    model: string
    requestNowMs: number
  },
): boolean {
  if (!COOLDOWN_STATUSES.has(proxied.status)) {
    return false
  }

  // 402 has no Retry-After; falls back to defaultCooldownMs below.
  applyCooldown(runtime, {
    ...params,
    status: proxied.status,
    retryAfter: proxied.headers.get("Retry-After"),
  })
  return true
}

function applyCooldown(
  runtime: RouterRuntime,
  params: {
    port: number
    instanceName: string
    model: string
    requestNowMs: number
    status: number
    retryAfter: string | null
  },
) {
  const retryAfterMs = parseRetryAfterMs(params.retryAfter, params.requestNowMs)
  const cooldownMs = retryAfterMs ?? runtime.defaultCooldownMs
  const cooldownUntilMs = params.requestNowMs + cooldownMs

  runtime.state.portCooldownUntil.set(params.port, cooldownUntilMs)
  runtime.state.portCooldownRetryAfter.set(params.port, params.retryAfter)
  runtime.logger(
    `cooldown set instance=${params.instanceName}:${params.port} model=${params.model} status=${params.status} until=${new Date(cooldownUntilMs).toISOString()} retry-after=${params.retryAfter || "_"}`,
  )
}

function applyCooldownOnStreamQuotaExceeded(
  runtime: RouterRuntime,
  params: {
    port: number
    instanceName: string
    model: string
    requestNowMs: number
  },
) {
  applyCooldown(runtime, {
    ...params,
    status: 402,
    retryAfter: null,
  })
}

function createAllCoolingResponse(
  runtime: RouterRuntime,
  params: {
    sessionId: string | null
    agent: string
    provider: string
    model: string
    ports: Array<number>
    requestNowMs: number
    error: string
  },
): Response | null {
  const minRemainingCooldownMs = getMinRemainingCooldownMs(
    runtime.state,
    params.ports,
    params.requestNowMs,
  )
  if (minRemainingCooldownMs <= 0) {
    return null
  }

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(minRemainingCooldownMs / 1000),
  )
  runtime.logger(
    `ALL COOLDOWN sid=${params.sessionId || "-"} agent=${params.agent} model=${params.model} provider=${params.provider} retry-after=${retryAfterSeconds}`,
  )

  return Response.json(
    { error: params.error },
    {
      status: 503,
      headers: { "Retry-After": String(retryAfterSeconds) },
    },
  )
}

async function handleNoModelRequest(
  runtime: RouterRuntime,
  request: RouterRequestContext,
): Promise<Response> {
  const allPorts = runtime.state.instances.map((instance) => instance.port)
  const availablePorts = getAvailablePorts(
    runtime.state,
    allPorts,
    request.requestNowMs,
  )

  if (availablePorts.length === 0) {
    const allCoolingResponse = createAllCoolingResponse(runtime, {
      sessionId: request.sessionId,
      agent: request.agent,
      provider: request.provider,
      model: "_",
      ports: allPorts,
      requestNowMs: request.requestNowMs,
      error: "all upstream instances are cooling down for nomodel routing",
    })
    if (allCoolingResponse) {
      return allCoolingResponse
    }
  }

  const port = pickLeastLoaded(runtime.state, availablePorts)
  const instanceName = getInstanceName(runtime.state, port)
  const routeRecord: RouteRecord = {
    ts: runtime.now(),
    sid: request.sessionId || "-",
    agent: request.agent,
    model: "_",
    provider: request.provider,
    port,
    reason: "nomodel",
    instanceName,
  }
  recordRoute(runtime.state, routeRecord)
  runtime.logger(
    `sid=${routeRecord.sid} agent=${request.agent} provider=${request.provider} → ${instanceName}:${port} model=(none) reason=nomodel`,
  )

  const proxied = await proxyTo({
    port,
    context: { body: request.bodyText, req: request.req, url: request.url },
    logger: runtime.logger,
    fetchImpl: runtime.fetchImpl,
    onQuotaSnapshots: (quotaSnapshots) =>
      updateUpstreamQuotaSnapshot(runtime.state, port, quotaSnapshots),
    onQuotaExceeded: () =>
      applyCooldownOnStreamQuotaExceeded(runtime, {
        port,
        instanceName,
        model: "_",
        requestNowMs: request.requestNowMs,
      }),
    onUsageResolved: ({ copilotUsage, usage }) => {
      updateRouteRecord(runtime.state, routeRecord.historyId, {
        usage,
        copilotUsage,
      })
    },
  })
  applyCooldownOnExhaustion(runtime, proxied, {
    port,
    instanceName,
    model: "_",
    requestNowMs: request.requestNowMs,
  })
  updateUpstreamHeaderSnapshot(runtime.state, port, proxied.headers)

  return proxied
}

async function handleModelRequest(
  runtime: RouterRuntime,
  request: RouterRequestContext,
): Promise<Response> {
  const modelPorts = runtime.state.modelToPorts.get(request.model) || []
  const maxAttempts = Math.max(modelPorts.length, 1)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = pickPort(runtime.state, {
      sessionId: request.sessionId,
      agent: request.agent,
      model: request.model,
      nowMs: request.requestNowMs,
    })

    if (!result) {
      break
    }

    const instanceName = getInstanceName(runtime.state, result.port)
    const routeRecord: RouteRecord = {
      ts: runtime.now(),
      sid: request.sessionId || "-",
      agent: request.agent,
      model: request.model,
      provider: request.provider,
      port: result.port,
      reason: result.reason,
      instanceName,
    }
    recordRoute(runtime.state, routeRecord)
    runtime.logger(
      `sid=${routeRecord.sid} agent=${request.agent} provider=${request.provider} → ${instanceName}:${result.port} model=${request.model} reason=${result.reason}`,
    )

    const proxied = await proxyTo({
      port: result.port,
      context: { body: request.bodyText, req: request.req, url: request.url },
      logger: runtime.logger,
      fetchImpl: runtime.fetchImpl,
      onQuotaSnapshots: (quotaSnapshots) =>
        updateUpstreamQuotaSnapshot(runtime.state, result.port, quotaSnapshots),
      onQuotaExceeded: () =>
        applyCooldownOnStreamQuotaExceeded(runtime, {
          port: result.port,
          instanceName,
          model: request.model,
          requestNowMs: request.requestNowMs,
        }),
      onUsageResolved: ({ copilotUsage, usage }) => {
        updateRouteRecord(runtime.state, routeRecord.historyId, {
          usage,
          copilotUsage,
        })
      },
    })
    const exhausted = applyCooldownOnExhaustion(runtime, proxied, {
      port: result.port,
      instanceName,
      model: request.model,
      requestNowMs: request.requestNowMs,
    })
    updateUpstreamHeaderSnapshot(runtime.state, result.port, proxied.headers)

    if (!exhausted) {
      return proxied
    }

    runtime.logger(
      `retry model=${request.model} after exhausted instance=${instanceName}:${result.port} status=${proxied.status}`,
    )
  }

  const allCoolingResponse = createAllCoolingResponse(runtime, {
    sessionId: request.sessionId,
    agent: request.agent,
    provider: request.provider,
    model: request.model,
    ports: modelPorts,
    requestNowMs: request.requestNowMs,
    error: `all upstream instances are cooling down for model: ${request.model}`,
  })
  if (allCoolingResponse) {
    return allCoolingResponse
  }

  runtime.logger(
    `NO PORT sid=${request.sessionId || "-"} agent=${request.agent} model=${request.model} provider=${request.provider}`,
  )
  return Response.json(
    { error: `no instance serves model: ${request.model}` },
    { status: 502 },
  )
}

export function createRouterHandler(options: RouterHandlerOptions) {
  const runtime: RouterRuntime = {
    state: options.state,
    logger: options.logger,
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? (() => new Date().toISOString()),
    nowMs: options.nowMs ?? Date.now,
    defaultCooldownMs:
      options.defaultCooldownMs ?? DEFAULT_INSTANCE_COOLDOWN_MS,
  }

  return async function handleRouterRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const builtinResponse = handleBuiltinRoutes(runtime, req, url)
    if (builtinResponse) {
      return builtinResponse
    }

    const bodyText = await req.text()
    const requestContext = buildRequestContext({
      req,
      url,
      bodyText,
      requestNowMs: runtime.nowMs(),
    })

    if (!requestContext.model) {
      return handleNoModelRequest(runtime, requestContext)
    }

    return handleModelRequest(runtime, requestContext)
  }
}

export function createDashboardHandler(options: DashboardHandlerOptions) {
  const encoder = options.encoder ?? DEFAULT_ENCODER
  const sseRetryMs = options.sseRetryMs ?? DEFAULT_SSE_RETRY_MS
  const nowMs = options.nowMs ?? Date.now

  return async function handleDashboardRequest(
    req: Request,
  ): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname.startsWith("/api/instances/") && req.method === "PATCH") {
      const portString = url.pathname.slice("/api/instances/".length)
      const port = Number(portString)
      if (!Number.isInteger(port) || !options.state.portToInstance.has(port)) {
        return new Response(JSON.stringify({ error: "instance not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }

      let body: unknown
      try {
        body = await req.json()
      } catch {
        return new Response(JSON.stringify({ error: "invalid JSON body" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }

      if (
        !body
        || typeof body !== "object"
        || typeof (body as Record<string, unknown>).disabled !== "boolean"
      ) {
        return new Response(
          JSON.stringify({ error: "disabled must be a boolean" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        )
      }

      const disabled = (body as Record<string, unknown>).disabled as boolean
      setInstanceDisabled(options.state, port, disabled, encoder)
      const instance = options.state.portToInstance.get(port)
      options.logger?.(
        `dashboard ${disabled ? "disabled" : "enabled"} instance port=${port} name=${instance?.name ?? "?"}`,
      )
      return new Response(JSON.stringify({ ok: true, port, disabled }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    if (url.pathname.startsWith("/api/instances/") && req.method !== "PATCH") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: {
          "content-type": "application/json",
          allow: "PATCH",
        },
      })
    }

    if (
      (url.pathname === "/" || url.pathname === "/index.html")
      && req.method === "GET"
    ) {
      if (!(await options.dashboardFile.exists())) {
        return new Response("dashboard.html not found", { status: 404 })
      }
      return new Response(options.dashboardFile, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    if (req.method === "GET" && options.staticFiles) {
      const match = options.staticFiles.find(
        (entry) => entry.path === url.pathname,
      )
      if (match) {
        if (!(await match.file.exists())) {
          return new Response("not found", { status: 404 })
        }
        return new Response(match.file, {
          headers: { "Content-Type": match.contentType },
        })
      }
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
      return Response.json(getStatusPayload(options.state, nowMs()))
    }

    if (url.pathname === "/api/usage/refresh" && req.method === "POST") {
      await prefetchPremiumUsage(
        options.state,
        options.logger,
        options.fetchImpl,
      )
      return Response.json({ ok: true })
    }

    if (url.pathname === "/api/history" && req.method === "GET") {
      return Response.json(options.state.routeHistory)
    }

    if (url.pathname === "/api/history/clear" && req.method === "POST") {
      const cleared = options.state.routeHistory.length
      clearRouteHistory(options.state, encoder)
      options.logger(`dashboard cleared route history count=${cleared}`)
      return Response.json({ ok: true, cleared })
    }

    if (url.pathname === "/api/bindings/clear" && req.method === "POST") {
      const cleared = options.state.sessionBindings.size
      clearSessionBindings(options.state, encoder)
      options.logger(`dashboard cleared active bindings count=${cleared}`)
      return Response.json({ ok: true, cleared })
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      return createSseResponse(options.state, req, { encoder, sseRetryMs })
    }

    return new Response("Not found", { status: 404 })
  }
}
