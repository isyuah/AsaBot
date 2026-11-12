import { scheduleTimeout } from './dispatch/timer.ts'
import type { Session } from './event/index.ts'

/** 命令冷却按用户、群或全局计算的范围。 */
export type CooldownScope = 'user' | 'group' | 'global'

interface Entry {
  expires: number
  notified: boolean
}

interface Bucket {
  values: Map<string, Entry>
  deadline?: number
  cancelTimer?: () => void
}

export class RateLimiter {
  private readonly entries = new Map<object, Bucket>()

  check(
    command: object,
    session: Session,
    duration: number,
    scope: CooldownScope,
  ): { remaining: number; notify: boolean } | null {
    if (session.isSuperuser || duration === 0) return null
    const key =
      scope === 'user' ? `${session.platform}:${session.userId}` : scope === 'group' ? session.channelKey : ''
    let bucket = this.entries.get(command)
    if (bucket === undefined) {
      bucket = { values: new Map() }
      this.entries.set(command, bucket)
    }
    const now = Date.now()
    const entry = bucket.values.get(key)
    if (entry === undefined || entry.expires <= now) {
      const expires = now + duration
      bucket.values.set(key, { expires, notified: false })
      this.schedule(command, bucket, expires, now)
      return null
    }
    const notify = !entry.notified
    entry.notified = true
    return { remaining: entry.expires - now, notify }
  }

  delete(command: object): void {
    this.entries.get(command)?.cancelTimer?.()
    this.entries.delete(command)
  }

  private schedule(command: object, bucket: Bucket, deadline: number, now: number): void {
    if (bucket.deadline !== undefined && bucket.deadline <= deadline) return
    bucket.cancelTimer?.()
    bucket.deadline = deadline
    bucket.cancelTimer = scheduleTimeout(
      Math.max(0, deadline - now),
      () => {
        bucket.deadline = undefined
        bucket.cancelTimer = undefined
        const current = Date.now()
        let next = Infinity
        for (const [key, entry] of bucket.values) {
          if (entry.expires <= current) bucket.values.delete(key)
          else next = Math.min(next, entry.expires)
        }
        if (bucket.values.size === 0) this.entries.delete(command)
        else this.schedule(command, bucket, next, current)
      },
      true,
    )
  }
}
