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
  HARD_QUESTION,
  PREWARM_PROMPT,
  TARGET_CODE_PROMPT,
} from "~/lib/auto-probe-prompts"
import { getConfig } from "./config-store"
import { HTTPError } from "./error"
import { shouldUseColor } from "./logger"
import { state } from "./state"

interface AutoSessionPairing {
  sessionToken: string
  expiresAt: number
  supportedEndpoints: Array<string>
  authToken: string | undefined
}

// 以 /auto 实际选中的模型 ID 为键；同一模型只保留一份有效配对
const pairings = new Map<string, AutoSessionPairing>()

const PREWARM_TIER: AutoSelectionTier = "balance"
const STARTUP_TIERS: Array<AutoSelectionTier> = [
  "efficiency",
  "balance",
  "intelligence",
  "fast",
]
const TARGET_PROBE_INTERVAL_MS = 3_000
const TARGET_ATTEMPTS_PER_TIER = 10
// 配置目标 miss 补采：前台等待上限；一轮耗尽后防止连续 miss 重开扫描的短冷却
const TARGET_MISS_WAIT_MS = 2_000
const TARGET_DISCOVERY_COOLDOWN_MS = 600_000
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
  // 登记真实 selected_model 后唤醒该目标下同一凭据 epoch 的 miss 等待者；
  // 等待者醒后仍按凭据/有效期/端点重检，旧 epoch 等待只由 invalidate/stop 终止
  wakeTargetWaiters(modelId, state.copilotToken)
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
  targetDiscoveryCooldownUntil = 0
  // 只唤醒鉴权暂停的探测：各点自行比较凭据是否真正变化；
  // 正在遵守退避的点不被动摇（它们与凭据无关）。
  // 本函数绝不发请求：测试清理与服务热路径都会调用它，
  // 轮换后的补采只属于显式的身份变化入口
  wakeAll(haltWaiters)
  // 凭据轮换终止全部 miss 等待 epoch：等待者醒后发现凭据快照失配，
  // 不得把新上下文配对返回给携带旧 Authorization 的原请求
  wakeAllTargetWaiters()
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
// 先更新已处理标记再启动请求，并发/连续调用幂等。metadata 更新完成即记录
// 凭据就绪标记（discoveryToken），即使首轮 discovery 尚未运行（如 provider-only
// 启动后 reload 启用 Copilot，无 prewarm）：miss 补采以该标记判定身份就绪，
// 此处不替 miss 发请求；首轮真正开始后 discoveryRan 置位，后续轮换正常补采
export const resumeAutoSessionDiscoveryAfterRotation = (): void => {
  if (probeSchedulerStopped || state.copilotToken === discoveryToken) {
    return
  }
  discoveryToken = state.copilotToken
  if (!discoveryRan) return
  for (const { tier, kind, prompt } of lastSuccessPrompts.values()) {
    void runProbePoint(tier, kind, prompt)
  }
  startTargetDiscovery(getConfiguredTargetModels())
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
    return "error"
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
// discoveryToken：凭据就绪标记，metadata 更新完成时由 resume 记录（含首轮
// 未运行的 reload 启用路径）；miss/rotation 补采门检都用它防 metadata 未就绪
// 时抢先发请求。discoveryRan：首轮探测是否已开始（prewarm 或首轮定向轮），
// 首轮开始后 rotation 补采才重放成功点
let discoveryRan = false
let discoveryToken: string | undefined
// 定向轮耗尽后的短冷却截止（epoch ms）：冷却内 miss 不再开新轮，
// 防连续 miss 每请求重启 40 次扫描；invalidate/stop 时清零
let targetDiscoveryCooldownUntil = 0
// 每个模型最近成功登记的来源 (tier,kind,prompt)：配对过期后的 miss
// 按它补采；成功登记时覆盖，模型目录有界
type ProbeKind = "easy" | "hard" | "target"
const pairingSources = new Map<
  string,
  { tier: AutoSelectionTier; kind: ProbeKind; prompt: string }
>()
// 每 (tier,kind) 最近成功探测的 prompt 来源：凭据轮换后按它后台重探；
// 失效清空配对时不得清掉；每点一条，有界
const lastSuccessPrompts = new Map<
  string,
  { tier: AutoSelectionTier; kind: ProbeKind; prompt: string }
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
// 配置目标就绪等待者：同一 model 的并发 miss 共享信号；每个等待者持有
// 进入时的凭据快照，轮换后注册的新配对不得唤醒旧 epoch 的等待者，
// 旧 epoch 等待只能由 invalidate/stop 统一终止
interface TargetWaiter {
  token: string | undefined
  wake: () => void
}
const targetWaiters = new Map<string, Set<TargetWaiter>>()

// 有界等待：超时只结束自身等待，不取消共享在途探测；计时器随唤醒清理。
// finish 幂等：timer/登记/轮换/stop 可能同时唤醒，重复执行不得误删
// 同 model 后来者的等待组（仅当 Map 中仍是本组且已空才移除）
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
    if (set.size === 0 && targetWaiters.get(model) === set) {
      targetWaiters.delete(model)
    }
    resolve()
  }
  const entry: TargetWaiter = { token, wake: finish }
  // timer 在 finish 之后声明：finish 只会被异步唤醒路径调用，无 TDZ 风险
  const timer = setTimeout(finish, TARGET_MISS_WAIT_MS)
  set.add(entry)
  return promise
}

