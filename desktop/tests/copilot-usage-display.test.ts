import { describe, expect, test } from 'bun:test'
import {
  getCopilotQuotaPercentRemaining,
  getCopilotQuotaRemaining,
  getPremiumUsedText,
  hasCopilotQuotaValue,
} from '../src/lib/copilot-usage-display'

describe('Copilot quota display', () => {
  test('uses the upstream percentage and remaining count', () => {
    const quota = {
      entitlement: 1500,
      remaining: 1499,
      quota_remaining: 0,
      percent_remaining: 99.9,
      unlimited: false,
    }
    expect(getCopilotQuotaRemaining(quota)).toBe(1499)
    expect(getCopilotQuotaPercentRemaining(quota)).toBe(99.9)
    expect(getPremiumUsedText(quota)).toBe('1 / 1500')
    expect(hasCopilotQuotaValue(quota)).toBe(true)
    expect(getCopilotQuotaPercentRemaining({ ...quota, remaining: 1200 })).toBe(
      99.9,
    )
  })

  test('supports zero remaining and legacy quota_remaining payloads', () => {
    expect(
      getCopilotQuotaRemaining({ remaining: 0, quota_remaining: 1499 }),
    ).toBe(0)
    expect(getCopilotQuotaRemaining({ quota_remaining: 1499 })).toBe(1499)
    expect(
      getPremiumUsedText({ entitlement: 1500, quota_remaining: 1499 }),
    ).toBe('1 / 1500')
    expect(
      getCopilotQuotaPercentRemaining({
        entitlement: 1500,
        quota_remaining: 1499,
      }),
    ).toBeCloseTo(99.933333)
    expect(
      getCopilotQuotaPercentRemaining({ entitlement: 0, remaining: 0 }),
    ).toBe(100)
  })

  test('handles unlimited, invalid fields and percentages outside the bar range', () => {
    expect(
      getCopilotQuotaPercentRemaining({
        unlimited: true,
        percent_remaining: 0,
      }),
    ).toBe(100)
    expect(getPremiumUsedText({ unlimited: true })).toBe('∞')
    expect(getCopilotQuotaPercentRemaining({ percent_remaining: -10 })).toBe(0)
    expect(getCopilotQuotaPercentRemaining({ percent_remaining: 110 })).toBe(
      100,
    )
    expect(
      getCopilotQuotaPercentRemaining({
        percent_remaining: NaN,
        entitlement: 1500,
        remaining: 1499,
      }),
    ).toBeCloseTo(99.933333)
    expect(
      getCopilotQuotaRemaining({ remaining: NaN, quota_remaining: 5 }),
    ).toBe(5)
    expect(getCopilotQuotaRemaining(null)).toBeNull()
    expect(getCopilotQuotaRemaining(undefined)).toBeNull()
    expect(getCopilotQuotaRemaining({ remaining: Infinity })).toBeNull()
    expect(hasCopilotQuotaValue({ entitlement: 1500 })).toBe(false)
    expect(getPremiumUsedText(undefined)).toBeNull()
  })
})
