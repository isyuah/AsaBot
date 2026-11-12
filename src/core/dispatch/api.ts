import { AsyncLocalStorage } from 'node:async_hooks'
import { type Bot, botActions } from '../bot.ts'
import { UnsupportedError } from '../errors.ts'

export interface ApiCall {
  bot: Bot
  method: string
  args: unknown[]
}

export type ApiInterceptor = (call: ApiCall, next: () => Promise<unknown>) => Promise<unknown>

interface Interceptor {
  handler: ApiInterceptor
  priority: number
}

export class ApiInterceptors {
  private readonly interceptors: Interceptor[] = []
  private readonly inInterceptor = new AsyncLocalStorage<boolean>()
  private readonly wrapped = new WeakSet<Bot>()

  add(handler: ApiInterceptor, priority: number): () => void {
    const interceptor = { handler, priority }
    this.interceptors.push(interceptor)
    return () => {
      const index = this.interceptors.indexOf(interceptor)
      if (index !== -1) this.interceptors.splice(index, 1)
    }
  }

  wrap(bot: Bot): void {
    if (this.wrapped.has(bot)) return
    this.wrapped.add(bot)
    for (const method of botActions) {
      const original = bot[method]
      Object.defineProperty(bot, method, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) =>
          this.invoke({ bot, method, args }, (actualArgs) => {
            if (!bot.capabilities.actions.includes(method)) throw new UnsupportedError(bot.platform, method)
            return Reflect.apply(original, bot, actualArgs)
          }),
      })
    }
  }

  async invoke(call: ApiCall, execute: (args: unknown[]) => Promise<unknown>): Promise<unknown> {
    if (this.inInterceptor.getStore()) return execute(call.args)
    const interceptors = [...this.interceptors].sort((a, b) => b.priority - a.priority)
    const dispatch = (index: number): Promise<unknown> => {
      const interceptor = interceptors[index]
      if (!interceptor) return execute(call.args)
      if (!this.interceptors.includes(interceptor)) return dispatch(index + 1)
      return interceptor.handler(call, () => dispatch(index + 1))
    }
    return this.inInterceptor.run(true, () => dispatch(0))
  }
}
