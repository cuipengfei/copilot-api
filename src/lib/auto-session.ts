import consola from "consola"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import {
  getAutoSelection,
  type AutoSelectionResponse,
  type AutoSelectionTier,
} from "~/services/copilot/get-auto-selection"
import {
  getFusionSelection,
  type FusionSelectionResponse,
} from "~/services/copilot/get-fusion-selection"

import {
  getFusionProbePrompts,
  getIntelligenceProbePrompt,
  HARD_QUESTION,
  PREWARM_PROMPT,
  TARGET_CODE_PROMPT,
} from "~/lib/auto-probe-prompts"
import { getConfig } from "./config-store"
import { HTTPError } from "./error"
import { colorizeModel, shouldUseColor } from "./logger"
import { state } from "./state"

export type AutoSessionSource = "fusion" | "auto"

export interface AutoSessionSelection {
  sessionToken: string
  source: AutoSessionSource
  expectedDiscount: 30 | 10
}

type ProbeKind = "easy" | "hard" | "target"
type ProbeSource =
  | { source: "auto"; tier: AutoSelectionTier; kind: ProbeKind; prompt: string }
  | { source: "fusion"; point: string; prompt: string }

interface DiscountPairing extends AutoSessionSelection {
  expiresAt: number
  supportedEndpoints: Array<string>
  authToken: string | undefined
  epoch: number
  probe: ProbeSource
}

interface FusionRenewal {
  probe: ProbeSource
  fromRefreshTimer: boolean
}

interface ProbeRequest {
  token: string | undefined
  epoch: number
  sequence: number
  refresh: boolean
}

const SOURCES: ReadonlyArray<AutoSessionSource> = ["fusion", "auto"]
const EXPECTED_DISCOUNT = { fusion: 30, auto: 10 } as const
const pairings = new Map<
  string,
  { fusion?: DiscountPairing; auto?: DiscountPairing }
>()
const PREWARM_TIER: AutoSelectionTier = "balance"
const STARTUP_TIERS: Array<AutoSelectionTier> = [
  "efficiency",
  "balance",
  "intelligence",
  "fast",
]
const TARGET_TIERS: Array<AutoSelectionTier> = [
  "intelligence",
  "efficiency",
  "balance",
  "fast",
]
const TARGET_PROBE_INTERVAL_MS = 3_000
const TARGET_ATTEMPTS_PER_TIER = 10
const FUSION_TARGET_ATTEMPTS = 10
const TARGET_MISS_WAIT_MS = 2_000
const TARGET_DISCOVERY_COOLDOWN_MS = 90_000
const DEFAULT_SOURCE_ROOT = join(process.cwd(), "src")
export const STARTUP_PROBE_BUDGET_MS = 30_000
export const REFRESH_AHEAD_MS = 5 * 60 * 1000
const MAX_TIMER_MS = 2 ** 31 - 1

let authEpoch = 0
let epochToken = state.copilotToken
let requestSequence = 0
let cacheInvalidationSequence = 0
const committedSequences = new Map<string, number>()
const invalidationBarriers = new Map<string, number>()
// Rejected credentials remain blocked only until their server-provided expiry.
const rejectedTokens = new Map<string, number>()
let rejectedTokenTimer: NodeJS.Timeout | undefined

const pairingKey = (model: string, source: AutoSessionSource): string =>
  JSON.stringify([source, model])

const probeKey = (probe: ProbeSource): string =>
  probe.source === "auto" ?
    `auto:${probe.tier}:${probe.kind}`
  : `fusion:${probe.point}`

const rejectedTokenKey = (
  model: string,
  source: AutoSessionSource,
  token: string,
): string => JSON.stringify([source, model, token])

const clearRejectedTokens = (): void => {
  rejectedTokens.clear()
  clearTimeout(rejectedTokenTimer)
  rejectedTokenTimer = undefined
}

const pruneRejectedTokens = (): void => {
  clearTimeout(rejectedTokenTimer)
  rejectedTokenTimer = undefined
  let nextExpiry = Number.POSITIVE_INFINITY
  for (const [token, expiry] of rejectedTokens) {
    if (expiry <= Date.now()) rejectedTokens.delete(token)
    else nextExpiry = Math.min(nextExpiry, expiry)
  }
  if (Number.isFinite(nextExpiry)) {
    rejectedTokenTimer = setTimeout(
      pruneRejectedTokens,
      Math.min(MAX_TIMER_MS, Math.max(0, nextExpiry - Date.now())),
    )
    rejectedTokenTimer.unref?.()
  }
}

const syncAuthEpoch = (): void => {
  if (epochToken === state.copilotToken) return
  epochToken = state.copilotToken
  authEpoch += 1
  committedSequences.clear()
  invalidationBarriers.clear()
  clearRejectedTokens()
}

const beginProbeRequest = (refresh = false): ProbeRequest => {
  syncAuthEpoch()
  return {
    token: state.copilotToken,
    epoch: authEpoch,
    sequence: ++requestSequence,
    refresh,
  }
}

const requestIsCurrent = (request: ProbeRequest): boolean => {
  syncAuthEpoch()
  return request.epoch === authEpoch && request.token === state.copilotToken
}

const fusionCatalogSupportsResponses = (model: string): boolean =>
  state.models?.data.some(
    (entry) =>
      entry.id === model && entry.supported_endpoints?.includes("/responses"),
  ) === true

const isPairingValid = (
  model: string,
  pairing: DiscountPairing,
  authToken = state.copilotToken,
): boolean =>
  pairing.expiresAt * 1000 > Date.now()
  && pairing.authToken === authToken
  && authToken === state.copilotToken
  && pairing.epoch === authEpoch
  && !rejectedTokens.has(
    rejectedTokenKey(model, pairing.source, pairing.sessionToken),
  )
  && (pairing.source !== "fusion" || fusionCatalogSupportsResponses(model))

const isSourceCovered = (model: string, source: AutoSessionSource): boolean => {
  const pairing = pairings.get(model)?.[source]
  return pairing !== undefined && isPairingValid(model, pairing)
}

export const isModelAutoCovered = (model: string): boolean => {
  syncAuthEpoch()
  return SOURCES.some((source) => isSourceCovered(model, source))
}

export const getMissingAutoDiscoveryModels = (
  models: ReadonlyArray<string>,
): Array<string> => models.filter((model) => !isModelAutoCovered(model))

