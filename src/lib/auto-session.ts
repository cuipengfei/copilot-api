import consola from "consola"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import {
  getAutoSelection,
  type AutoSelectionResponse,
  type AutoSelectionTier,
} from "~/services/copilot/get-auto-selection"

import { HTTPError } from "./error"
import { state } from "./state"

interface AutoSessionPairing {
  sessionToken: string
  expiresAt: number
  supportedEndpoints: Array<string>
  authToken: string | undefined
}

// 以 /auto 实际选中的模型 ID 为键；同一模型只保留一份有效配对
const pairings = new Map<string, AutoSessionPairing>()

const PREWARM_PROMPT = "hello"
const PREWARM_TIER: AutoSelectionTier = "balance"
const STARTUP_TIERS: Array<AutoSelectionTier> = [
  "efficiency",
  "balance",
  "intelligence",
  "fast",
]
const HARD_QUESTION =
  "请指出这段代码中最可能的正确性问题，以及确认该问题所需的信息。"
const DEFAULT_SOURCE_ROOT = join(process.cwd(), "src")
// 启动等待预算：上游持续故障时服务启动的最长等待；在途探测到期后转后台继续
export const STARTUP_PROBE_BUDGET_MS = 30_000

const isUsable = (pairing: AutoSessionPairing): boolean =>
  pairing.expiresAt * 1000 > Date.now()

// /auto 的 supported_endpoints 为完整路径（如 /responses、/v1/messages、/chat/completions，
// WebSocket 形如 ws:/responses）；调用方传入的同样是完整路径，精确匹配即可
const pairingSupportsEndpoint = (
  pairing: AutoSessionPairing,
  endpoint: string,
): boolean => pairing.supportedEndpoints.includes(endpoint)

export const registerAutoSelection = (
  selection: AutoSelectionResponse,
): boolean => {
  const modelId = selection.selected_model?.id
  const sessionToken = selection.session_token
  const expiresAt = selection.expires_at
  const supportedEndpoints = selection.selected_model?.supported_endpoints

  // 边界校验：端点列表必须为字符串数组，非法元素会让后续匹配崩溃或误发 token
  if (
    typeof modelId !== "string"
    || modelId.length === 0
    || typeof sessionToken !== "string"
    || sessionToken.length === 0
    || typeof expiresAt !== "number"
    || !Number.isFinite(expiresAt)
    || expiresAt * 1000 <= Date.now()
    || (supportedEndpoints !== undefined
      && (!Array.isArray(supportedEndpoints)
        || supportedEndpoints.some((endpoint) => typeof endpoint !== "string")))
  ) {
    consola.warn("[auto-session] ignored invalid auto selection")
    return false
  }

  pairings.set(modelId, {
    sessionToken,
    expiresAt,
    supportedEndpoints: supportedEndpoints ?? [],
    authToken: state.copilotToken,
  })
  return true
}

export const refreshAutoSession = async (): Promise<void> => {
  for (;;) {
    // 请求发出时快照凭据：响应到达时若凭据已轮换，
    // 旧凭据响应不得登记到新凭据配对，换新凭据重试
    const requestToken = state.copilotToken
    const selection = await getAutoSelection(PREWARM_PROMPT, PREWARM_TIER)
    if (state.copilotToken !== requestToken) continue
    if (!registerAutoSelection(selection)) {
      // 非法响应不得记为刷新成功，调用方据此感知失败且不缓存无效 token
      throw new Error("invalid auto selection response")
    }
    scheduleRefresh(
      selection.selected_model.id,
      PREWARM_TIER,
      "easy",
      PREWARM_PROMPT,
      selection.expires_at,
    )
    consola.info(
      `[auto-session] refreshed token, models=${[...pairings.keys()].join(",")}`,
    )
    return
  }
}

export const invalidateAutoSession = (): void => {
  pairings.clear()
  clearAllRefreshTimers()
  // 只唤醒鉴权暂停的探测：各点自行比较凭据是否真正变化；
  // 正在遵守退避的点不被动摇（它们与凭据无关）。
  // 本函数绝不发请求：测试清理与服务热路径都会调用它，
  // 轮换后的补采只属于显式的身份变化入口
  wakeAll(haltWaiters)
}

