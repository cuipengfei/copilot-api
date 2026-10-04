import { describe, expect, test } from 'bun:test'
import { formatCacheHitRate } from '../src/lib/token-usage-format'

describe('token usage cache hit rate', () => {
  test.each([
    [200, 600, 200, '60.0%'],
    [200, 0, 100, '0.0%'],
    [0, 500, 0, '100.0%'],
    [2, 1, 0, '33.3%'],
    [0, 0, 100, '0.0%'],
    [0, 0, 0, '—'],
  ] as const)(
    'formats input=%d, cache read=%d, cache write=%d as %s',
    (inputTokens, cacheRead, cacheWrite, expected) => {
      expect(
        formatCacheHitRate({
          input_tokens: inputTokens,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheWrite,
        }),
      ).toBe(expected)
    },
  )
})