const getMissingSourceModels = (
  models: ReadonlyArray<string>,
  source: AutoSessionSource,
): Array<string> => models.filter((model) => !isSourceCovered(model, source))

const formatLogValue = (value: string): string =>
  /^[\w./:-]+$/u.test(value) ? value : (
    JSON.stringify(value).replace(
      /[\u007f-\u009f\u2028\u2029]/gu,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
  )

const formatAutoSessionModel = (model: string): string => {
  const display = formatLogValue(model)
  return shouldUseColor() ? colorizeModel(display) : display
}

const discoverySnapshot = (wanted = getConfiguredTargetModels()): string => {
  syncAuthEpoch()
  const obtained = [...pairings.keys()].filter(isModelAutoCovered)
  const fusionObtained = obtained.filter((model) =>
    isSourceCovered(model, "fusion"),
  )
  const autoObtained = obtained.filter((model) =>
    isSourceCovered(model, "auto"),
  )
  return `obtained=${JSON.stringify(obtained)} missing=${JSON.stringify(getMissingAutoDiscoveryModels(wanted))} fusion_obtained=${JSON.stringify(fusionObtained)} auto_obtained=${JSON.stringify(autoObtained)} fusion_missing=${JSON.stringify(getMissingSourceModels(wanted, "fusion"))} auto_missing=${JSON.stringify(getMissingSourceModels(wanted, "auto"))}`
}

const logAutoDiscovery = (
  phase: string,
  wanted = getConfiguredTargetModels(),
): void => {
  consola.info(`[auto-session] ${phase} ${discoverySnapshot(wanted)}`)
}

const PREWARM_AUTO_PROBE: ProbeSource = {
  source: "auto",
  tier: PREWARM_TIER,
  kind: "easy",
  prompt: PREWARM_PROMPT,
}

const registerPairing = (
  model: string,
  pairing: Omit<DiscountPairing, "authToken" | "epoch" | "expectedDiscount">,
  request: ProbeRequest,
  fromRefreshTimer = false,
): boolean => {
  if (
    typeof model !== "string"
    || model.trim().length === 0
    || typeof pairing.sessionToken !== "string"
    || pairing.sessionToken.trim().length === 0
    || !Number.isFinite(pairing.expiresAt)
    || pairing.expiresAt * 1000 <= Date.now()
    || !requestIsCurrent(request)
    || (pairing.source === "fusion" && !fusionCatalogSupportsResponses(model))
  ) {
    consola.warn(
      `[auto-session] ignored invalid selection source=${pairing.source}`,
    )
    return false
  }
  pruneRejectedTokens()
  const key = pairingKey(model, pairing.source)
  if (
    rejectedTokens.has(
      rejectedTokenKey(model, pairing.source, pairing.sessionToken),
    )
    || request.sequence < cacheInvalidationSequence
    || request.sequence < (committedSequences.get(key) ?? 0)
    || request.sequence < (invalidationBarriers.get(key) ?? 0)
  ) {
    return false
  }
  const previous = pairings.get(model)
  const oldDiscount =
    previous?.fusion && isPairingValid(model, previous.fusion) ? 30
    : previous?.auto && isPairingValid(model, previous.auto) ? 10
    : 0
  const previousSource = previous?.[pairing.source]
  const refreshed =
    previousSource !== undefined && isPairingValid(model, previousSource)
  const gainsAutoCoverage =
    pairing.source === "auto" && !isSourceCovered(model, "auto")
  const candidate: DiscountPairing = {
    ...pairing,
    expectedDiscount: EXPECTED_DISCOUNT[pairing.source],
    authToken: request.token,
    epoch: request.epoch,
  }
  const slots = previous ?? {}
  slots[pairing.source] = candidate
  pairings.set(model, slots)
  committedSequences.set(key, request.sequence)
  pairingSources.set(key, pairing.probe)
  lastSuccessPrompts.set(probeKey(pairing.probe), pairing.probe)
  scheduleRefresh(model, candidate, fromRefreshTimer)
  wakeTargetWaiters(model, request.token)
  const event =
    oldDiscount > 0 && candidate.expectedDiscount > oldDiscount ? "upgraded"
    : refreshed ? "refresh"
    : "acquired"
  const message = `[auto-session] ${event} model=${formatAutoSessionModel(model)} source=${candidate.source} expected_discount=${candidate.expectedDiscount}%${event === "upgraded" ? ` previous_discount=${oldDiscount}%` : ""}`
  if (event === "refresh" && !request.refresh) consola.debug(message)
  else consola.info(message)
  if (gainsAutoCoverage && identityReady(request.token)) {
    startFusionDiscovery(fusionSeedRound)
  }
  return true
}

const registerAutoResponse = (
  selection: AutoSelectionResponse,
  probe: ProbeSource,
  request: ProbeRequest,
  fromRefreshTimer = false,
): boolean => {
  const endpoints = selection.selected_model?.supported_endpoints
  if (
    endpoints !== undefined
    && (!Array.isArray(endpoints)
      || endpoints.some((endpoint) => typeof endpoint !== "string"))
  ) {
    consola.warn("[auto-session] ignored invalid selection source=auto")
    return false
  }
  return registerPairing(
    selection.selected_model?.id,
    {
      sessionToken: selection.session_token,
      expiresAt: selection.expires_at,
      supportedEndpoints: endpoints ?? [],
      source: "auto",
      probe,
    },
    request,
    fromRefreshTimer,
  )
}

export const registerAutoSelection = (
  selection: AutoSelectionResponse,
): boolean =>
  registerAutoResponse(selection, PREWARM_AUTO_PROBE, beginProbeRequest())

const registerFusionResponse = (
  selection: FusionSelectionResponse,
  probe: ProbeSource,
  request: ProbeRequest,
  fromRefreshTimer = false,
): boolean =>
  registerPairing(
    selection.modelId,
    {
      sessionToken: selection.sessionToken,
      expiresAt: selection.expiresAt,
      supportedEndpoints: ["/responses"],
      source: "fusion",
      probe,
    },
    request,
    fromRefreshTimer,
  )

export const registerFusionSelection = (
  selection: FusionSelectionResponse,
): boolean =>
  registerFusionResponse(
    selection,
    {
      source: "fusion",
      point: "seed:0",
      prompt: getFusionProbePrompts()[0],
    },
    beginProbeRequest(),
  )

const explicitRefreshes = new Set<Promise<void>>()
export const refreshAutoSession = (): Promise<void> => {
  const refresh = (async () => {
    for (;;) {
      const request = beginProbeRequest(true)
      const selection = await getAutoSelection(PREWARM_PROMPT, PREWARM_TIER)
      if (state.copilotToken !== request.token) continue
      if (!registerAutoResponse(selection, PREWARM_AUTO_PROBE, request)) {
        throw new Error("invalid auto selection response")
      }
      return
    }
  })()
  explicitRefreshes.add(refresh)
  void refresh.then(
    () => explicitRefreshes.delete(refresh),
    () => explicitRefreshes.delete(refresh),
  )
  return refresh
}

export const invalidateAutoSession = (): void => {
  syncAuthEpoch()
  // Cache clears block old successes without invalidating retry/backoff identity.
  cacheInvalidationSequence = requestSequence + 1
  pairings.clear()
  committedSequences.clear()
  invalidationBarriers.clear()
  clearRejectedTokens()
  clearAllRefreshTimers()
  fusionRenewalModels.clear()
  for (const source of SOURCES) runtimes[source].cooldownUntil = 0
  // Clearing a cache is not an identity change and must not interrupt backoff.
  for (const source of SOURCES) wakeAll(runtimes[source].haltWaiters)
  wakeAllTargetWaiters()
}

export const invalidateAutoSessionPairing = (
  model: string,
  sessionToken: string,
): boolean => {
  syncAuthEpoch()
  const slots = pairings.get(model)
  if (slots === undefined) return false
  for (const source of SOURCES) {
    const pairing = slots[source]
    if (!pairing || pairing.sessionToken !== sessionToken) continue
    if (
      pairing.epoch !== authEpoch
      || pairing.authToken !== state.copilotToken
    ) {
      return false
    }
    delete slots[source]
    if (!slots.fusion && !slots.auto) pairings.delete(model)
    clearRefreshTimer(model, source)
    invalidationBarriers.set(pairingKey(model, source), requestSequence + 1)
    rejectedTokens.set(
      rejectedTokenKey(model, source, sessionToken),
      pairing.expiresAt * 1000,
    )
    pruneRejectedTokens()
    consola.info(
      `[auto-session] rejected model=${formatAutoSessionModel(model)} source=${source} expected_discount=${EXPECTED_DISCOUNT[source]}% reason=token_rejected`,
    )
    reacquireSource(model, pairing.probe, "rejected")
    return true
  }
  return false
}

export const resumeAutoSessionDiscoveryAfterRotation = (): void => {
  syncAuthEpoch()
  if (probeSchedulerStopped || state.copilotToken === discoveryToken) return
  discoveryToken = state.copilotToken
  for (const source of SOURCES) {
    runtimes[source].retryUntil = 0
    wakeAll(runtimes[source].haltWaiters)
    wakeAll(runtimes[source].sleepWaiters)
  }
  wakeAll(identityWaiters)
  if (!discoveryRan) return
  for (const probe of lastSuccessPrompts.values()) {
    if (probe.source === "auto") void runSourceProbe(probe)
  }
  fusionSeedRound = Promise.all(
    fusionSeedProbes().map((probe) => runSourceProbe(probe)),
  )
  startTargetDiscovery(
    getConfiguredTargetModels(),
    Promise.resolve(),
    "rotation",
  )
  startFusionDiscovery(fusionSeedRound, "rotation")
}

export interface HardSnippet {
  file: string
  startLine: number
  text: string
}

type Rng = (maxExclusive: number) => number
const defaultRng: Rng = (maxExclusive) =>
  Math.floor(Math.random() * maxExclusive)

// Keep source sampling unchanged: uniformly choose a file, then a 100-line window.
export const sampleHardSnippet = async (
  rootDir: string = DEFAULT_SOURCE_ROOT,
  rng: Rng = defaultRng,
  exclude?: HardSnippet,
): Promise<HardSnippet | undefined> => {
  try {
    const glob = new Bun.Glob("**/*.ts")
    const files: Array<{ file: string; lines: Array<string> }> = []
    for await (const relative of glob.scan(rootDir)) {
      if (relative.endsWith(".test.ts") || relative.endsWith(".d.ts")) continue
      const file = join(rootDir, relative)
      const lines = readFileSync(file, "utf8").split("\n")
      if (lines[lines.length - 1] === "") lines.pop()
      if (lines.length < 100) continue
      if (exclude?.file === file && lines.length - 100 + 1 === 1) continue
      files.push({ file, lines })
    }
    if (files.length === 0) return undefined
    const picked = files[rng(files.length)]
    const windows = picked.lines.length - 100 + 1
    const excludedStart =
      exclude?.file === picked.file && exclude.startLine < windows ?
        exclude.startLine
      : -1
    const available = windows - (excludedStart >= 0 ? 1 : 0)
    if (available <= 0) return undefined
    let startLine = rng(available)
    if (excludedStart >= 0 && startLine >= excludedStart) startLine += 1
    return {
      file: picked.file,
      startLine,
      text: picked.lines.slice(startLine, startLine + 100).join("\n"),
    }
  } catch (error) {
    consola.warn(
      `[auto-session] source sampling failed: ${probeFailureKind(error)}`,
    )
    return undefined
  }
}

const probeFailureKind = (error: unknown): string => {
  if (error instanceof HTTPError) return `http ${error.response.status}`
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError")
      return error.name
    if (error.name === "TypeError") return "network"
    return "error"
  }
  return "unknown"
}