// HTTP 热路径用：仅当该模型当前配对仍持有请求实际携带的 session token
// 时才删除（迟到响应/并发轮换不得抹掉新映射）；不碰其它模型配对与其
// 刷新定时器。返回是否真的删除了配对。
export const invalidateAutoSessionPairing = (
  model: string,
  sessionToken: string,
): boolean => {
  const pairing = pairings.get(model)
  if (!pairing || pairing.sessionToken !== sessionToken) {
    return false
  }
  pairings.delete(model)
  clearRefreshTimer(model)
  return true
}

// 真实身份轮换后的补采入口：仅 token-metadata/token.ts 的凭据变化分支调用。
// 门检与 t41 相同（确实运行过 discovery + 凭据真正变化 + 调度未停止），
// 先更新已处理标记再启动请求，并发/连续调用幂等；初次 setup 因
// !discoveryRan 静默。复用 runProbePoint 单飞：与刚被唤醒的挂起点
// 自我重试自动合并为每点一个在途
export const resumeAutoSessionDiscoveryAfterRotation = (): void => {
  if (
    !discoveryRan
    || probeSchedulerStopped
    || state.copilotToken === discoveryToken
  ) {
    return
  }
  discoveryToken = state.copilotToken
  for (const { tier, kind, prompt } of lastSuccessPrompts.values()) {
    void runProbePoint(tier, kind, prompt)
  }
}

export interface HardSnippet {
  file: string
  startLine: number
  text: string
}

type Rng = (maxExclusive: number) => number

const defaultRng: Rng = (maxExclusive) =>
  Math.floor(Math.random() * maxExclusive)

// 先均匀选一份不少于 100 行的 TypeScript 文件，再在其中均匀选连续 100 行的起点。
// exclude 用于重采时排除已用过的片段；无替代候选时返回 undefined，由调用方记未完成。
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
      // 文件末尾换行只产生一个空伪行，不得计入 100 行门槛
      if (lines[lines.length - 1] === "") lines.pop()
      if (lines.length < 100) continue
      // 唯一窗口的片段被排除时整份文件无替代起点，不进候选
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
    // 只记失败类别：原始错误可能带文件路径等实现细节
    consola.warn(
      `[auto-session] source sampling failed: ${probeFailureKind(error)}`,
    )
    return undefined
  }
}

// 只记录可排查的最小状态：HTTP 状态码、超时/中止名称、网络失败类别。
// 不打印 error 对象、prompt、源码、令牌或 tier：请求 prompt 可能含真实源码。
const probeFailureKind = (error: unknown): string => {
  if (error instanceof HTTPError) return `http ${error.response.status}`
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return error.name
    }
    if (error.name === "TypeError") return "network"
    return error.name
  }
  return "unknown"
}

const RETRY_BASE_MS = 1_000
const RETRY_CAP_MS = 30_000

// 5xx/网络失败的随机退避：指数翻倍至 30s 封顶，抖动系数 [1, 1.5)（从 1 秒起随机）
export const nextBackoffMs = (failures: number): number => {
  const exponential = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** failures)
  return Math.min(
    RETRY_CAP_MS,
    exponential + defaultRng(Math.ceil(exponential / 2)),
  )
}

// Retry-After：秒数或 HTTP-date；缺失/空串/非法时交给随机退避。
// 注意 Number('') === 0：空串必须先于数值解析剔除
const parseRetryAfterMs = (header: string | null): number | undefined => {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (trimmed !== "") {
    const seconds = Number(trimmed)
    if (Number.isFinite(seconds) && seconds >= 0) {
      const ms = seconds * 1000
      // 相乘后非有限或超安全整数（如 1e308/1e16 秒）视为非法头，回退随机退避；
      // 合法大等待原样返回（由 probeSleep 分块），不得缩短
      if (Number.isSafeInteger(ms)) return ms
      return undefined
    }
  }
  const dateMs = Date.parse(trimmed)
  if (trimmed !== "" && !Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now())
  }
  return undefined
}

