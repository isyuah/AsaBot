import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import type { Logger } from 'pino'
import type { Services } from '../../index.ts'
import type { BeforeSend } from '../adapter.ts'
import type { App } from '../app.ts'
import type { Bot, SendResult } from '../bot.ts'
import type { CommandBuilder } from '../command/builder.ts'
import type { ApiInterceptor } from '../dispatch/api.ts'
import { dispatchContext } from '../dispatch/trace.ts'
import type {
  DispatchEvent,
  Disposer,
  MatchHandler,
  MatchPattern,
  Middleware,
  Scope,
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
import type { BotIdentity } from '../identity.ts'
import type { Sendable } from '../message/index.ts'
import { Scheduler } from '../scheduler.ts'
import type { KVStore } from '../storage/index.ts'
import { type Target, targetSchema } from '../target.ts'
import { type Duration, parseDuration } from '../utils/duration.ts'
import { type PluginDefinition, serviceDependencies } from './definition.ts'
import { pluginExecution } from './execution.ts'
import { PersistentTasks, type TaskHandle, type TaskHandler, type TaskRegistrationOptions } from './tasks.ts'
import type { PanelPageOptions, PluginStateEvent, ServiceConsumer } from './types.ts'

type Listener = (event: AnyEvent | PluginStateEvent, signal: AbortSignal) => unknown | Promise<unknown>
type PublicListener = Listener | ((event: never, signal: AbortSignal) => unknown | Promise<unknown>)
type Cleanup = () => void | Promise<void>
/** 按事件过滤的上下文，可继续注册处理器或叠加过滤条件。 */
export type FilteredContext = Pick<Context, 'on' | 'middleware' | 'command' | 'match' | 'filter' | 'platform'>

/** 插件的配置、服务和资源入口；卸载后访问其 API 会抛出 PluginError。 */
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
  private readonly consumer: ServiceConsumer
  private routeApp?: Hono
  private panelRouteApp?: Hono
  private disposed = false

  /** 注册插件面板页面、认证接口和实时事件；资源随插件卸载回收。 */
  readonly panel = {
    /** 注册一个静态面板页面，返回移除函数；同一插件重复注册页面时抛错。页面文件可以公开访问。 */
    page: (options: PanelPageOptions): Disposer => {
      this.assertActive()
      const remove = this.app.setPanelPage(this.owner, {
        title: options.title,
        ...(options.icon === undefined ? {} : { icon: options.icon }),
        root: options.root instanceof URL ? fileURLToPath(options.root) : options.root,
        entry: options.entry ?? 'index.html',
      })
      this.controller.signal.addEventListener('abort', remove, { once: true })
      return () => {
        this.controller.signal.removeEventListener('abort', remove)
        remove()
      }
    },
    /** 注册需要面板登录的 Hono 路由，挂载在 /api/panel/ext/<插件名>/。 */
    route: (register: (app: Hono) => void): void => {
      this.assertActive()
      if (!this.panelRouteApp) {
        this.panelRouteApp = new Hono()
        const remove = this.app.setPanelRoute(this.owner, this.panelRouteApp)
        this.controller.signal.addEventListener('abort', remove, { once: true })
      }
      register(this.panelRouteApp)
    },
    /** 向已连接的面板推送指定主题和数据。 */
    push: (topic: string, data: unknown): void => {
      this.assertActive()
      this.app.pushPanelEvent(this.owner, topic, data)
    },
  }

  /** 由框架为插件创建上下文；dependencies 声明允许注入的服务。 */
  constructor(app: App, name: string, config: Config, dependencies?: PluginDefinition['inject']) {
    this.app = app
    this.owner = name
    this.value = config
    this.dependencies = serviceDependencies(dependencies)
    this.consumer = Object.freeze({
      plugin: name,
      signal: this.controller.signal,
      event() {
        const current = dispatchContext.getStore()
        if (current?.plugin !== name || !current.active.value) return undefined
        const { eventId, platform, selfId } = current.trace
        return { eventId, platform, selfId }
      },
    })
    this.childLogger = app.logger.child({ plugin: name })
    this.scope = { owner: name, signal: this.controller.signal }
    this.scheduler = new Scheduler(this.childLogger, this.controller.signal, app.config.timezone)
    this.kv = app.storage.store(name, () => this.assertActive())
    this.tasks = new PersistentTasks(app.tasks, name, this.controller.signal, () => this.assertActive())
  }

  /** 当前插件的唯一名称。 */
  get name(): string {
    this.assertActive()
    return this.owner
  }
  /** 经过插件 schema 校验的全局配置。 */
  get config(): Readonly<Config> {
    this.assertActive()
    return this.value
  }
  /** 获取目标机器人或群组合并覆盖项后的有效配置。 */
  configFor(target: string | (BotIdentity & { groupId?: string })): Readonly<Config> {
    this.assertActive()
    return this.app.plugins.configFor(this.owner, target) as Readonly<Config>
  }
  /** 自动附带插件名的日志记录器。 */
  get logger(): Logger {
    this.assertActive()
    return this.childLogger
  }
  /** 插件卸载时中止的信号，可传给异步任务。 */
  get signal(): AbortSignal {
    this.assertActive()
    return this.controller.signal
  }
  /** 当前插件独立命名空间的键值存储。 */
  get store(): KVStore {
    this.assertActive()
    return this.kv
  }
  /** 共享 SQLite 连接；表结构应通过 migrate 管理。 */
  get db(): DatabaseSync {
    this.assertActive()
    return this.app.storage.db
  }
  /** 当前注册的机器人列表，包括离线实例。 */
  get bots(): Bot[] {
    this.assertActive()
    return this.app.bots.list().filter((bot) => this.app.plugins.isEnabledOnBot(this.owner, bot))
  }
  /** 创建并返回当前插件的数据目录；文件系统操作失败时抛错。 */
  get dataDir(): string {
    this.assertActive()
    const path = join(this.app.config.dataDir, 'plugins', this.owner)
    mkdirSync(path, { recursive: true })
    return path
  }

  /** 按账号 ID 查找在线机器人，省略时取第一个；找不到时抛出 NoBotOnlineError。 */
  bot(identity?: BotIdentity): Bot {
    this.assertActive()
    const bot = this.app.bots
      .list()
      .find(
        (item) =>
          item.status === 'online' &&
          this.app.plugins.isEnabledOnBot(this.owner, item) &&
          (identity === undefined ||
            (item.selfId === identity.selfId && item.platform === identity.platform)),
      )
    if (!bot) throw new NoBotOnlineError()
    return bot
  }

  /** 向指定目标发送内容；目标无效、无在线机器人或发送失败时拒绝。 */
  send(target: Target | string, content: Sendable): Promise<SendResult> {
    this.assertActive()
    return pluginExecution.run(this.owner, () => this.app.send(target, content))
  }

  /** 顺序向多个目标发送，interval 是发送间隔；单个发送失败写入对应结果的 error。 */
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

  /** 按顺序执行尚未执行的 SQL 迁移；迁移失败时回滚并抛错。 */
  migrate(steps: string[]): void {
    this.assertActive()
    this.app.storage.migrate(this.owner, steps)
  }

  /** 按名称提供插件服务并返回撤销函数；同名服务已存在时抛错。 */
  provide<K extends string>(name: K, service: K extends keyof Services ? Services[K] : unknown): Disposer {
    this.assertActive()
    return this.disposeService(this.app.plugins.provide(this.owner, name, service))
  }

  /** 提供按使用方上下文创建的服务，服务可获取插件身份和卸载信号。 */
  provideScoped<K extends string>(
    name: K,
    factory: (consumer: ServiceConsumer) => K extends keyof Services ? Services[K] : unknown,
  ): Disposer {
    this.assertActive()
    return this.disposeService(this.app.plugins.provideScoped(this.owner, name, factory))
  }

  /** 列出声明依赖指定服务的已发现插件，包括未启用的插件。 */
  serviceConsumers(name: string): string[] {
    this.assertActive()
    return this.app.plugins.serviceConsumers(name)
  }

  private disposeService(dispose: Disposer): Disposer {
    this.controller.signal.addEventListener('abort', dispose, { once: true })
    return () => {
      this.controller.signal.removeEventListener('abort', dispose)
      dispose()
    }
  }

  /** 获取已声明的必需服务；未声明或服务不可用时抛出 PluginError。 */
  inject<K extends string>(name: K): K extends keyof Services ? Services[K] : unknown {
    this.assertActive()
    if (!this.dependencies.required.includes(name))
      throw new PluginError(`插件 "${this.owner}" 未声明服务 ${name}`)
    return this.app.plugins.inject(name, this.consumer) as K extends keyof Services ? Services[K] : unknown
  }

  /** 获取已声明的可选服务；服务缺失返回 undefined，未声明时抛出 PluginError。 */
  injectOptional<K extends string>(name: K): (K extends keyof Services ? Services[K] : unknown) | undefined {
    this.assertActive()
    if (!this.dependencies.optional.includes(name))
      throw new PluginError(`插件 "${this.owner}" 未声明可选服务 ${name}`)
    return this.app.plugins.injectOptional(name, this.consumer) as
      | (K extends keyof Services ? Services[K] : unknown)
      | undefined
  }

  /** 监听分层事件并返回移除函数；事件名可订阅其子事件。 */
  on<K extends keyof KnownEventMap>(
    name: K,
    listener: (event: EventMap[K], signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  /** 监听插件状态变化并返回移除函数。 */
  on(
    name: 'plugin.state',
    listener: (event: PluginStateEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  /** 监听平台通知并返回移除函数。 */
  on(
    name: `notice.${string}`,
    listener: (event: PlatformNoticeEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  /** 监听请求事件并返回移除函数。 */
  on(
    name: `request.${string}`,
    listener: (event: RequestEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  /** 监听元事件并返回移除函数。 */
  on(
    name: `meta.${string}`,
    listener: (event: MetaEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  /** 监听指定名称的事件并返回移除函数。 */
  on(name: string, listener: Listener): Disposer
  on(name: string, listener: PublicListener): Disposer {
    this.assertActive()
    return this.app.dispatcher.on(this.scope, name, listener as Listener)
  }

  /** 注册消息中间件并返回移除函数；优先级越高越先执行。 */
  middleware(fn: Middleware, options?: { priority?: number }): Disposer {
    this.assertActive()
    return this.app.dispatcher.middleware(this.scope, fn, options)
  }
  /** 注册发送前钩子；可修改、拦截或接管发送，返回移除函数。 */
  beforeSend(fn: BeforeSend, options: { priority?: number } = {}): Disposer {
    this.assertActive()
    const dispose = this.app.outgoing.add(this.owner, fn, options.priority ?? 0)
    this.controller.signal.addEventListener('abort', dispose, { once: true })
    return () => {
      this.controller.signal.removeEventListener('abort', dispose)
      dispose()
    }
  }
  /** 注册 Bot API 拦截器并返回移除函数；优先级越高越先执行。 */
  interceptApi(fn: ApiInterceptor, options: { priority?: number } = {}): Disposer {
    this.assertActive()
    const dispose = this.app.apiInterceptors.add(fn, options.priority ?? 0, this.owner)
    this.controller.signal.addEventListener('abort', dispose, { once: true })
    return () => {
      this.controller.signal.removeEventListener('abort', dispose)
      dispose()
    }
  }
  /** 根据声明注册命令并返回链式构建器；声明无效或命令冲突时抛错。 */
  command<const Decl extends string>(declaration: Decl): CommandBuilder<Decl> {
    this.assertActive()
    return this.app.dispatcher.command(this.scope, declaration)
  }
  /** 注册消息匹配器，支持字符串、正则和函数；返回移除函数。 */
  match(
    pattern: MatchPattern,
    handler: MatchHandler,
    options?: { priority?: number; block?: boolean },
  ): Disposer {
    this.assertActive()
    return this.app.dispatcher.match(this.scope, pattern, handler, options)
  }
  /** 创建过滤上下文，之后注册的处理器只接收符合条件的事件。 */
  filter(predicate: (event: DispatchEvent) => boolean): FilteredContext {
    this.assertActive()
    return this.filtered({ ...this.scope, filter: predicate })
  }
  /** 创建只处理指定平台事件的过滤上下文。 */
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
  /** 注册挂载在 /plugins/<插件名>/ 的 Hono 路由；插件卸载时移除。 */
  route(register: (app: Hono) => void): void {
    this.assertActive()
    if (!this.routeApp) {
      this.routeApp = new Hono()
      const remove = this.app.setPluginRoute(this.owner, this.routeApp)
      this.controller.signal.addEventListener('abort', remove, { once: true })
    }
    register(this.routeApp)
  }
  /** 注册 cron 定时任务并返回停止函数；表达式或时区无效时抛错。 */
  cron(
    expression: string,
    fn: (signal: AbortSignal) => unknown | Promise<unknown>,
    options?: { timezone?: string },
  ): Disposer {
    this.assertActive()
    return this.scheduler.cron(
      expression,
      (signal) => pluginExecution.run(this.owner, () => fn(signal)),
      options,
    )
  }
  /** 注册固定间隔任务并返回停止函数；duration 是毫秒数或时长字符串。 */
  interval(duration: string | number, fn: (signal: AbortSignal) => unknown | Promise<unknown>): Disposer {
    this.assertActive()
    return this.scheduler.interval(duration, (signal) => pluginExecution.run(this.owner, () => fn(signal)))
  }
  /** 注册一次性延迟任务并返回停止函数；duration 是毫秒数或时长字符串。 */
  timeout(duration: string | number, fn: (signal: AbortSignal) => unknown | Promise<unknown>): Disposer {
    this.assertActive()
    return this.scheduler.timeout(duration, (signal) => pluginExecution.run(this.owner, () => fn(signal)))
  }
  /** 注册可持久化任务并恢复待执行项；同名任务重复注册时抛错。 */
  task<T>(name: string, handler: TaskHandler<T>, options?: TaskRegistrationOptions): TaskHandle<T> {
    this.assertActive()
    return this.tasks.register(name, handler, options)
  }

  /** 在插件 setup 成功后激活持久化任务。 */
  activateTasks(): void {
    this.tasks.activate()
  }
  /** 注册插件卸载时的清理函数，并返回取消注册函数。 */
  onDispose(fn: Cleanup): Disposer {
    this.assertActive()
    this.cleanups.push(fn)
    return () => {
      const index = this.cleanups.indexOf(fn)
      if (index !== -1) this.cleanups.splice(index, 1)
    }
  }

  /** 中止插件资源并逆序执行清理函数；重复调用无影响。 */
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