const RETRY_BASE_MS = 1_000
const RETRY_CAP_MS = 30_000
export const nextBackoffMs = (failures: number): number => {
  const exponential = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** failures)
  return Math.min(
    RETRY_CAP_MS,
    exponential + defaultRng(Math.ceil(exponential / 2)),
  )
}

const parseRetryAfterMs = (header: string | null): number | undefined => {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (trimmed !== "") {
    const seconds = Number(trimmed)
    if (Number.isFinite(seconds) && seconds >= 0) {
      const ms = seconds * 1000
      if (Number.isSafeInteger(ms)) return ms
      return undefined
    }
  }
  const dateMs = Date.parse(trimmed)
  if (trimmed !== "" && !Number.isNaN(dateMs))
    return Math.max(0, dateMs - Date.now())
  return undefined
}

interface SourceRuntime {
  haltActive: boolean
  haltToken: string | undefined
  unavailable: boolean
  haltWaiters: Set<() => void>
  sleepWaiters: Set<() => void>
  cooldownUntil: number
  retryUntil: number
  round: Promise<void> | undefined
}

const newSourceRuntime = (): SourceRuntime => ({
  haltActive: false,
  haltToken: undefined,
  unavailable: false,
  haltWaiters: new Set(),
  sleepWaiters: new Set(),
  cooldownUntil: 0,
  retryUntil: 0,
  round: undefined,
})
const runtimes: Record<AutoSessionSource, SourceRuntime> = {
  auto: newSourceRuntime(),
  fusion: newSourceRuntime(),
}
let probeSchedulerStopped = false
let discoveryRan = false
let discoveryToken: string | undefined
const pairingSources = new Map<string, ProbeSource>()
const lastSuccessPrompts = new Map<string, ProbeSource>()
const fusionRenewalModels = new Set<string>()
const identityWaiters = new Set<() => void>()
const inflightProbePoints = new Map<string, Promise<string | undefined>>()
let fusionSeedRound: Promise<unknown> = Promise.resolve()
let latestProbeRound: Promise<unknown> = Promise.resolve()