// 逐点调度状态：401/403 对同一凭据暂停，直到凭据真正变化；
// stopProbeScheduler 供测试清理与（后续切片）进程关闭，停止后不再发新请求
let probeHaltActive = false
let probeHaltToken: string | undefined
let probeSchedulerStopped = false
// 鉴权暂停等待者：凭据变化（invalidate 边界）或停止时唤醒
const haltWaiters = new Set<() => void>()
// 退避睡眠等待者：只被停止或 401/403 收敛事件唤醒；
// 同凭据的缓存清空（invalidate）不得打断正在遵守的退避
const sleepWaiters = new Set<() => void>()
// discovery 是否曾运行及其发起时的凭据：invalidate 补采门检用，
// 防初次 setup 前/同凭据 invalidate 触发自动补采
let discoveryRan = false
let discoveryToken: string | undefined
// 每个模型最近成功登记的来源 (tier,kind,prompt)：配对过期后的 miss
// 按它补采；成功登记时覆盖，模型目录有界
const pairingSources = new Map<
  string,
  { tier: AutoSelectionTier; kind: "easy" | "hard"; prompt: string }
>()
// 每 (tier,kind) 最近成功探测的 prompt 来源：凭据轮换后按它后台重探；
// 失效清空配对时不得清掉；每点一条，有界
const lastSuccessPrompts = new Map<
  string,
  { tier: AutoSelectionTier; kind: "easy" | "hard"; prompt: string }
>()

const wakeAll = (waiters: Set<() => void>): void => {
  const pending = [...waiters]
  waiters.clear()
  for (const wake of pending) wake()
}

const parkProbe = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  haltWaiters.add(resolve)
  try {
    await promise
  } finally {
    haltWaiters.delete(resolve)
  }
}

// 可被打断的退避睡眠：停止/收敛事件先到则立即返回；
// 长 Retry-After 超过 JS 定时器上限会被运行时压成 ~1ms 立即触发（实测 Bun/Node
// 均 TimeoutOverflowWarning→1ms），必须把合法大等待按 2^31-1ms 分块、以截止
// 时刻维护剩余；结束时取消未触发的 delay，长 Retry-After 不得留下活跃计时器
const probeSleep = async (ms: number): Promise<void> => {
  const timer = new AbortController()
  const { promise: woken, resolve } = Promise.withResolvers<void>()
  let woke = false
  const wake = (): void => {
    woke = true
    resolve()
  }
  sleepWaiters.add(wake)
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
    sleepWaiters.delete(wake)
    timer.abort()
  }
}

// 401/403 后的同凭据暂停。注意：单纯清空配对缓存不算凭据变化，
// 必须 state.copilotToken 与发起请求时记录的凭据不同才恢复；
// 无凭据（undefined）场景以独立哨兵保证仍进入暂停，避免无限高速重试
const waitOutHalt = async (): Promise<void> => {
  while (
    !probeSchedulerStopped
    && probeHaltActive
    && state.copilotToken === probeHaltToken
  ) {
    await parkProbe()
  }
  if (state.copilotToken !== probeHaltToken) probeHaltActive = false
}

export const stopProbeScheduler = (): void => {
  probeSchedulerStopped = true
  clearAllRefreshTimers()
  wakeAll(haltWaiters)
  wakeAll(sleepWaiters)
}

// 最近一轮探测的结算 Promise：测试清理与进程关闭（第三切片）先 stop 再 await 它，
// 保证全部已启动探测结束后再释放资源
let latestProbeRound: Promise<unknown> = Promise.resolve()
export const whenProbeSchedulerIdle = async (): Promise<void> => {
  await latestProbeRound
  // 定时器发起的到期刷新等任意在途点请求也必须结算：stop 后先等它们，
  // 测试/关闭方才不会过早恢复 fetch 替身或释放资源。
  // 只取当前快照，不向 latestProbeRound 链式累积（长寿命进程防无限增长）
  await Promise.all([...inflightProbePoints.values()])
}

const isRetriableNetworkError = (error: Error): boolean =>
  error.name === "TypeError"
  || error.name === "TimeoutError"
  || error.name === "AbortError"

// 单点重试循环：返回登记成功的模型 ID；undefined 表示终止性失败或已停止，
// 由调用方计入未完成。日志只含状态分类，不含 prompt/源码/token/tier。

// 每条配对按自己的 expires_at 在到期前 5 分钟刷新；delay 用纯函数计算便于测试
export const REFRESH_AHEAD_MS = 5 * 60 * 1000
const MAX_TIMER_MS = 2 ** 31 - 1

