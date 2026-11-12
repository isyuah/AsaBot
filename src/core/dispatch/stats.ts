export interface StatsPoint {
  t: number
  received: number
  sent: number
}

const minute = 60_000
const retention = 24 * 60 * minute

function localDayStart(now: number): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export class MessageStats {
  private readonly buckets = new Map<number, StatsPoint>()
  private daily: StatsPoint = { t: Number.NaN, received: 0, sent: 0 }

  record(direction: 'received' | 'sent', now = Date.now()): void {
    this.prune(now)
    const t = Math.floor(now / minute) * minute
    let point = this.buckets.get(t)
    if (!point) {
      point = { t, received: 0, sent: 0 }
      this.buckets.set(t, point)
    }
    point[direction]++
    const day = localDayStart(now)
    if (this.daily.t !== day) this.daily = { t: day, received: 0, sent: 0 }
    this.daily[direction]++
  }

  point(t: number): StatsPoint {
    const start = Math.floor(t / minute) * minute
    return { ...(this.buckets.get(start) ?? { t: start, received: 0, sent: 0 }) }
  }

  range(range: '1h' | '24h', now = Date.now()): StatsPoint[] {
    this.prune(now)
    const interval = range === '1h' ? minute : 15 * minute
    const count = range === '1h' ? 60 : 96
    const current = Math.floor(now / interval) * interval
    return Array.from({ length: count }, (_, index) => {
      const t = current - (count - 1 - index) * interval
      const point: StatsPoint = { t, received: 0, sent: 0 }
      for (let offset = 0; offset < interval; offset += minute) {
        const bucket = this.buckets.get(t + offset)
        if (bucket) {
          point.received += bucket.received
          point.sent += bucket.sent
        }
      }
      return point
    })
  }

  today(now = Date.now()): { received: number; sent: number } {
    return this.daily.t === localDayStart(now)
      ? { received: this.daily.received, sent: this.daily.sent }
      : { received: 0, sent: 0 }
  }

  private prune(now: number): void {
    const earliest = Math.floor((now - retention) / minute) * minute
    for (const t of this.buckets.keys()) if (t < earliest) this.buckets.delete(t)
  }
}