const wakeAll = (waiters: Set<() => void>): void => {
  const pending = [...waiters]
  waiters.clear()
  for (const wake of pending) wake()
}

const probeIdentityReady = (): boolean =>
  (!discoveryRan && discoveryToken === undefined)
  || discoveryToken === state.copilotToken

const waitForProbeIdentity = async (): Promise<void> => {
  while (!probeSchedulerStopped && !probeIdentityReady()) {
    const { promise, resolve } = Promise.withResolvers<void>()
    identityWaiters.add(resolve)
    try {
      await promise
    } finally {
      identityWaiters.delete(resolve)
    }
  }
}

const parkProbe = async (runtime: SourceRuntime): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  runtime.haltWaiters.add(resolve)
  try {
    await promise
  } finally {
    runtime.haltWaiters.delete(resolve)
  }
}

interface TargetWaiter {
  token: string | undefined
  wake: () => void
}
const targetWaiters = new Map<string, Set<TargetWaiter>>()

const waitForTarget = (
  model: string,
  token: string | undefined,
): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  let set = targetWaiters.get(model)
  if (set === undefined) {
    set = new Set()
    targetWaiters.set(model, set)
  }
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    set.delete(entry)
    if (set.size === 0 && targetWaiters.get(model) === set)
      targetWaiters.delete(model)
    resolve()
  }
  const entry: TargetWaiter = { token, wake: finish }
  const timer = setTimeout(finish, TARGET_MISS_WAIT_MS)
  set.add(entry)
  return promise
}

const wakeTargetWaiters = (model: string, token: string | undefined): void => {
  const set = targetWaiters.get(model)
  if (set === undefined) return
  for (const waiter of set) {
    if (waiter.token === token) waiter.wake()
  }
}

const wakeAllTargetWaiters = (): void => {
  for (const set of targetWaiters.values()) {
    for (const waiter of set) waiter.wake()
  }
}

const probeSleep = async (
  ms: number,
  source: AutoSessionSource,
): Promise<void> => {
  if (probeSchedulerStopped) return
  const runtime = runtimes[source]
  const timer = new AbortController()
  const { promise: woken, resolve } = Promise.withResolvers<void>()
  let woke = false
  const wake = (): void => {
    woke = true
    resolve()
  }
  runtime.sleepWaiters.add(wake)
  const deadline = Date.now() + Math.max(0, ms)
  try {
    while (!woke && deadline - Date.now() > 0) {
      const slice = Math.min(deadline - Date.now(), MAX_TIMER_MS)
      await Promise.race([
        delay(slice, undefined, { signal: timer.signal }),
        woken,
      ])
    }
  } finally {
    runtime.sleepWaiters.delete(wake)
    timer.abort()
  }
}

const waitOutHalt = async (source: AutoSessionSource): Promise<void> => {
  const runtime = runtimes[source]
  while (
    !probeSchedulerStopped
    && runtime.haltActive
    && !runtime.unavailable
    && state.copilotToken === runtime.haltToken
  ) {
    await parkProbe(runtime)
  }
  if (state.copilotToken !== runtime.haltToken) {
    runtime.haltActive = false
    runtime.unavailable = false
  }
}

const haltSource = (
  source: AutoSessionSource,
  token: string | undefined,
): void => {
  if (state.copilotToken !== token) return
  const runtime = runtimes[source]
  runtime.haltActive = true
  runtime.haltToken = token
  wakeAll(runtime.sleepWaiters)
  wakeAll(runtime.haltWaiters)
}

export const stopProbeScheduler = (): void => {
  probeSchedulerStopped = true
  clearAllRefreshTimers()
  clearRejectedTokens()
  for (const source of SOURCES) {
    wakeAll(runtimes[source].haltWaiters)
    wakeAll(runtimes[source].sleepWaiters)
  }
  wakeAllTargetWaiters()
  wakeAll(identityWaiters)
}

export const whenProbeSchedulerIdle = async (): Promise<void> => {
  await latestProbeRound
  for (;;) {
    const pending = [
      ...SOURCES.flatMap((source) =>
        runtimes[source].round ? [runtimes[source].round] : [],
      ),
      ...inflightProbePoints.values(),
      ...explicitRefreshes,
    ]
    if (pending.length === 0) return
    await Promise.all(pending)
  }
}

const isRetriableNetworkError = (error: Error): boolean =>
  error.name === "TypeError"
  || error.name === "TimeoutError"
  || error.name === "AbortError"

export const nextRefreshDelayMs = (expiresAtMs: number, now: number): number =>
  Math.min(MAX_TIMER_MS, Math.max(expiresAtMs - REFRESH_AHEAD_MS - now, 0))