// 登记真实 selected_model 后只唤醒同凭据快照的该目标等待者。
// 直接迭代：finish 只删当前成员（Set 迭代允许）并 resolve nativePromise
//（续体在微任务），迭代期间无同步新增/跨组删除，快照分配不必要
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
  wakeAllTargetWaiters()
}

// 最近一轮探测的结算 Promise：测试清理与进程关闭（第三切片）先 stop 再 await 它，
// 保证全部已启动探测结束后再释放资源
let latestProbeRound: Promise<unknown> = Promise.resolve()
let targetProbeRound: Promise<void> | undefined
export const whenProbeSchedulerIdle = async (): Promise<void> => {
  await latestProbeRound
  // 定时器发起的到期刷新等任意在途点请求也必须结算：stop 后先等它们，
  if (targetProbeRound !== undefined) await targetProbeRound
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
  kind: ProbeKind,
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
  kind: ProbeKind,
  fromRefreshTimer = false,
  maxRequests = Number.POSITIVE_INFINITY,
): Promise<string | undefined> => {
  let requests = 0
  let failures = 0
  // 首试不受暂停影响：每个点都完成第一次尝试，暂停只作用于重试
  let attempted = false
  for (;;) {
    if (probeSchedulerStopped) return undefined
    if (attempted) await waitOutHalt()
    if (requests >= maxRequests) return undefined
    if (probeSchedulerStopped) return undefined
    // 请求发出时快照凭据：响应到达时凭据可能已轮换，
    // 401/403 只归责于发起请求的凭据。须在 try 外声明：
    // catch 与 try 是不同的块级作用域，try 内 const 在 catch 不可见
    const requestToken = state.copilotToken
    try {
      attempted = true
      requests += 1
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
  kind: ProbeKind,
  prompt: string,
  fromRefreshTimer = false,
  maxRequests = kind === "target" ? 1 : Number.POSITIVE_INFINITY,
): Promise<string | undefined> => {
  const key = `${tier}:${kind}`
  const existing = inflightProbePoints.get(key)
  if (existing !== undefined) return existing
  const attempt = probePointLoop(
    prompt,
    tier,
    kind,
    fromRefreshTimer,
    maxRequests,
  ).finally(() => {
    inflightProbePoints.delete(key)
  })
  inflightProbePoints.set(key, attempt)
  return attempt
}

// 同一轮请求服务所有缺失模型，避免为每个目标重复发送相同的 /auto 请求。
const discoverTargets = async (models: Array<string>): Promise<void> => {
  let lastMissingCount = -1
  for (let attempt = 0; attempt < TARGET_ATTEMPTS_PER_TIER; attempt++) {
    for (const tier of STARTUP_TIERS) {
      if (probeSchedulerStopped) return
      const missing = getMissingAutoDiscoveryModels(models)
      if (missing.length !== lastMissingCount) {
        consola.info(`[auto-session] target models missing=${missing.length}`)
        lastMissingCount = missing.length
      }
      if (missing.length === 0) return

      await waitOutHalt()
      if (probeSchedulerStopped) return
      if (getMissingAutoDiscoveryModels(models).length === 0) return
      const existing = inflightProbePoints.get(`${tier}:target`)
      if (existing !== undefined) {
        await existing
        await probeSleep(TARGET_PROBE_INTERVAL_MS)
        continue
      }
      const prompt = attempt % 2 === 0 ? PREWARM_PROMPT : TARGET_CODE_PROMPT
      await runProbePoint(tier, "target", prompt, false, 1)
      const remaining = getMissingAutoDiscoveryModels(models).length
      if (remaining === 0) {
        consola.info("[auto-session] target models missing=0")
        return
      }
      await probeSleep(TARGET_PROBE_INTERVAL_MS)
    }
  }
  const remaining = getMissingAutoDiscoveryModels(models).length
  if (remaining !== lastMissingCount) {
    consola.info(`[auto-session] target models missing=${remaining}`)
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

const startTargetDiscovery = (
  models: Array<string>,
  after: Promise<unknown> = Promise.resolve(),
): void => {
  if (models.length === 0 || probeSchedulerStopped || targetProbeRound) return
  const startedToken = state.copilotToken
  // 首轮真正开始即置位：后续凭据轮换走 resume 正常补采
  discoveryRan = true
  targetProbeRound = after
    .then(() => discoverTargets(models))
    .finally(() => {
      targetProbeRound = undefined
      if (!probeSchedulerStopped && state.copilotToken !== startedToken) {
        startTargetDiscovery(getConfiguredTargetModels())
      } else if (
        !probeSchedulerStopped
        && getMissingAutoDiscoveryModels(models).length > 0
      ) {
        // 本轮耗尽仍有缺失：短冷却内 miss 不再开新轮，
        // 防止连续 miss 每请求重启 40 次扫描
        targetDiscoveryCooldownUntil = Date.now() + TARGET_DISCOVERY_COOLDOWN_MS
      }
    })
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
  const targetModels = getConfiguredTargetModels()
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
    consola.info(`[auto-session] discovery ${label} incomplete=${incomplete}`)
  }

  discoveryRan = true
  discoveryToken = state.copilotToken
  latestProbeRound = Promise.all(STARTUP_TIERS.map(probeTierPair))
  const probes = latestProbeRound
  startTargetDiscovery(targetModels, probes)
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

export const getMissingAutoDiscoveryModels = (
  models: ReadonlyArray<string>,
): Array<string> => models.filter((model) => !isModelAutoCovered(model))

const colorAutoSessionEvent = (event: "hit" | "miss"): string => {
  if (!shouldUseColor()) return event
  const colorCode = event === "hit" ? 92 : 93
  return `\x1b[1;${colorCode}m${event}\x1b[0m`
}
// 配置目标 miss 补采：身份就绪门检与 resumeAutoSessionDiscoveryAfterRotation 同
// 语义（discoveryToken 已在 metadata 更新完成时记录，无论首轮是否已运行），
// 防身份轮换处理完成前普通 miss 抢先请求；共享既有单飞定向轮（在途则直接
// 等待），前台最多等 TARGET_MISS_WAIT_MS。唤醒/超时后按进入时的凭据快照与
// 当前配对重检：轮换途中即使新配对已可用，也不得把它返回给携带旧
// Authorization 的原请求
const acquireConfiguredTarget = async (
  model: string,
  endpoint?: string,
): Promise<string | undefined> => {
  if (probeSchedulerStopped) return undefined
  const requestToken = state.copilotToken
  if (requestToken === undefined || discoveryToken !== requestToken) {
    return undefined
  }
  const targets = getConfiguredTargetModels()
  if (!targets.includes(model)) return undefined
  if (
    targetProbeRound === undefined
    && Date.now() >= targetDiscoveryCooldownUntil
  ) {
    startTargetDiscovery(targets)
  }
  if (targetProbeRound === undefined) return undefined
  consola.info(`[auto-session] target miss acquire model=${model}`)
  await waitForTarget(model, requestToken)
  if (state.copilotToken !== requestToken) return undefined
  const acquired = pairings.get(model)
  if (
    acquired === undefined
    || acquired.authToken !== requestToken
    || !isUsable(acquired)
  ) {
    return undefined
  }
  if (endpoint !== undefined && !pairingSupportsEndpoint(acquired, endpoint)) {
    return undefined
  }
  return acquired.sessionToken
}

export const getAutoSessionTokenForModel = async (
  model: string,
  endpoint?: string,
): Promise<string | undefined> => {
  const pairing = pairings.get(model)

  if (!pairing) {
    // 未知模型/无来源：保持原有无 token 行为，不为每次 miss 创造请求。
    // 配置目标 miss 走共享定向补采，前台最多等待 TARGET_MISS_WAIT_MS
    const acquired = await acquireConfiguredTarget(model, endpoint)
    if (acquired !== undefined) {
      consola.info(
        `[auto-session] ${colorAutoSessionEvent("hit")} model=${model}`,
      )
      return acquired
    }
    consola.info(
      `[auto-session] ${colorAutoSessionEvent("miss")} model=${model}`,
    )
    return undefined
  }

  if (pairing.authToken !== state.copilotToken) {
    // 凭据失配必须早于过期补采判定：metadata 更新尚未完成时普通请求
    // 不得以新 token+旧 metadata 发 /auto。认证补采只归
    // resumeAutoSessionDiscoveryAfterRotation（完整更新后）；此处零请求
    consola.info(
      `[auto-session] ${colorAutoSessionEvent("miss")} model=${model}`,
    )
    return undefined
  }

  if (!isUsable(pairing)) {
    // 过期配对按配置目标的共享循环或原有来源补采；正常请求继续无 token。
    // 过期旧配对已删除，取得的新配对按当前凭据/有效期/端点重检后才返回
    const source = pairingSources.get(model)
    pairings.delete(model)
    clearRefreshTimer(model)
    const targets = getConfiguredTargetModels()
    if (targets.includes(model) && !probeSchedulerStopped) {
      consola.info(`[auto-session] expired model=${model} re-probe`)
      const acquired = await acquireConfiguredTarget(model, endpoint)
      if (acquired !== undefined) {
        consola.info(
          `[auto-session] ${colorAutoSessionEvent("hit")} model=${model}`,
        )
        return acquired
      }
    } else if (source !== undefined && !probeSchedulerStopped) {
      consola.info(`[auto-session] expired model=${model} re-probe`)
      void runProbePoint(source.tier, source.kind, source.prompt)
    } else {
      consola.info(
        `[auto-session] ${colorAutoSessionEvent("miss")} model=${model}`,
      )
    }
    return undefined
  }

  if (endpoint !== undefined && !pairingSupportsEndpoint(pairing, endpoint)) {
    consola.info(
      `[auto-session] ${colorAutoSessionEvent("miss")} model=${model} endpoint=${endpoint}`,
    )
    return undefined
  }

  consola.info(`[auto-session] ${colorAutoSessionEvent("hit")} model=${model}`)
  return pairing.sessionToken
}
