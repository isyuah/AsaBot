import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Logger } from 'pino'
import type { App } from '../app.ts'
import type { Bot } from '../bot.ts'
import type { CommandBuilder } from '../command/builder.ts'
import type { Disposer, MatchHandler, MatchPattern, Middleware, Scope } from '../dispatch/types.ts'
import { NoBotOnlineError, PluginError } from '../errors.ts'
import type { AnyEvent, EventMap, MetaEvent, NoticeEvent, RequestEvent } from '../event/index.ts'
import { Scheduler } from '../scheduler.ts'
import type { KVStore } from '../storage/index.ts'
import type { PluginStateEvent } from './types.ts'

type Listener = (event: AnyEvent | PluginStateEvent, signal: AbortSignal) => unknown | Promise<unknown>
type PublicListener = Listener | ((event: never, signal: AbortSignal) => unknown | Promise<unknown>)
type Cleanup = () => void | Promise<void>

export class Context<Config = undefined> {
  private readonly app: App
  private readonly owner: string
  private readonly value: Config
  private readonly childLogger: Logger
  private readonly controller = new AbortController()
  private readonly scope: Scope
  private readonly scheduler: Scheduler
  private readonly kv: KVStore
  private readonly cleanups: Cleanup[] = []
  private disposed = false

  constructor(app: App, name: string, config: Config) {
    this.app = app
    this.owner = name
    this.value = config
    this.childLogger = app.logger.child({ plugin: name })
    this.scope = { owner: name, signal: this.controller.signal }
    this.scheduler = new Scheduler(this.childLogger, this.controller.signal)
    this.kv = app.storage.store(name, () => this.assertActive())
  }

  get name(): string {
    this.assertActive()
    return this.owner
  }
  get config(): Readonly<Config> {
    this.assertActive()
    return this.value
  }
  get logger(): Logger {
    this.assertActive()
    return this.childLogger
  }
  get signal(): AbortSignal {
    this.assertActive()
    return this.controller.signal
  }
  get store(): KVStore {
    this.assertActive()
    return this.kv
  }
  get db(): DatabaseSync {
    this.assertActive()
    return this.app.storage.db
  }
  get bots(): Bot[] {
    this.assertActive()
    return this.app.bots.list()
  }
  get dataDir(): string {
    this.assertActive()
    const path = join(this.app.config.dataDir, 'plugins', this.owner)
    mkdirSync(path, { recursive: true })
    return path
  }

  bot(selfId?: string): Bot {
    this.assertActive()
    const bot = this.app.bots
      .list()
      .find((item) => item.status === 'online' && (selfId === undefined || item.selfId === selfId))
    if (!bot) throw new NoBotOnlineError()
    return bot
  }

  migrate(steps: string[]): void {
    this.assertActive()
    this.app.storage.migrate(this.owner, steps)
  }

  on<K extends keyof EventMap>(
    name: K,
    listener: (event: EventMap[K], signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  on(
    name: 'plugin.state',
    listener: (event: PluginStateEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  on(
    name: `notice.${string}`,
    listener: (event: NoticeEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  on(
    name: `request.${string}`,
    listener: (event: RequestEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  on(
    name: `meta.${string}`,
    listener: (event: MetaEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  on(name: string, listener: Listener): Disposer
  on(name: string, listener: PublicListener): Disposer {
    this.assertActive()
    return this.app.dispatcher.on(this.scope, name, listener as Listener)
  }

  middleware(fn: Middleware, options?: { priority?: number }): Disposer {
    this.assertActive()
    return this.app.dispatcher.middleware(this.scope, fn, options)
  }
  command<const Decl extends string>(declaration: Decl): CommandBuilder<Decl> {
    this.assertActive()
    return this.app.dispatcher.command(this.scope, declaration)
  }
  match(
    pattern: MatchPattern,
    handler: MatchHandler,
    options?: { priority?: number; block?: boolean },
  ): Disposer {
    this.assertActive()
    return this.app.dispatcher.match(this.scope, pattern, handler, options)
  }
  cron(expression: string, fn: () => unknown | Promise<unknown>): Disposer {
    this.assertActive()
    return this.scheduler.cron(expression, fn)
  }
  interval(duration: string | number, fn: () => unknown | Promise<unknown>): Disposer {
    this.assertActive()
    return this.scheduler.interval(duration, fn)
  }
  timeout(duration: string | number, fn: () => unknown | Promise<unknown>): Disposer {
    this.assertActive()
    return this.scheduler.timeout(duration, fn)
  }
  onDispose(fn: Cleanup): Disposer {
    this.assertActive()
    this.cleanups.push(fn)
    return () => {
      const index = this.cleanups.indexOf(fn)
      if (index !== -1) this.cleanups.splice(index, 1)
    }
  }

  async dispose(): Promise<void> {
    if (this.controller.signal.aborted) return
    this.controller.abort(new DOMException(`Plugin ${this.owner} unloaded`, 'AbortError'))
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        await cleanup()
      } catch (error) {
        this.childLogger.error({ err: error }, 'Plugin cleanup failed')
      }
    }
    this.disposed = true
  }

  private assertActive(): void {
    if (this.disposed) throw new PluginError(`Plugin "${this.owner}" context has been disposed`)
  }
}