const refreshTimers = new Map<string, NodeJS.Timeout>()
const clearRefreshTimer = (model: string, source: AutoSessionSource): void => {
  const key = pairingKey(model, source)
  const timer = refreshTimers.get(key)
  if (timer !== undefined) {
    clearTimeout(timer)
    refreshTimers.delete(key)
  }
}
const clearAllRefreshTimers = (): void => {
  for (const timer of refreshTimers.values()) clearTimeout(timer)
  refreshTimers.clear()
}

const scheduleRefresh = (
  model: string,
  pairing: DiscountPairing,
  fromRefreshTimer = false,
): void => {
  clearRefreshTimer(model, pairing.source)
  if (probeSchedulerStopped) return
  const fireIn = pairing.expiresAt * 1000 - REFRESH_AHEAD_MS - Date.now()
  // An upstream token still inside the refresh window must not create a 0ms loop.
  if (fromRefreshTimer && fireIn <= 0) return
  const key = pairingKey(model, pairing.source)
  const timer = setTimeout(
    () => {
      refreshTimers.delete(key)
      if (
        probeSchedulerStopped
        || pairings.get(model)?.[pairing.source] !== pairing
      )
        return
      if (!requestIdentityMatches(pairing)) return
      if (pairing.expiresAt * 1000 - REFRESH_AHEAD_MS - Date.now() > 0) {
        scheduleRefresh(model, pairing)
        return
      }
      if (pairing.source === "fusion")
        reacquireSource(model, pairing.probe, "expired", true)
      else void runSourceProbe(pairing.probe, true)
    },
    nextRefreshDelayMs(pairing.expiresAt * 1000, Date.now()),
  )
  timer.unref?.()
  refreshTimers.set(key, timer)
}

const requestIdentityMatches = (pairing: DiscountPairing): boolean => {
  syncAuthEpoch()
  return pairing.epoch === authEpoch && pairing.authToken === state.copilotToken
}

const isFusionUnavailable = async (response: Response): Promise<boolean> => {
  if (response.status === 404 || response.status === 405) return true
  if (response.status !== 400 && response.status !== 403) return false
  try {
    const body: unknown = await response.clone().json()
    if (body === null || typeof body !== "object") return false
    const error = "error" in body ? body.error : body
    if (error === null || typeof error !== "object") return false
    const code = "code" in error ? error.code : undefined
    return (
      code === "model_pool_not_eligible"
      || code === "unsupported_api_for_model"
      || code === "unsupported_endpoint"
    )
  } catch {
    return false
  }
}

const probePointLoop = async (
  probe: ProbeSource,
  fromRefreshTimer: boolean,
  maxRequests: number,
): Promise<string | undefined> => {
  let requests = 0
  let failures = 0
  let lastNetworkFailure: string | undefined
  let attempted = false
  let budgetToken = state.copilotToken
  const backoff = async (ms: number): Promise<void> => {
    if (probe.source === "fusion") {
      runtimes.fusion.retryUntil = Math.max(
        runtimes.fusion.retryUntil,
        Date.now() + ms,
      )
    } else {
      await probeSleep(ms, probe.source)
    }
  }
  for (;;) {
    // 种子和续期在新身份就绪后重新计次；补采轮次不跨身份续跑。
    if (
      probe.source === "fusion"
      && probe.point !== "target"
      && budgetToken !== state.copilotToken
    ) {
      requests = 0
    }
    if (probeSchedulerStopped || requests >= maxRequests) return undefined
    if (!probeIdentityReady()) await waitForProbeIdentity()
    if (probeSchedulerStopped) return undefined
    if (attempted) await waitOutHalt(probe.source)
    if (requests >= maxRequests || probeSchedulerStopped) return undefined
    if (
      probe.source === "fusion"
      && runtimes.fusion.unavailable
      && runtimes.fusion.haltToken === state.copilotToken
    )
      return undefined
    if (!probeIdentityReady()) continue
    if (probe.source === "fusion" && runtimes.fusion.retryUntil > Date.now()) {
      await probeSleep(runtimes.fusion.retryUntil - Date.now(), "fusion")
      continue
    }
    const request = beginProbeRequest(fromRefreshTimer)
    budgetToken = request.token
    try {
      attempted = true
      requests += 1
      if (probe.source === "auto") {
        const selection = await getAutoSelection(probe.prompt, probe.tier)
        if (!requestIsCurrent(request)) {
          if (state.copilotToken !== request.token) continue
          return undefined
        }
        if (!registerAutoResponse(selection, probe, request, fromRefreshTimer))
          return undefined
        if (lastNetworkFailure !== undefined)
          consola.info("[auto-session] probe recovered source=auto")
        return selection.selected_model.id
      }
      const selection = await getFusionSelection(probe.prompt)
      if (!requestIsCurrent(request)) {
        if (state.copilotToken !== request.token) continue
        return undefined
      }
      if (!registerFusionResponse(selection, probe, request, fromRefreshTimer))
        return undefined
      if (lastNetworkFailure !== undefined)
        consola.info("[auto-session] probe recovered source=fusion")
      return selection.modelId
    } catch (error) {
      if (!requestIsCurrent(request)) {
        if (state.copilotToken !== request.token) continue
        return undefined
      }
      if (error instanceof HTTPError) {
        const status = error.response.status
        if (
          probe.source === "fusion"
          && (await isFusionUnavailable(error.response))
        ) {
          if (!requestIsCurrent(request)) {
            if (state.copilotToken !== request.token) continue
            return undefined
          }
          haltSource("fusion", request.token)
          consola.info(
            "[auto-session] probe paused source=fusion reason=source_unavailable",
          )
          runtimes.fusion.unavailable = true
          return undefined
        }
        if (status === 401 || status === 403) {
          haltSource(probe.source, request.token)
          if (status === 401) {
            for (const source of SOURCES) haltSource(source, request.token)
          }
          continue
        }
        if (status === 429) {
          const retryAfterMs = parseRetryAfterMs(
            error.response.headers.get("retry-after"),
          )
          await backoff(
            retryAfterMs !== undefined && retryAfterMs > 0 ?
              retryAfterMs
            : nextBackoffMs(failures),
          )
          failures += 1
          continue
        }
        if (status >= 500 && status <= 599) {
          const retryAfterMs =
            probe.source === "fusion" ?
              parseRetryAfterMs(error.response.headers.get("retry-after"))
            : undefined
          await backoff(
            retryAfterMs !== undefined && retryAfterMs > 0 ?
              retryAfterMs
            : nextBackoffMs(failures),
          )
          failures += 1
          continue
        }
        consola.warn(
          `[auto-session] probe pending source=${probe.source}: http ${status}`,
        )
        return undefined
      }
      if (error instanceof Error && isRetriableNetworkError(error)) {
        const failure = probeFailureKind(error)
        const message = `[auto-session] probe retry source=${probe.source}: ${failure}`
        if (failure === lastNetworkFailure) consola.debug(message)
        else consola.warn(message)
        lastNetworkFailure = failure
        await backoff(nextBackoffMs(failures))
        failures += 1
        continue
      }
      consola.warn(
        `[auto-session] probe failed source=${probe.source}: ${probeFailureKind(error)}`,
      )
      return undefined
    }
  }
}

