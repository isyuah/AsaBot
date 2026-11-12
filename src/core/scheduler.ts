import { Cron } from 'croner'
import type { Logger } from 'pino'
import { scheduleTimeout } from './dispatch/timer.ts'
import type { Disposer } from './dispatch/types.ts'
import { parseDuration } from './utils/duration.ts'

export class Scheduler {
  private readonly logger: Logger
  private readonly signal: AbortSignal

  constructor(logger: Logger, signal: AbortSignal) {
    this.logger = logger
    this.signal = signal
  }

  cron(expression: string, fn: () => unknown | Promise<unknown>): Disposer {
    let job: Cron
    try {
      job = new Cron(expression, { protect: true, unref: true }, this.wrap(fn))
    } catch (error) {
      throw new Error(
        `Invalid cron expression "${expression}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    return this.track(() => job.stop())
  }

  interval(duration: string | number, fn: () => unknown | Promise<unknown>): Disposer {
    const delay = parseDuration(duration)
    if (delay <= 0 || delay > 2_147_483_647) throw new Error(`Invalid interval: ${duration}`)
    const task = this.wrap(fn)
    const timer = setInterval(() => void task(), delay)
    timer.unref()
    return this.track(() => clearInterval(timer))
  }

  timeout(duration: string | number, fn: () => unknown | Promise<unknown>): Disposer {
    const task = this.wrap(fn)
    const cancel = scheduleTimeout(parseDuration(duration), () => void task(), true)
    return this.track(cancel)
  }

  private wrap(fn: () => unknown | Promise<unknown>): () => Promise<void> {
    let running = false
    return async () => {
      if (running || this.signal.aborted) return
      running = true
      try {
        await fn()
      } catch (error) {
        this.logger.error({ err: error }, 'Scheduled task failed')
      } finally {
        running = false
      }
    }
  }

  private track(stop: Disposer): Disposer {
    let active = true
    const dispose = (): void => {
      if (!active) return
      active = false
      this.signal.removeEventListener('abort', dispose)
      stop()
    }
    this.signal.addEventListener('abort', dispose, { once: true })
    if (this.signal.aborted) dispose()
    return dispose
  }
}