// due = expiresAt - 5min；到期不足 5 分钟（含已过期）按 0ms 立即补采，
// 远到期按 2^31-1ms 封顶（触发时重算重排，避免 JS 定时器溢出）
export const nextRefreshDelayMs = (
  expiresAtMs: number,
  now: number,
): number => {
  const fireIn = expiresAtMs - REFRESH_AHEAD_MS - now
  return Math.min(MAX_TIMER_MS, Math.max(fireIn, 0))
}

const refreshTimers = new Map<string, NodeJS.Timeout>()

const clearRefreshTimer = (modelId: string): void => {
  const timer = refreshTimers.get(modelId)
  if (timer !== undefined) {
    clearTimeout(timer)
    refreshTimers.delete(modelId)
  }
}

const clearAllRefreshTimers = (): void => {
  for (const timer of refreshTimers.values()) clearTimeout(timer)
  refreshTimers.clear()
}

// 注册成功后按该配对的 expires_at 排程到期前刷新。
// 到期过远时定时器按 2^31-1ms 封顶，触发时重算重排，避免 JS 定时器溢出
const scheduleRefresh = (
  modelId: string,
  tier: AutoSelectionTier,
  kind: "easy" | "hard",
  prompt: string,
  expiresAt: number,
  fromRefreshTimer = false,
): void => {
  // 登记成功即记录来源（先于任何早退分支）：resume 补采与过期 miss 补采
  // 都依赖这两张 Map；probePointLoop 与 refreshAutoSession 经此共用
  lastSuccessPrompts.set(`${tier}:${kind}`, { tier, kind, prompt })
  pairingSources.set(modelId, { tier, kind, prompt })
  if (probeSchedulerStopped) return
  const fireIn = expiresAt * 1000 - REFRESH_AHEAD_MS - Date.now()
  // 定时器发起的刷新若仍拿到窗口内 expiry：再排一条 0ms 定时器只会零等待连刷，
  // 配对保持原样到自然过期；非定时器来源（首次登记/显式刷新）照常按 due 排程
  if (fromRefreshTimer && fireIn <= 0) return
  clearRefreshTimer(modelId)
  const delayMs = nextRefreshDelayMs(expiresAt * 1000, Date.now())
  const timer = setTimeout(() => {
    refreshTimers.delete(modelId)
    // 失效/重新注册后旧定时器不得再发请求：配对须仍是排程时那一个
    const current = pairings.get(modelId)
    if (probeSchedulerStopped || !current || current.expiresAt !== expiresAt) {
      return
    }
    // 封顶定时器（>2^31-1ms）会提前多天触发：重算真实刷新时刻，
    // 未到 expires_at-5min 就重排等待，不得提前请求 /auto；到时才发一次
    if (expiresAt * 1000 - REFRESH_AHEAD_MS - Date.now() > 0) {
      scheduleRefresh(modelId, tier, kind, prompt, expiresAt, true)
      return
    }
    void runProbePoint(tier, kind, prompt, true)
  }, delayMs)
  timer.unref?.()
  refreshTimers.set(modelId, timer)
}
const probePointLoop = async (
  prompt: string,
  tier: AutoSelectionTier,
  kind: "easy" | "hard",
  fromRefreshTimer = false,
): Promise<string | undefined> => {
  let failures = 0
  // 首试不受暂停影响：每个点都完成第一次尝试，暂停只作用于重试
  let attempted = false
  for (;;) {
    if (probeSchedulerStopped) return undefined
    if (attempted) await waitOutHalt()
    if (probeSchedulerStopped) return undefined
    // 请求发出时快照凭据：响应到达时凭据可能已轮换，
    // 401/403 只归责于发起请求的凭据。须在 try 外声明：
    // catch 与 try 是不同的块级作用域，try 内 const 在 catch 不可见
    const requestToken = state.copilotToken
    try {
      attempted = true
      const selection = await getAutoSelection(prompt, tier)
      // 注册前校验：响应属于请求发出时的凭据。轮换后到达的旧凭据响应
      // 不得写入新凭据配对，转为新凭据重新探测（非失败，不累计退避）
      if (state.copilotToken !== requestToken) continue
      if (registerAutoSelection(selection)) {
        scheduleRefresh(
          selection.selected_model.id,
          tier,
          kind,
          prompt,
          selection.expires_at,
          fromRefreshTimer,
        )
        return selection.selected_model.id
      }
      consola.warn("[auto-session] ignored invalid auto selection")
      return undefined
    } catch (error) {
      if (error instanceof HTTPError) {
        const status = error.response.status
        if (status === 401 || status === 403) {
          // 收敛事件：唤醒退避睡眠让其余点尽快进入暂停
          wakeAll(sleepWaiters)
          if (state.copilotToken === requestToken) {
            probeHaltActive = true
            probeHaltToken = requestToken
            wakeAll(haltWaiters)
          }
          continue
        }
        if (status === 429) {
          const retryAfterMs = parseRetryAfterMs(
            error.response.headers.get("retry-after"),
          )
          // 0/缺失（含空串）都回退随机退避：重试必须先等待，禁止零等待空转
          await probeSleep(
            retryAfterMs !== undefined && retryAfterMs > 0 ?
              retryAfterMs
            : nextBackoffMs(failures),
          )
          failures += 1
          continue
        }
        if (status >= 500 && status <= 599) {
          await probeSleep(nextBackoffMs(failures))
          failures += 1
          continue
        }
        // 400 等请求格式类错误：记为待处理，不反复发送相同请求
        consola.warn(`[auto-session] probe pending: http ${status}`)
        return undefined
      }
      if (error instanceof Error && isRetriableNetworkError(error)) {
        // 每次重试前只记固定类别，不带错误对象与请求上下文；
        // 退避下限 1s 保证日志频率有界
        consola.warn(`[auto-session] probe retry: ${probeFailureKind(error)}`)
        await probeSleep(nextBackoffMs(failures))
        failures += 1
        continue
      }
      consola.warn(`[auto-session] probe failed: ${probeFailureKind(error)}`)
      return undefined
    }
  }
}