const runSourceProbe = (
  probe: ProbeSource,
  fromRefreshTimer = false,
  maxRequests = probe.source === "fusion" || probe.kind === "target" ?
    1
  : Number.POSITIVE_INFINITY,
): Promise<string | undefined> => {
  const runtime = runtimes[probe.source]
  if (
    probeSchedulerStopped
    || (probe.source === "fusion"
      && runtime.haltActive
      && runtime.haltToken === state.copilotToken)
  ) {
    return Promise.resolve(undefined)
  }
  const key = probeKey(probe)
  const existing = inflightProbePoints.get(key)
  if (existing !== undefined) return existing
  const attempt = probePointLoop(
    probe,
    fromRefreshTimer,
    probe.source === "fusion" ? 1 : maxRequests,
  ).finally(() => {
    if (inflightProbePoints.get(key) === attempt)
      inflightProbePoints.delete(key)
  })
  inflightProbePoints.set(key, attempt)
  return attempt
}

export const runProbePoint = (
  tier: AutoSelectionTier,
  kind: ProbeKind,
  prompt: string,
  fromRefreshTimer = false,
  maxRequests = kind === "target" ? 1 : Number.POSITIVE_INFINITY,
): Promise<string | undefined> =>
  runSourceProbe(
    { source: "auto", tier, kind, prompt },
    fromRefreshTimer,
    maxRequests,
  )

const fusionSeedProbes = (): Array<ProbeSource> =>
  getFusionProbePrompts().map((prompt, index) => ({
    source: "fusion",
    point: `seed:${index}`,
    prompt,
  }))

const discoverTargets = async (
  models: Array<string>,
  token: string | undefined,
): Promise<void> => {
  for (let attempt = 0; attempt < TARGET_ATTEMPTS_PER_TIER; attempt++) {
    for (const tier of TARGET_TIERS) {
      if (
        probeSchedulerStopped
        || state.copilotToken !== token
        || !probeIdentityReady()
        || getMissingSourceModels(models, "auto").length === 0
      )
        return
      await waitOutHalt("auto")
      if (
        probeSchedulerStopped
        || state.copilotToken !== token
        || !probeIdentityReady()
        || getMissingSourceModels(models, "auto").length === 0
      )
        return
      const existing = inflightProbePoints.get(`auto:${tier}:target`)
      if (existing !== undefined) {
        await existing
        if (
          probeSchedulerStopped
          || getMissingSourceModels(models, "auto").length === 0
        )
          return
        await probeSleep(TARGET_PROBE_INTERVAL_MS, "auto")
        continue
      }
      const prompt =
        tier === "intelligence" ? getIntelligenceProbePrompt(attempt)
        : attempt % 2 === 0 ? PREWARM_PROMPT
        : TARGET_CODE_PROMPT
      await runProbePoint(tier, "target", prompt, false, 1)
      if (
        probeSchedulerStopped
        || getMissingSourceModels(models, "auto").length === 0
      )
        return
      await probeSleep(TARGET_PROBE_INTERVAL_MS, "auto")
    }
  }
}

const getFusionTargetModels = (): Array<string> => {
  const targets = new Set([
    ...getConfiguredTargetModels(),
    ...fusionRenewalModels,
  ])
  for (const model of pairings.keys()) {
    if (isSourceCovered(model, "auto")) targets.add(model)
  }
  return [...targets]
}

const discoverFusionTargets = async (
  token: string | undefined,
  renewal?: FusionRenewal,
): Promise<void> => {
  for (let attempt = 0; attempt < FUSION_TARGET_ATTEMPTS; attempt++) {
    if (state.copilotToken !== token || !probeIdentityReady()) return
    if (runtimes.fusion.unavailable && runtimes.fusion.haltToken === token)
      return
    const first = attempt === 0 ? renewal : undefined
    if (
      probeSchedulerStopped
      || (!first
        && getMissingSourceModels(getFusionTargetModels(), "fusion").length
          === 0)
    )
      return
    await waitOutHalt("fusion")
    if (state.copilotToken !== token || !probeIdentityReady()) return
    if (runtimes.fusion.unavailable && runtimes.fusion.haltToken === token)
      return
    if (
      probeSchedulerStopped
      || (!first
        && getMissingSourceModels(getFusionTargetModels(), "fusion").length
          === 0)
    )
      return
    // 保存题面的续期也占共享十次预算，失败或选到其他模型后继续变体。
    await runSourceProbe(
      first?.probe ?? {
        source: "fusion",
        point: "target",
        prompt: getIntelligenceProbePrompt(attempt + 1),
      },
      first?.fromRefreshTimer ?? false,
      1,
    )
    if (state.copilotToken !== token || !probeIdentityReady()) return
    if (runtimes.fusion.unavailable && runtimes.fusion.haltToken === token)
      return
    if (
      probeSchedulerStopped
      || getMissingSourceModels(getFusionTargetModels(), "fusion").length === 0
    )
      return
    await probeSleep(TARGET_PROBE_INTERVAL_MS, "fusion")
  }
}

export const parseAutoDiscoveryModels = (value: unknown): Array<string> => {
  if (value === undefined) return []
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("autoDiscovery must be an object")
  }
  const models = "models" in value ? value.models : undefined
  if (models === undefined) return []
  if (
    !Array.isArray(models)
    || models.some(
      (model: unknown) => typeof model !== "string" || !model.trim(),
    )
  ) {
    throw new TypeError("autoDiscovery.models must contain nonempty model IDs")
  }
  return [...new Set<string>(models)]
}
const getConfiguredTargetModels = (): Array<string> =>
  parseAutoDiscoveryModels(getConfig().autoDiscovery)

