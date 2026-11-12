import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { Logger } from 'pino'
import type { Services } from '../../index.ts'
import type { BeforeSend } from '../adapter.ts'
import type { App } from '../app.ts'
import type { Bot, SendResult } from '../bot.ts'
import type { CommandBuilder } from '../command/builder.ts'
import type { ApiInterceptor } from '../dispatch/api.ts'
import {
  type DispatchEvent,
  type Disposer,
  groupKeyOf,
  type MatchHandler,
  type MatchPattern,
  type Middleware,
  type Scope,
} from '../dispatch/types.ts'
import { NoBotOnlineError, PluginError } from '../errors.ts'
import type {
  AnyEvent,
  EventMap,
  KnownEventMap,
  MetaEvent,
  PlatformNoticeEvent,
  RequestEvent,
} from '../event/index.ts'
import type { Sendable } from '../message/index.ts'
import { Scheduler } from '../scheduler.ts'
import type { KVStore } from '../storage/index.ts'
import { type Target, targetSchema } from '../target.ts'
import { type Duration, parseDuration } from '../utils/duration.ts'
import { type PluginDefinition, serviceDependencies } from './definition.ts'
import { PersistentTasks, type TaskHandle, type TaskHandler } from './tasks.ts'
import type { PluginStateEvent } from './types.ts'

type Listener = (event: AnyEvent | PluginStateEvent, signal: AbortSignal) => unknown | Promise<unknown>
type PublicListener = Listener | ((event: never, signal: AbortSignal) => unknown | Promise<unknown>)
type Cleanup = () => void | Promise<void>
export type FilteredContext = Pick<Context, 'on' | 'middleware' | 'command' | 'match' | 'filter' | 'platform'>

export class Context<Config = undefined> {
  private readonly app: App
  private readonly owner: string
  private readonly value: Config
  private readonly childLogger: Logger
  private readonly controller = new AbortController()
  private readonly scope: Scope
  private readonly scheduler: Scheduler
  private readonly kv: KVStore
  private readonly tasks: PersistentTasks
  private readonly cleanups: Cleanup[] = []
  private readonly dependencies: ReturnType<typeof serviceDependencies>
  private routeApp?: Hono
  private disposed = false

  constructor(app: App, name: string, config: Config, dependencies?: PluginDefinition['inject']) {
    this.app = app
    this.owner = name
    this.value = config
    this.dependencies = serviceDependencies(dependencies)
    this.childLogger = app.logger.child({ plugin: name })
    this.scope = { owner: name, signal: this.controller.signal }
    this.scheduler = new Scheduler(this.childLogger, this.controller.signal, app.config.timezone)
    this.kv = app.storage.store(name, () => this.assertActive())
    this.tasks = new PersistentTasks(
      app.storage,
      name,
      this.controller.signal,
      this.childLogger,
      app.tasks,
      () => this.assertActive(),
    )
  }