// 探测调度入口：同一 (tier, kind) 点任意时刻只有一个在途请求。
// 工单04的到期刷新复用此入口，避免同点并发另启请求。
const inflightProbePoints = new Map<string, Promise<string | undefined>>()
export const runProbePoint = (
  tier: AutoSelectionTier,
  kind: "easy" | "hard",
  prompt: string,
  fromRefreshTimer = false,
): Promise<string | undefined> => {
  const key = `${tier}:${kind}`
  const existing = inflightProbePoints.get(key)
  if (existing !== undefined) return existing
  const attempt = probePointLoop(prompt, tier, kind, fromRefreshTimer).finally(
    () => {
      inflightProbePoints.delete(key)
    },
  )
  inflightProbePoints.set(key, attempt)
  return attempt
}

interface PrewarmOptions {
  sourceRoot?: string
  // 启动等待预算（毫秒）：提供时 race 全部探测与可取消延时，到期后未完成探测
  // 在后台继续，不阻断服务启动；不提供时保持原样的全量等待
  startupBudgetMs?: number
}

export const prewarmAutoSession = async ({
  sourceRoot,
  startupBudgetMs,
}: PrewarmOptions = {}): Promise<void> => {
  // 未完成点按"待处理"口径统计：四档×两点全部先计入，
  // 每个点成功登记时即时扣减，预算到期打快照即为剩余未完成点数；
  // 终止失败/无法取样的点自然维持待处理
  let incomplete = STARTUP_TIERS.length * 2

  // 八点互不阻断：同档简单题与难题并发发起，各自独立重试
  const probeTierPair = async (tier: AutoSelectionTier): Promise<void> => {
    // 简单题先发起、不等源码采样：采样挂起或失败不得阻断登记
    const easyPromise = runProbePoint(tier, "easy", PREWARM_PROMPT)
    // 逐点结算即扣减：挂在原始 promise 上的 then 先于 Promise.all 续体执行，
    // 成功登记的点在快照前必然已扣
    const easyCounted = easyPromise.then((model) => {
      if (model !== undefined) incomplete -= 1
      return model
    })
    // 每档难题独立取样：各档随机取样仍可能偶然相同；重采仅排除本档第一次片段
    const snippet = await sampleHardSnippet(sourceRoot)
    const hardPrompt =
      snippet === undefined ? undefined : `${snippet.text}\n\n${HARD_QUESTION}`
    const hardPromise =
      hardPrompt === undefined ?
        Promise.resolve(undefined)
      : runProbePoint(tier, "hard", hardPrompt)
    const hardCounted = hardPromise.then((model) => {
      if (model !== undefined) incomplete -= 1
      return model
    })
    const [easyModel, hardModel] = await Promise.all([easyCounted, hardCounted])
    if (
      easyModel === undefined
      || hardModel === undefined
      || easyModel !== hardModel
    ) {
      return
    }
    // 同档两题选中同一模型：重采难题一次；无替代源码段记未完成，不做无限重试
    const resample = await sampleHardSnippet(sourceRoot, defaultRng, snippet)
    if (resample === undefined) {
      incomplete += 1
      return
    }
    const retried = await runProbePoint(
      tier,
      "hard",
      `${resample.text}\n\n${HARD_QUESTION}`,
    )
    if (retried === undefined) incomplete += 1
  }

  const logDiscovery = (label: "complete" | "snapshot"): void => {
    consola.info(
      `[auto-session] discovery ${label} models=${[...pairings.keys()].sort().join(",")} incomplete=${incomplete}`,
    )
  }

  discoveryRan = true
  discoveryToken = state.copilotToken
  latestProbeRound = Promise.all(STARTUP_TIERS.map(probeTierPair))
  const probes = latestProbeRound
  if (startupBudgetMs === undefined) {
    await probes
    logDiscovery("complete")
  } else {
    const timer = new AbortController()
    try {
      const winner = await Promise.race([
        probes.then(() => "probes" as const),
        delay(startupBudgetMs, undefined, { signal: timer.signal }).then(
          () => "budget" as const,
        ),
      ])
      if (winner === "probes") {
        logDiscovery("complete")
      } else {
        // 预算到期只是快照：后台探测仍在运行，全部结束后补最终日志
        logDiscovery("snapshot")
        probes.then(
          () => logDiscovery("complete"),
          () => undefined,
        )
      }
    } finally {
      // 探测先完成时及时取消计时器；到期时不中止仍在运行的合法探测
      timer.abort()
    }
  }
}
export const isModelAutoCovered = (model: string): boolean => {
  const pairing = pairings.get(model)
  // 与 getAutoSessionTokenForModel 同一有效性标准：到期或旧凭据配对
  // 不得对外误报覆盖
  return (
    pairing !== undefined
    && isUsable(pairing)
    && pairing.authToken === state.copilotToken
  )
}

