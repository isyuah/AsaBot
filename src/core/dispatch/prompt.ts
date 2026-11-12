import type { PromptOptions, Session } from '../event/index.ts'
import type { Sendable } from '../message/index.ts'
import { parseDuration } from '../utils/duration.ts'
import { scheduleTimeout } from './timer.ts'

interface Waiter {
  key: string
  channel: string
  user?: string
  filter?: (session: Session) => boolean
  finish(session: Session | null): void
  fail(error: unknown): void
}

export class PromptManager {
  private readonly waiters = new Map<string, Waiter>()
  private readonly defaultTimeout: number
  private readonly maxTimeout: number
  private readonly bind: (session: Session, signal: AbortSignal) => Session

  constructor(
    defaultTimeout: number,
    maxTimeout: number,
    bind: (session: Session, signal: AbortSignal) => Session,
  ) {
    this.defaultTimeout = defaultTimeout
    this.maxTimeout = maxTimeout
    this.bind = bind
  }

  prompt(
    session: Session,
    text: Sendable | undefined,
    signal: AbortSignal,
    options: PromptOptions = {},
  ): Promise<Session | null> {
    if (signal.aborted) return Promise.reject(signal.reason)
    const timeout = Math.min(
      options.timeout === undefined ? this.defaultTimeout : parseDuration(options.timeout),
      this.maxTimeout,
    )
    const user = options.scope === 'channel' ? undefined : session.userId
    const key = JSON.stringify([session.channelKey, options.scope ?? 'user', user])
    this.waiters.get(key)?.finish(null)

    return new Promise<Session | null>((resolve, reject) => {
      let settled = false
      let cancelTimer: () => void
      const cleanup = (): boolean => {
        if (settled) return false
        settled = true
        cancelTimer()
        signal.removeEventListener('abort', onAbort)
        if (this.waiters.get(key) === waiter) this.waiters.delete(key)
        return true
      }
      const onAbort = (): void => {
        if (cleanup()) reject(signal.reason)
      }
      const waiter: Waiter = {
        key,
        channel: session.channelKey,
        ...(user === undefined ? {} : { user }),
        ...(options.filter === undefined ? {} : { filter: options.filter }),
        finish: (answer) => {
          if (cleanup()) resolve(answer === null ? null : this.bind(answer, signal))
        },
        fail: (error) => {
          if (cleanup()) reject(error)
        },
      }
      cancelTimer = scheduleTimeout(timeout, () => waiter.finish(null))
      this.waiters.set(key, waiter)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      if (text !== undefined) void session.send(text).catch((error: unknown) => waiter.fail(error))
    })
  }

  consume(session: Session): boolean {
    // A user-scoped prompt is more specific than a channel-scoped one, so it gets the message first.
    const candidates = [...this.waiters.values()]
      .filter(
        (waiter) =>
          waiter.channel === session.channelKey &&
          (waiter.user === undefined || waiter.user === session.userId),
      )
      .sort((a, b) => Number(b.user !== undefined) - Number(a.user !== undefined))
    for (const waiter of candidates) {
      try {
        if (waiter.filter !== undefined && !waiter.filter(session)) continue
      } catch (error) {
        waiter.fail(error)
        continue
      }
      waiter.finish(session)
      return true
    }
    return false
  }
}
