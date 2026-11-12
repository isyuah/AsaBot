import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from './scheduler.ts'

afterEach(() => vi.useRealTimers())

describe('scheduler timezone and cancellation', () => {
  it('runs cron in the configured or overridden timezone and aborts task signals', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:59:59Z'))
    const controller = new AbortController()
    const scheduler = new Scheduler(pino({ level: 'silent' }), controller.signal, 'Asia/Shanghai')
    const signals = new Map<string, AbortSignal>()
    let intervalRuns = 0
    scheduler.cron('0 9 * * *', (signal) => {
      signals.set('configured', signal)
    })
    scheduler.cron(
      '0 1 * * *',
      (signal) => {
        signals.set('override', signal)
      },
      { timezone: 'UTC' },
    )
    scheduler.timeout(500, (signal) => {
      signals.set('timeout', signal)
    })
    scheduler.interval(500, (signal) => {
      signals.set('interval', signal)
      intervalRuns++
    })
    await vi.advanceTimersByTimeAsync(1500)
    expect([...signals.keys()].sort()).toEqual(['configured', 'interval', 'override', 'timeout'])
    expect([...signals.values()].every((signal) => signal === controller.signal)).toBe(true)
    controller.abort()
    expect([...signals.values()].every((signal) => signal.aborted)).toBe(true)
    const before = intervalRuns
    await vi.advanceTimersByTimeAsync(60_000)
    expect(intervalRuns).toBe(before)
  })
})
