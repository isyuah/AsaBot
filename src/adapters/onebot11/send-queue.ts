import type { Logger } from 'pino'
import { NotConnectedError, SendQueueFullError } from '../../core/errors.ts'

interface QueuedSend {
  send: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

export class SendQueue {
  private readonly pending: QueuedSend[] = []
  private readonly settings: { interval: number; jitter: number; maxPending: number }
  private readonly logger: Logger
  private readonly selfId: string
  private nextSendAt = 0
  private timer: NodeJS.Timeout | undefined

  constructor(
    settings: { interval: number; jitter: number; maxPending: number },
    logger: Logger,
    selfId: string,
  ) {
    this.settings = settings
    this.logger = logger
    this.selfId = selfId
  }

  send(send: () => Promise<unknown>): Promise<unknown> {
    if (this.settings.interval === 0) return send()
    if (this.pending.length === 0 && performance.now() >= this.nextSendAt) return this.execute(send)
    if (this.pending.length >= this.settings.maxPending) {
      this.logger.warn(
        { selfId: this.selfId, maxPending: this.settings.maxPending },
        'OneBot send queue full',
      )
      return Promise.reject(new SendQueueFullError())
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ send, resolve, reject })
      this.schedule()
    })
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const item of this.pending.splice(0)) item.reject(new NotConnectedError())
  }

  private execute(send: () => Promise<unknown>): Promise<unknown> {
    const result = send()
    this.nextSendAt = performance.now() + this.settings.interval + Math.random() * this.settings.jitter
    return result
  }

  private schedule(): void {
    if (this.timer !== undefined || this.pending.length === 0) return
    const delay = Math.min(2_147_483_647, Math.max(0, Math.ceil(this.nextSendAt - performance.now())))
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (performance.now() < this.nextSendAt) {
        this.schedule()
        return
      }
      const item = this.pending.shift()
      if (item !== undefined) {
        this.execute(item.send).then(item.resolve, item.reject)
        this.schedule()
      }
    }, delay)
  }
}
