export class ActivityTracker {
  private active = 0
  private readonly waiters = new Set<() => void>()
  private scheduled = false

  begin(parent?: Activity): Activity {
    this.active++
    return new Activity(this, parent)
  }

  change(delta: number): void {
    this.active += delta
    if (this.active !== 0 || this.scheduled || this.waiters.size === 0) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      if (this.active !== 0) return
      for (const resolve of this.waiters) resolve()
      this.waiters.clear()
    })
  }

  whenIdle(): Promise<void> {
    if (this.active === 0) return Promise.resolve()
    return new Promise((resolve) => {
      this.waiters.add(resolve)
      this.change(0)
    })
  }
}

export class Activity {
  private readonly tracker: ActivityTracker
  private readonly parent?: Activity
  private readonly inactiveWaiters = new Set<() => void>()
  private suspended = false
  private finished = false

  constructor(tracker: ActivityTracker, parent?: Activity) {
    this.tracker = tracker
    this.parent = parent
  }
  pause(): void {
    if (this.finished || this.suspended) return
    this.suspended = true
    this.tracker.change(-1)
    this.resolveInactive()
  }
  resume(): void {
    if (this.finished || !this.suspended) return
    this.suspended = false
    this.tracker.change(1)
  }
  finish(): void {
    if (this.finished) return
    this.finished = true
    if (!this.suspended) this.tracker.change(-1)
    this.resolveInactive()
  }

  whenInactive(): Promise<void> {
    if (this.finished || this.suspended) return Promise.resolve()
    return new Promise((resolve) => this.inactiveWaiters.add(resolve))
  }

  async whenBranchInactive(): Promise<void> {
    await this.whenInactive()
    await this.parent?.whenBranchInactive()
  }

  private resolveInactive(): void {
    for (const resolve of this.inactiveWaiters) resolve()
    this.inactiveWaiters.clear()
  }
}

// A prompt can be created before the handler actually starts waiting for it.
export function trackPrompt<T>(promise: Promise<T>, onWait: () => void): Promise<T> {
  return new Proxy(promise, {
    get(target, key) {
      if (key === 'then' || key === 'catch' || key === 'finally') {
        onWait()
        return target[key].bind(target)
      }
      return Reflect.get(target, key, target)
    },
  })
}
