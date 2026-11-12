import { describe, expect, it } from 'vitest'
import { parseDuration } from './duration.ts'

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['10s', 10_000],
    ['5m', 300_000],
    ['1h30m', 5_400_000],
    ['1d', 86_400_000],
    [250, 250],
  ])('parses %s as milliseconds', (input, expected) => {
    expect(parseDuration(input)).toBe(expected)
  })

  it.each(['', '10', '1s30', '1w', '-1s', 'NaN'])('rejects %s', (input) => {
    expect(() => parseDuration(input)).toThrow(/Invalid duration/)
  })

  it('rejects negative and non-finite numeric values', () => {
    expect(() => parseDuration(-1)).toThrow(/Invalid duration/)
    expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow(/Invalid duration/)
  })
})