  get name(): string {
    this.assertActive()
    return this.owner
  }
  get config(): Readonly<Config> {
    this.assertActive()
    return this.value
  }
  configFor(target: string | { platform: string; groupId?: string }): Readonly<Config> {
    this.assertActive()
    const key = typeof target === 'string' ? target : groupKeyOf(target)
    return key === undefined ? this.value : (this.app.plugins.configFor(this.owner, key) as Readonly<Config>)
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

  send(target: Target | string, content: Sendable): Promise<SendResult> {
    this.assertActive()
    return this.app.send(target, content)
  }

  async broadcast(
    targets: (Target | string)[],
    content: Sendable,
    options: { interval?: Duration } = {},
  ): Promise<{ target: Target; result?: SendResult; error?: Error }[]> {
    this.assertActive()
    const destinations = targets.map((target) => targetSchema.parse(target))
    const interval = parseDuration(options.interval ?? 0)
    const results: { target: Target; result?: SendResult; error?: Error }[] = []
    for (const [index, target] of destinations.entries()) {
      if (index > 0 && interval > 0) await new Promise<void>((resolve) => setTimeout(resolve, interval))
      try {
        results.push({ target, result: await this.send(target, content) })
      } catch (error) {
        results.push({ target, error: error instanceof Error ? error : new Error(String(error)) })
      }
    }
    return results
  }

  migrate(steps: string[]): void {
    this.assertActive()
    this.app.storage.migrate(this.owner, steps)
  }

  provide<K extends string>(name: K, service: K extends keyof Services ? Services[K] : unknown): Disposer {
    this.assertActive()
    const dispose = this.app.plugins.provide(this.owner, name, service)
    this.controller.signal.addEventListener('abort', dispose, { once: true })
    return () => {
      this.controller.signal.removeEventListener('abort', dispose)
      dispose()
    }
  }

  inject<K extends string>(name: K): K extends keyof Services ? Services[K] : unknown {
    this.assertActive()
    if (!this.dependencies.required.includes(name))
      throw new PluginError(`插件 "${this.owner}" 未声明服务 ${name}`)
    return this.app.plugins.inject(name) as K extends keyof Services ? Services[K] : unknown
  }

  injectOptional<K extends string>(name: K): (K extends keyof Services ? Services[K] : unknown) | undefined {
    this.assertActive()
    if (!this.dependencies.optional.includes(name))
      throw new PluginError(`插件 "${this.owner}" 未声明可选服务 ${name}`)
    return this.app.plugins.injectOptional(name) as
      | (K extends keyof Services ? Services[K] : unknown)
      | undefined
  }

  on<K extends keyof KnownEventMap>(
    name: K,
    listener: (event: EventMap[K], signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  on(
    name: 'plugin.state',
    listener: (event: PluginStateEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  on(
    name: `notice.${string}`,
    listener: (event: PlatformNoticeEvent, signal: AbortSignal) => unknown | Promise<unknown>,
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
  beforeSend(fn: BeforeSend, options: { priority?: number } = {}): Disposer {
    this.assertActive()
    const dispose = this.app.outgoing.add(this.owner, fn, options.priority ?? 0)
    this.controller.signal.addEventListener('abort', dispose, { once: true })
    return () => {
      this.controller.signal.removeEventListener('abort', dispose)
      dispose()
    }
  }
  interceptApi(fn: ApiInterceptor, options: { priority?: number } = {}): Disposer {
    this.assertActive()
    const dispose = this.app.apiInterceptors.add(fn, options.priority ?? 0)
    this.controller.signal.addEventListener('abort', dispose, { once: true })
    return () => {
      this.controller.signal.removeEventListener('abort', dispose)
      dispose()
    }
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
  filter(predicate: (event: DispatchEvent) => boolean): FilteredContext {
    this.assertActive()
    return this.filtered({ ...this.scope, filter: predicate })
  }
  platform(...names: string[]): FilteredContext {
    return this.filter((event) => names.includes(event.platform))
  }
  private filtered(scope: Scope): FilteredContext {
    return {
      on: ((name: string, listener: Listener) => {
        this.assertActive()
        return this.app.dispatcher.on(scope, name, listener)
      }) as Context['on'],
      middleware: (handler, options) => {
        this.assertActive()
        return this.app.dispatcher.middleware(scope, handler, options)
      },
      command: (declaration) => {
        this.assertActive()
        return this.app.dispatcher.command(scope, declaration)
      },
      match: (pattern, handler, options) => {
        this.assertActive()
        return this.app.dispatcher.match(scope, pattern, handler, options)
      },
      filter: (predicate) => {
        this.assertActive()
        return this.filtered({
          ...scope,
          filter: (event) => (scope.filter?.(event) ?? true) && predicate(event),
        })
      },
      platform: (...names) => {
        this.assertActive()
        return this.filtered({
          ...scope,
          filter: (event) => (scope.filter?.(event) ?? true) && names.includes(event.platform),
        })
      },
    }
  }
  route(register: (app: Hono) => void): void {
    this.assertActive()
    if (!this.routeApp) {
      this.routeApp = new Hono()
      const remove = this.app.setPluginRoute(this.owner, this.routeApp)
      this.controller.signal.addEventListener('abort', remove, { once: true })
    }
    register(this.routeApp)
  }
  cron(
    expression: string,
    fn: (signal: AbortSignal) => unknown | Promise<unknown>,
    options?: { timezone?: string },
  ): Disposer {
    this.assertActive()
    return this.scheduler.cron(expression, fn, options)
  }
  interval(duration: string | number, fn: (signal: AbortSignal) => unknown | Promise<unknown>): Disposer {
    this.assertActive()
    return this.scheduler.interval(duration, fn)
  }
  timeout(duration: string | number, fn: (signal: AbortSignal) => unknown | Promise<unknown>): Disposer {
    this.assertActive()
    return this.scheduler.timeout(duration, fn)
  }
  task<T>(name: string, handler: TaskHandler<T>): TaskHandle<T> {
    this.assertActive()
    return this.tasks.register(name, handler)
  }

  warnUnregisteredTasks(): void {
    this.tasks.warnUnregistered()
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
    if (this.disposed || this.controller.signal.aborted)
      throw new PluginError(`Plugin "${this.owner}" context has been disposed`)
  }
}