type DiscoveryReason = "startup" | "miss" | "expired" | "rotation" | "rejected"

const startDiscoveryRound = (
  source: AutoSessionSource,
  models: Array<string>,
  after: Promise<unknown>,
  reason: DiscoveryReason,
  renewal?: FusionRenewal,
): void => {
  const runtime = runtimes[source]
  if (models.length === 0 || probeSchedulerStopped || runtime.round) return
  if (!probeIdentityReady()) return
  if (runtime.unavailable && runtime.haltToken === state.copilotToken) return
  if (!renewal && getMissingSourceModels(models, source).length === 0) return
  if (reason !== "rotation" && Date.now() < runtime.cooldownUntil) return
  const startedToken = state.copilotToken
  discoveryToken ??= startedToken
  discoveryRan = true
  const previous = new Set(
    [...pairings.keys()].filter((model) => isSourceCovered(model, source)),
  )
  consola.info(
    `[auto-session] target discovery start source=${source} reason=${reason} missing=${JSON.stringify(getMissingSourceModels(models, source))}`,
  )
  const round = after
    .then(() => {
      if (state.copilotToken !== startedToken || !probeIdentityReady()) return
      return source === "auto" ?
          discoverTargets(models, startedToken)
        : discoverFusionTargets(startedToken, renewal)
    })
    .then(() => {
      const missing = getMissingSourceModels(
        source === "fusion" ? getFusionTargetModels() : models,
        source,
      )
      const outcome =
        probeSchedulerStopped ? "stopped"
        : state.copilotToken !== startedToken ? "rotated"
        : missing.length > 0 ? "exhausted"
        : "result"
      const added = [...pairings.keys()].filter(
        (model) => isSourceCovered(model, source) && !previous.has(model),
      )
      consola.info(
        `[auto-session] target discovery ${outcome} source=${source} added=${JSON.stringify(added)} missing=${JSON.stringify(missing)}`,
      )
    })
    .finally(() => {
      if (runtime.round === round) runtime.round = undefined
      if (
        !probeSchedulerStopped
        && state.copilotToken !== startedToken
        && probeIdentityReady()
      ) {
        if (source === "auto")
          startTargetDiscovery(
            getConfiguredTargetModels(),
            Promise.resolve(),
            "rotation",
          )
        else startFusionDiscovery(fusionSeedRound, "rotation")
      } else if (
        !probeSchedulerStopped
        && state.copilotToken === startedToken
      ) {
        const targets = source === "fusion" ? getFusionTargetModels() : models
        if (getMissingSourceModels(targets, source).length > 0) {
          runtime.cooldownUntil = Date.now() + TARGET_DISCOVERY_COOLDOWN_MS
        }
      }
    })
  runtime.round = round
}

const startTargetDiscovery = (
  models: Array<string>,
  after: Promise<unknown> = Promise.resolve(),
  reason: DiscoveryReason = "miss",
): void => startDiscoveryRound("auto", models, after, reason)

const startFusionDiscovery = (
  after: Promise<unknown> = fusionSeedRound,
  reason: DiscoveryReason = "miss",
  renewal?: FusionRenewal,
): void =>
  startDiscoveryRound("fusion", getFusionTargetModels(), after, reason, renewal)

interface PrewarmOptions {
  sourceRoot?: string
  startupBudgetMs?: number
}

export const prewarmAutoSession = async ({
  sourceRoot,
  startupBudgetMs,
}: PrewarmOptions = {}): Promise<void> => {
  const targetModels = getConfiguredTargetModels()
  consola.info(
    `[auto-session] discovery start wanted=${JSON.stringify(targetModels)}`,
  )
  const probeTierPair = async (tier: AutoSelectionTier): Promise<void> => {
    const easyPromise = runProbePoint(tier, "easy", PREWARM_PROMPT)
    const snippet =
      tier === "intelligence" ? undefined : await sampleHardSnippet(sourceRoot)
    const hardPrompt =
      tier === "intelligence" ? getIntelligenceProbePrompt()
      : snippet === undefined ? undefined
      : `${snippet.text}\n\n${HARD_QUESTION}`
    const hardPromise =
      hardPrompt === undefined ?
        Promise.resolve(undefined)
      : runProbePoint(tier, "hard", hardPrompt)
    const [easyModel, hardModel] = await Promise.all([easyPromise, hardPromise])
    const retryIntelligence =
      tier === "intelligence"
      && getMissingSourceModels(targetModels, "auto").length > 0
    if (
      !retryIntelligence
      && (easyModel === undefined
        || hardModel === undefined
        || easyModel !== hardModel)
    )
      return
    if (tier === "intelligence") {
      await runProbePoint(tier, "hard", getIntelligenceProbePrompt(1))
      return
    }
    const resample = await sampleHardSnippet(sourceRoot, defaultRng, snippet)
    if (resample === undefined) return
    await runProbePoint(tier, "hard", `${resample.text}\n\n${HARD_QUESTION}`)
  }
  syncAuthEpoch()
  discoveryRan = true
  discoveryToken = state.copilotToken
  const autoProbes = Promise.all(STARTUP_TIERS.map(probeTierPair))
  const fusionProbes = Promise.all(
    fusionSeedProbes().map((probe) => runSourceProbe(probe)),
  )
  fusionSeedRound = fusionProbes
  latestProbeRound = Promise.all([autoProbes, fusionProbes])
  const probes = latestProbeRound
  startTargetDiscovery(targetModels, autoProbes, "startup")
  // Fusion retries do not wait for a stalled Auto source, but never precede its seeds.
  startFusionDiscovery(fusionProbes, "startup")
  let snapshot: string | undefined
  const reportResult = (): void => {
    const current = discoverySnapshot(targetModels)
    if (current !== snapshot) {
      logAutoDiscovery("discovery result", targetModels)
      snapshot = current
    }
  }
  if (startupBudgetMs === undefined) {
    await probes
    reportResult()
  } else {
    const timer = new AbortController()
    try {
      const winner = await Promise.race([
        probes.then(() => "probes" as const),
        delay(startupBudgetMs, undefined, { signal: timer.signal }).then(
          () => "budget" as const,
        ),
      ])
      if (winner === "probes") reportResult()
      else {
        logAutoDiscovery("discovery snapshot", targetModels)
        snapshot = discoverySnapshot(targetModels)
        void probes.then(reportResult, () => undefined)
      }
    } finally {
      timer.abort()
    }
  }
}