/* eslint-disable @typescript-eslint/require-await -- 保留 async 签名（既有 API 契约）；过期补采为 fire-and-forget（void runProbePoint），本函数不等待它 */
export const getAutoSessionTokenForModel = async (
  model: string,
  endpoint?: string,
): Promise<string | undefined> => {
  const pairing = pairings.get(model)

  if (!pairing) {
    // 未知模型/无来源：保持原有无 token 行为，不为每次 miss 创造请求
    consola.info(`[auto-session] miss model=${model}`)
    return undefined
  }

  if (pairing.authToken !== state.copilotToken) {
    // 凭据失配必须早于过期补采判定：metadata 更新尚未完成时普通请求
    // 不得以新 token+旧 metadata 发 /auto。认证补采只归
    // resumeAutoSessionDiscoveryAfterRotation（完整更新后）；此处零请求
    consola.info(`[auto-session] miss model=${model}`)
    return undefined
  }

  if (!isUsable(pairing)) {
    // 曾有来源的过期配对：第一次 miss 删掉该模型的失效配对与旧刷新
    // 定时器（不动其它模型），按记录来源异步补采；runProbePoint 单飞
    // 保证并发 lookup 只发一次 /auto，此时正常请求仍无 token 继续
    const source = pairingSources.get(model)
    pairings.delete(model)
    clearRefreshTimer(model)
    if (source !== undefined && !probeSchedulerStopped) {
      consola.info(`[auto-session] expired model=${model} re-probe`)
      void runProbePoint(source.tier, source.kind, source.prompt)
    } else {
      consola.info(`[auto-session] miss model=${model}`)
    }
    return undefined
  }

  if (endpoint !== undefined && !pairingSupportsEndpoint(pairing, endpoint)) {
    consola.info(`[auto-session] miss model=${model} endpoint=${endpoint}`)
    return undefined
  }

  consola.info(`[auto-session] hit model=${model}`)
  return pairing.sessionToken
}
/* eslint-enable @typescript-eslint/require-await */
