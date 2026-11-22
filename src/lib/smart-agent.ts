import consola from "consola"

import { state } from "~/lib/state"
import type { SmartAgentDecision } from "~/lib/types/copilot-rate-limit"
import { getSmartAgentDecision } from "~/services/github/get-copilot-usage"

let lastQuotaLogTime = 0

export function resetQuotaLogThrottle(): void {
  lastQuotaLogTime = 0
}

export interface ResolveInitiatorResult {
  initiator: "agent" | "user"
  decision?: SmartAgentDecision
}

// Cache TTL: 3 minutes (only used when over budget)
const CACHE_TTL_MS = 180_000

/**
 * Update the smart agent cache in state.
 * Extracted to avoid require-atomic-updates lint warning.
 */
function updateSmartAgentCache(
  decision: SmartAgentDecision | null,
  timestamp: number,
): void {
  state.smartAgentDecision = decision
  state.smartAgentCacheTimestamp = timestamp
}

/**
 * Clear the smart agent decision cache.
 * Useful for testing or when forcing a fresh decision.
 */
export function clearSmartAgentCache(): void {
  updateSmartAgentCache(null, 0)
}

/**
 * Returns the UTC date key (YYYY-MM-DD) for cross-day comparison.
 *
 * Aligned with GitHub Copilot premium quota reset at UTC 00:00.
 */
function getUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Reset stale forceAgent state across UTC day boundaries.
 *
 * GitHub Copilot premium quota resets at UTC 00:00. If a previous protection
 * decision was made on a different UTC day, clear the stale state so hysteresis
 * cannot self-perpetuate across days. Without this, a process started yesterday
 * would carry yesterday's forceAgent=true into today, triggering hysteresis
 * against today's (smaller) `expected` and indefinitely maintaining protection.
 */
function resetStaleHysteresisIfCrossDay(
  cacheTimestamp: number,
  currentDate: Date,
): void {
  if (
    !state.smartAgentDecision?.forceAgent
    || cacheTimestamp <= 0
    || getUtcDateKey(new Date(cacheTimestamp)) === getUtcDateKey(currentDate)
  ) {
    return
  }
  consola.info(
    "[quota] Smart agent: cross-day (UTC) detected, clearing stale hysteresis state",
  )
  updateSmartAgentCache(null, 0)
}

/**
 * Get decision, using cache only when over budget (forceAgent=true).
 *
 * Caching strategy:
 * - Over budget (forceAgent=true): Cache the decision because once over budget,
 *   it will stay over budget for a long time. Reduces unnecessary API calls.
 * - On budget (forceAgent=false): Don't cache. Check every time to catch
 *   the exact moment when quota drops below expected.
 */
async function getDecisionWithSmartCache(
  now?: Date,
): Promise<SmartAgentDecision> {
  const currentDate = now ?? new Date()
  const currentTime = currentDate.getTime()
  const cacheTimestamp = state.smartAgentCacheTimestamp ?? 0

  resetStaleHysteresisIfCrossDay(cacheTimestamp, currentDate)

  // Only use cache if:
  // 1. Cache exists
  // 2. Cache is not expired
  // 3. Cached decision was forceAgent=true (over budget)
  if (
    state.smartAgentDecision
    && currentTime - cacheTimestamp < CACHE_TTL_MS
    && state.smartAgentDecision.forceAgent
  ) {
    return state.smartAgentDecision
  }

  const decision = await getSmartAgentDecision(now)

  // Hysteresis: 如果之前在保护中，退出需要更大的 margin
  if (
    !decision.forceAgent
    && state.smartAgentDecision?.forceAgent
    && state.smartAgentDecision.reason !== "error"
    && decision.remaining !== undefined
    && decision.expected !== undefined
    && decision.idealDaily !== undefined
  ) {
    const exitThreshold = decision.expected + decision.idealDaily
    if (decision.remaining <= exitThreshold) {
      // remaining 不够多，维持保护
      consola.debug(
        `[quota] Smart agent: hysteresis active — remaining ${decision.remaining} <= expected ${decision.expected} + margin ${Math.round(decision.idealDaily)} = ${Math.round(exitThreshold)}, maintaining protection`,
      )
      const hysteresisDecision: SmartAgentDecision = {
        ...decision,
        forceAgent: true,
        reason: "hysteresis",
      }
      updateSmartAgentCache(hysteresisDecision, currentTime)
      return hysteresisDecision
    }
    // remaining 足够多，真正退出保护
    consola.warn(
      `[quota] Smart agent: protection DISABLED — remaining ${decision.remaining} > expected ${decision.expected} + margin ${Math.round(decision.idealDaily)} = ${Math.round(exitThreshold)}`,
    )
  }

  if (decision.forceAgent) {
    updateSmartAgentCache(decision, currentTime)
  } else {
    updateSmartAgentCache(null, 0)
  }

  return decision
}

/**
 * Resolve the initiator value based on smart agent decision.
 *
 * When state.forceAgent is true:
 * - If over budget (remaining < expected), force "agent" mode
 * - If on budget, keep the defaultInitiator
 * - On API failure, default to "agent" (protect user quota)
 *
 * When state.forceAgent is false:
 * - Return defaultInitiator without making API calls
 *
 * @param defaultInitiator - The initiator to use when not forcing agent or on budget
 * @param now - Optional Date for testing (defaults to current time)
 * @returns The resolved initiator and optional decision details
 */
export async function resolveInitiatorWithSmartAgent(
  defaultInitiator: "agent" | "user",
  now?: Date,
): Promise<ResolveInitiatorResult> {
  // When forceAgent is false, skip API call entirely
  if (!state.forceAgent) {
    return { initiator: defaultInitiator }
  }

  const decision = await getDecisionWithSmartCache(now)

  if (decision.forceAgent) {
    // Over budget or API failure: force agent mode
    if (decision.error) {
      consola.warn(
        `[quota] Smart agent: API error, defaulting to agent mode - ${decision.error}`,
      )
    } else {
      const quotaMessage =
        (
          decision.reason === "hysteresis"
          && decision.expected !== undefined
          && decision.idealDaily !== undefined
        ) ?
          `[quota] Smart agent: hysteresis — remaining ${decision.remaining} <= expected ${decision.expected} + margin ${Math.round(decision.idealDaily)} = ${Math.round(decision.expected + decision.idealDaily)}, maintaining agent mode`
        : `[quota] Smart agent: remaining ${decision.remaining} <= expected ${decision.expected} → using agent mode`
      const nowMs = Date.now()

      if (nowMs - lastQuotaLogTime >= 300_000) {
        consola.info(quotaMessage)
        lastQuotaLogTime = nowMs
      } else {
        consola.debug(quotaMessage)
      }
    }
    return { initiator: "agent", decision }
  }

  // On budget: keep existing logic
  consola.debug(
    `[quota] remaining ${decision.remaining} >= expected ${decision.expected} → using existing logic`,
  )
  return { initiator: defaultInitiator, decision }
}

export { type SmartAgentDecision } from "~/lib/types/copilot-rate-limit"