const colorAutoSessionEvent = (event: "hit" | "miss"): string => {
  if (!shouldUseColor()) return event
  return `\x1b[1;${event === "hit" ? 92 : 93}m${event}\x1b[0m`
}

export const logAutoSessionSelection = ({
  model,
  endpoint,
  selection,
  transport,
}: {
  model: string
  endpoint?: string
  selection?: AutoSessionSelection
  transport?: "websocket"
}): void => {
  consola.info(
    `[auto-session] ${colorAutoSessionEvent(selection ? "hit" : "miss")} model=${formatAutoSessionModel(model)} source=${selection?.source ?? "none"} expected_discount=${selection?.expectedDiscount ?? 0}%${endpoint === undefined ? "" : ` endpoint=${formatLogValue(endpoint)}`}${transport === undefined ? "" : ` transport=${transport}`}`,
  )
}

const identityReady = (authToken: string | undefined): boolean =>
  !probeSchedulerStopped
  && authToken !== undefined
  && authToken === state.copilotToken
  && discoveryToken === authToken

const reacquireSource = (
  model: string,
  probe: ProbeSource,
  reason: "expired" | "rejected",
  fromRefreshTimer = false,
): void => {
  if (probeSchedulerStopped) return
  // Explicit Auto probes/refreshes also establish a renewable source before
  // startup discovery; they must not turn an expired known model into a cold miss.
  if (
    !identityReady(state.copilotToken)
    && (discoveryRan || discoveryToken !== undefined)
  )
    return
  if (Date.now() < runtimes[probe.source].cooldownUntil) return
  if (probe.source === "fusion") {
    fusionRenewalModels.add(model)
    startFusionDiscovery(fusionSeedRound, reason, { probe, fromRefreshTimer })
    return
  }
  const existing = inflightProbePoints.get(probeKey(probe))
  if (existing !== undefined) {
    // Invalidation makes an already-running result inadmissible. Reacquire only
    // after that single flight settles, never in parallel with the old request.
    if (reason === "rejected") {
      void existing.then(() => {
        if (!isSourceCovered(model, probe.source))
          reacquireSource(model, probe, "expired")
      })
    }
    return
  }
  consola.info(
    `[auto-session] probe start reason=${reason} model=${formatAutoSessionModel(model)} source=${probe.source} expected_discount=${EXPECTED_DISCOUNT[probe.source]}%`,
  )
  void runSourceProbe(probe).then(() => {
    if (!isSourceCovered(model, probe.source)) {
      runtimes[probe.source].cooldownUntil =
        Date.now() + TARGET_DISCOVERY_COOLDOWN_MS
    }
    consola.info(
      `[auto-session] probe result reason=${reason} source=${probe.source} missing=${JSON.stringify(getMissingSourceModels([model], probe.source))}`,
    )
  })
}

const selectPairing = (
  model: string,
  endpoint: string | undefined,
  authToken: string | undefined,
  excludedSources: ReadonlySet<AutoSessionSource> | undefined,
): AutoSessionSelection | undefined => {
  const slots = pairings.get(model)
  for (const source of SOURCES) {
    const pairing = slots?.[source]
    if (
      !pairing
      || excludedSources?.has(source)
      || !isPairingValid(model, pairing, authToken)
    )
      continue
    if (
      endpoint !== undefined
      && !pairing.supportedEndpoints.includes(endpoint)
    )
      continue
    return {
      sessionToken: pairing.sessionToken,
      source,
      expectedDiscount: pairing.expectedDiscount,
    }
  }
  return undefined
}

export const getAutoSessionForModel = async ({
  model,
  endpoint,
  authToken = state.copilotToken,
  excludedSources,
  waitForDiscovery = true,
}: {
  model: string
  endpoint?: string
  authToken?: string
  excludedSources?: ReadonlySet<AutoSessionSource>
  waitForDiscovery?: boolean
}): Promise<AutoSessionSelection | undefined> => {
  syncAuthEpoch()
  pruneRejectedTokens()
  const requestEpoch = authEpoch
  const slots = pairings.get(model)
  const identityMismatch = authToken !== state.copilotToken
  let expired = false
  if (slots !== undefined) {
    for (const source of SOURCES) {
      const pairing = slots[source]
      if (pairing === undefined) continue
      if (pairing.authToken !== authToken || pairing.epoch !== authEpoch) {
        continue
      }
      if (pairing.expiresAt * 1000 <= Date.now()) {
        delete slots[source]
        clearRefreshTimer(model, source)
        expired = true
        consola.info(
          `[auto-session] expired model=${formatAutoSessionModel(model)} source=${source} expected_discount=${pairing.expectedDiscount}% reason=expired`,
        )
        reacquireSource(model, pairing.probe, "expired")
      }
    }
    if (!slots.fusion && !slots.auto) pairings.delete(model)
  }
  let selected = selectPairing(model, endpoint, authToken, excludedSources)
  if (!identityMismatch && identityReady(authToken)) {
    const targets = getConfiguredTargetModels()
    if (targets.includes(model) && !isSourceCovered(model, "auto")) {
      startTargetDiscovery(
        targets,
        Promise.resolve(),
        expired ? "expired" : "miss",
      )
    }
    // An Auto hit must remain immediate while Fusion is acquired in the background.
    if (
      !isSourceCovered(model, "fusion")
      && (targets.includes(model) || isSourceCovered(model, "auto"))
    ) {
      const source = pairingSources.get(pairingKey(model, "fusion"))
      if (source !== undefined) reacquireSource(model, source, "expired")
      else startFusionDiscovery()
    }
    if (
      selected === undefined
      && waitForDiscovery
      && targets.includes(model)
      && (SOURCES.some((source) => runtimes[source].round !== undefined)
        || inflightProbePoints.size > 0)
    ) {
      await waitForTarget(model, authToken)
      if (authEpoch === requestEpoch && authToken === state.copilotToken) {
        selected = selectPairing(model, endpoint, authToken, excludedSources)
      }
    }
  }
  logAutoSessionSelection({ model, endpoint, selection: selected })
  return selected
}
