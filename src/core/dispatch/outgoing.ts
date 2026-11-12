import { AsyncLocalStorage } from 'node:async_hooks'
import type { Logger } from 'pino'
import type { BeforeSend, Delivery, OutgoingMessage } from '../adapter.ts'
import type { SendResult } from '../bot.ts'
import { SendBlockedError } from '../errors.ts'
import type { Message } from '../message/index.ts'

interface Hook {
  plugin: string
  priority: number
  handler: BeforeSend
}

export class OutgoingHooks {
  private readonly hooks: Hook[] = []
  private readonly inHook = new AsyncLocalStorage<boolean>()
  private readonly logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  add(plugin: string, handler: BeforeSend, priority: number): () => void {
    const hook = { plugin, handler, priority }
    this.hooks.push(hook)
    return () => {
      const index = this.hooks.indexOf(hook)
      if (index !== -1) this.hooks.splice(index, 1)
    }
  }

  async prepare(input: OutgoingMessage): Promise<Message | Delivery> {
    if (this.inHook.getStore()) return input.message
    let message = input.message
    for (const hook of [...this.hooks].sort((a, b) => b.priority - a.priority)) {
      if (!this.hooks.includes(hook)) continue
      let timer: NodeJS.Timeout | undefined
      let blocked = false
      let timedOut = false
      const timeout = Symbol('timeout')
      try {
        const inputMessage: Message = message.map((segment) => ({ ...segment, data: { ...segment.data } }))
        const work = this.inHook.run(true, () =>
          Promise.resolve().then(() => hook.handler({ ...input, message: inputMessage })),
        )
        void work.catch((error: unknown) => {
          if (timedOut) this.logger.error({ err: error, plugin: hook.plugin }, 'Before-send hook failed')
        })
        const result = await Promise.race([
          work,
          new Promise<typeof timeout>((resolve) => {
            timer = setTimeout(() => resolve(timeout), 3_000)
          }),
        ])
        if (result === timeout) {
          timedOut = true
          this.logger.warn({ plugin: hook.plugin }, 'Before-send hook timed out')
        } else if (result === false) blocked = true
        else if (result !== undefined) {
          if (!Array.isArray(result)) return result
          message = result
        }
      } catch (error) {
        this.logger.error({ err: error, plugin: hook.plugin }, 'Before-send hook failed')
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (blocked) throw new SendBlockedError(hook.plugin)
    }
    return message
  }

  /** Runs a hook's delivery; its own sends skip the hooks (they already decided) like any send made inside a hook. */
  deliver(delivery: Delivery): Promise<SendResult> {
    return this.inHook.run(true, () => delivery.deliver())
  }
}
