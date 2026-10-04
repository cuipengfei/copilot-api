export interface CopilotQuotaDetailLike {
  entitlement?: number
  remaining?: number
  quota_remaining?: number
  percent_remaining?: number
  unlimited?: boolean
}

export interface CopilotQuotaSnapshotsLike {
  chat?: CopilotQuotaDetailLike
  completions?: CopilotQuotaDetailLike
  premium_interactions?: CopilotQuotaDetailLike
}

export interface CopilotUsageDisplayLike {
  copilot_plan?: string
  quota_reset_date?: string
  quota_snapshots?: CopilotQuotaSnapshotsLike
}

const UNLIMITED_QUOTA_TEXT = '\u221e'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function getCopilotQuotaRemaining(
  quota: CopilotQuotaDetailLike | null | undefined,
): number | null {
  if (isFiniteNumber(quota?.remaining)) return quota.remaining
  if (isFiniteNumber(quota?.quota_remaining)) return quota.quota_remaining
  return null
}

export function getCopilotQuotaPercentRemaining(
  quota: CopilotQuotaDetailLike,
): number {
  if (quota.unlimited) return 100
  const percent =
    isFiniteNumber(quota.percent_remaining) ? quota.percent_remaining
    : isFiniteNumber(quota.entitlement) && quota.entitlement > 0 ?
      ((getCopilotQuotaRemaining(quota) ?? quota.entitlement)
        / quota.entitlement)
      * 100
    : 100
  return Math.max(0, Math.min(100, percent))
}

export function getNonEmptyUsageText(
  value: string | null | undefined,
): string | null {
  const text = value?.trim()
  return text ? text : null
}

export function hasCopilotQuotaValue(
  quota: CopilotQuotaDetailLike | null | undefined,
): quota is CopilotQuotaDetailLike {
  return Boolean(
    quota
    && (quota.unlimited === true
      || (isFiniteNumber(quota.entitlement)
        && getCopilotQuotaRemaining(quota) !== null)),
  )
}

export function getPremiumUsedText(
  quota: CopilotQuotaDetailLike | null | undefined,
): string | null {
  if (!hasCopilotQuotaValue(quota)) return null
  if (quota.unlimited) return UNLIMITED_QUOTA_TEXT

  const entitlement = quota.entitlement ?? 0
  const quotaRemaining = getCopilotQuotaRemaining(quota) ?? 0

  return `${Math.floor(entitlement - quotaRemaining)} / ${Math.floor(entitlement)}`
}

export function hasAnyCopilotQuotaSnapshot(
  snapshots: CopilotQuotaSnapshotsLike | null | undefined,
): boolean {
  return Boolean(
    snapshots
    && (hasCopilotQuotaValue(snapshots.premium_interactions)
      || hasCopilotQuotaValue(snapshots.chat)
      || hasCopilotQuotaValue(snapshots.completions)),
  )
}

export function shouldShowCopilotUsageSummary(
  usage: CopilotUsageDisplayLike | null | undefined,
): boolean {
  return Boolean(
    getNonEmptyUsageText(usage?.copilot_plan)
    || getPremiumUsedText(usage?.quota_snapshots?.premium_interactions)
    || getNonEmptyUsageText(usage?.quota_reset_date),
  )
}

export function shouldShowCopilotQuotaUsage(
  usage: CopilotUsageDisplayLike | null | undefined,
): boolean {
  return hasAnyCopilotQuotaSnapshot(usage?.quota_snapshots)
}
