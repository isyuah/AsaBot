import type { AddressInfo } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import type { Hono } from 'hono'
import type { Logger } from 'pino'
import type { Adapter, AdapterHost, BotInfo, OutgoingMessage, UpgradeHandler } from './adapter.ts'
import { type Bot, BotRegistry } from './bot.ts'
import type { Config } from './config/schema.ts'
import { Dispatcher } from './dispatch/dispatcher.ts'
import { OutgoingHooks } from './dispatch/outgoing.ts'
import { MessageStats } from './dispatch/stats.ts'
import type { DispatchEvent } from './dispatch/types.ts'
import type {
  AnyEvent,
  EventMap,
  KnownEventMap,
  MetaEvent,
  NoticeEvent,
  PlatformNoticeEvent,
  RequestEvent,
  Session,
  SessionServices,
} from './event/index.ts'
import { logger as defaultLogger } from './logger.ts'
import type { Message } from './message/index.ts'
import { PluginManager } from './plugin/manager.ts'
import type { PackageOptions } from './plugin/packages.ts'
import { TaskCoordinator } from './plugin/tasks.ts'
import type { PluginStateEvent } from './plugin/types.ts'
import { Storage } from './storage/index.ts'

type AppState = 'created' | 'running' | 'stopped'
export interface ServerService {
  start(): Promise<void>
  stop(): Promise<void>
  address(): AddressInfo | null
}
type Listener = (event: DispatchEvent) => unknown | Promise<unknown>
type PublicListener =
  | Listener
  | ((event: Session) => unknown | Promise<unknown>)
  | ((event: NoticeEvent) => unknown | Promise<unknown>)
  | ((event: PlatformNoticeEvent) => unknown | Promise<unknown>)
  | ((event: RequestEvent) => unknown | Promise<unknown>)
  | ((event: MetaEvent) => unknown | Promise<unknown>)
  | ((event: PluginStateEvent) => unknown | Promise<unknown>)

class CoreEvents {
  private readonly dispatcher: Dispatcher
  constructor(dispatcher: Dispatcher) {
    this.dispatcher = dispatcher
  }

  on<K extends keyof KnownEventMap>(
    name: K,
    listener: (event: EventMap[K]) => unknown | Promise<unknown>,
  ): () => void
  on(name: 'plugin.state', listener: (event: PluginStateEvent) => unknown | Promise<unknown>): () => void
  on(
    name: `notice.${string}`,
    listener: (event: PlatformNoticeEvent) => unknown | Promise<unknown>,
  ): () => void
  on(name: `request.${string}`, listener: (event: RequestEvent) => unknown | Promise<unknown>): () => void
  on(name: `meta.${string}`, listener: (event: MetaEvent) => unknown | Promise<unknown>): () => void
  on(name: string, listener: Listener): () => void
  on(name: string, listener: PublicListener): () => void {
    return this.dispatcher.on({ owner: 'core' }, name, listener as Listener)
  }

  emit(event: DispatchEvent): Promise<void> {
    return this.dispatcher.dispatch(event)
  }
}

export class App implements AdapterHost {
  readonly config: Config
  readonly logger: Logger
  readonly dispatcher: Dispatcher
  readonly outgoing: OutgoingHooks
  readonly tasks = new TaskCoordinator()
  readonly sessionServices: SessionServices
  readonly events: CoreEvents
  readonly bots = new BotRegistry()
  readonly storage: Storage
  readonly plugins: PluginManager
  readonly stats: MessageStats
  readonly startedAt = Date.now()
  readonly configPath?: string
  setupCode?: string
  server?: ServerService
  private serverFactory?: () => ServerService
  private serverStarting?: Promise<void>
  private readonly adapters: Adapter[] = []
  private readonly managedAdapters = new Map<string, { adapter: Adapter; config: unknown }>()
  private adapterFactory?: (platform: string, config: unknown) => Adapter
  private readonly botInfo = new WeakMap<Bot, BotInfo>()
  private readonly upgrades = new Map<string, UpgradeHandler>()
  private readonly untrackedBots = new WeakSet<Bot>()
  private readonly routes = new Map<string, Hono>()
  private readonly dispatchSubscribers = new Set<(event: DispatchEvent) => void>()
  private readonly shutdown = new AbortController()
  private state: AppState = 'created'

  constructor(
    config: Config,
    logger: Logger = defaultLogger,
    options: { configPath?: string; packages?: PackageOptions; setupCode?: string } = {},
  ) {
    this.config = config
    this.configPath = options.configPath
    this.setupCode = options.setupCode
    this.logger = logger
    this.stats = new MessageStats(config.timezone)
    this.dispatcher = new Dispatcher(config, logger, this.shutdown.signal)
    this.outgoing = new OutgoingHooks(logger)
    this.sessionServices = this.dispatcher
    this.events = new CoreEvents(this.dispatcher)
    this.storage = new Storage(config.dataDir, logger)
    this.plugins = new PluginManager(this, options.configPath, options.packages)
    this.dispatcher.accessFilter = (event) => this.storage.allows(event)
    this.dispatcher.isEnabledFor = (owner, event) => this.plugins.isEnabledFor(owner, event)
    this.dispatcher.onDispatch = (event) => {
      if (!event.bot || !this.untrackedBots.has(event.bot)) {
        if (event.kind === 'message') this.stats.record('received')
        else if (event.name === 'bot.message.sent') this.stats.record('sent')
      }
      for (const subscriber of this.dispatchSubscribers) {
        try {
          subscriber(event)
        } catch (error) {
          this.logger.error(
            { err: error, event: event.name, eventId: event.id },
            'Dispatch subscriber failed',
          )
        }
      }
    }
  }

  useServer(server: ServerService): void {
    if (this.state !== 'created' || this.server) throw new Error('Server must be configured before start')
    this.server = server
  }

  configureServer(factory: () => ServerService): void {
    if (this.state !== 'created' || this.serverFactory)
      throw new Error('Server must be configured before start')
    this.serverFactory = factory
  }

  private async startServerIfNeeded(): Promise<void> {
    if (
      !this.server &&
      this.serverFactory &&
      (this.hasUpgrades || this.config.server.panelPassword || this.config.server.apiToken || this.setupCode)
    ) {
      this.server = this.serverFactory()
    }
    if (this.server) {
      this.serverStarting ??= this.server.start()
      await this.serverStarting
    }
  }

  subscribeDispatch(subscriber: (event: DispatchEvent) => void): () => void {
    this.dispatchSubscribers.add(subscriber)
    return () => this.dispatchSubscribers.delete(subscriber)
  }

  get ignoreSelf(): boolean {
    return this.config.dispatch.ignoreSelf
  }

  setBotInfo(bot: Bot, info: BotInfo): void {
    this.botInfo.set(bot, info)
  }

  getBotInfo(bot: Bot): BotInfo | undefined {
    return this.botInfo.get(bot)
  }

  registerUpgrade(path: string, handler: UpgradeHandler): () => void {
    if (this.upgrades.has(path)) throw new Error(`WebSocket upgrade path already registered: ${path}`)
    this.upgrades.set(path, handler)
    if (this.state === 'running') {
      queueMicrotask(() => {
        if (this.state !== 'running') return
        void this.startServerIfNeeded().catch((error: unknown) => {
          this.logger.error({ err: error }, 'Failed to start HTTP server')
        })
      })
    }
    return () => {
      if (this.upgrades.get(path) === handler) this.upgrades.delete(path)
    }
  }

  getUpgrade(path: string): UpgradeHandler | undefined {
    return this.upgrades.get(path)
  }

  get hasUpgrades(): boolean {
    return this.upgrades.size > 0
  }

  excludeBotFromStats(bot: Bot): void {
    this.untrackedBots.add(bot)
  }

  setPluginRoute(name: string, route: Hono): () => void {
    this.routes.set(name, route)
    return () => {
      if (this.routes.get(name) === route) this.routes.delete(name)
    }
  }

  getPluginRoute(name: string): Hono | undefined {
    return this.routes.get(name)
  }

  useAdapter(adapter: Adapter): void {
    if (this.state === 'stopped') {
      throw new Error('Cannot add an adapter to a stopped App')
    }
    this.adapters.push(adapter)
    if (this.state === 'running') {
      void adapter.start().catch((error: unknown) => {
        this.logger.error({ err: error, platform: adapter.platform }, 'Failed to start adapter')
      })
    }
  }

  configureAdapters(factory: (platform: string, config: unknown) => Adapter): void {
    this.adapterFactory = factory
  }

  useConfiguredAdapter(adapter: Adapter, config: unknown): void {
    this.managedAdapters.set(adapter.platform, { adapter, config })
    this.useAdapter(adapter)
  }

  async reconfigureAdapters(next: Record<string, unknown>): Promise<void> {
    if (this.state === 'stopped') throw new Error('Cannot reconfigure a stopped App')
    for (const [platform, current] of this.managedAdapters) {
      if (!Object.hasOwn(next, platform)) {
        await current.adapter.stop()
        this.adapters.splice(this.adapters.indexOf(current.adapter), 1)
        this.managedAdapters.delete(platform)
      }
    }
    for (const [platform, config] of Object.entries(next)) {
      const current = this.managedAdapters.get(platform)
      if (current) {
        if (!isDeepStrictEqual(current.config, config)) {
          await current.adapter.reconfigure(config)
          current.config = config
        }
      } else {
        if (!this.adapterFactory) throw new Error('Adapter factory is not configured')
        const adapter = this.adapterFactory(platform, config)
        this.managedAdapters.set(platform, { adapter, config })
        this.adapters.push(adapter)
        if (this.state === 'running') await adapter.start()
      }
    }
    this.config.adapters = next
  }

  emit(event: AnyEvent): void {
    if (this.state === 'stopped') return
    void this.dispatcher.dispatch(event).catch((error: unknown) => {
      this.logger.error({ err: error, event: event.name, eventId: event.id }, 'Event dispatch failed')
    })
  }

  emitPluginState(event: PluginStateEvent): void {
    void this.dispatcher.dispatch(event).catch((error: unknown) => {
      this.logger.error({ err: error, event: event.name, eventId: event.id }, 'Event dispatch failed')
    })
  }

  whenIdle(): Promise<void> {
    return this.dispatcher.whenIdle()
  }

  prepareOutgoing(input: OutgoingMessage): Promise<Message> {
    return this.outgoing.prepare(input)
  }

  registerBot(bot: Bot): void {
    this.bots.register(bot)
  }

  unregisterBot(bot: Bot): void {
    this.bots.unregister(bot)
  }

  isSuperuser(userId: string): boolean {
    return this.config.superusers.includes(userId)
  }

  getBot(platform: string, selfId: string): Bot | undefined {
    return this.bots.get(platform, selfId)
  }

  get status(): AppState {
    return this.state
  }

  async start(): Promise<void> {
    if (this.state === 'running') {
      return
    }
    if (this.state === 'stopped') {
      throw new Error('A stopped App cannot be restarted')
    }

    this.storage.open()
    try {
      await this.plugins.start()
    } catch (error) {
      await this.plugins.stop()
      this.storage.close()
      throw error
    }
    this.state = 'running'
    for (const adapter of this.adapters) {
      try {
        await adapter.start()
      } catch (error) {
        this.logger.error({ err: error, platform: adapter.platform }, 'Failed to start adapter')
      }
    }
    try {
      await this.startServerIfNeeded()
      await this.plugins.watch()
    } catch (error) {
      await this.stop()
      throw error
    }
    this.logger.info({ dataDir: this.config.dataDir }, 'AsaBot started')
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') {
      return
    }

    this.state = 'stopped'
    await this.plugins.stopWatching()
    this.shutdown.abort(new DOMException('App stopped', 'AbortError'))
    await this.whenIdle()
    await this.plugins.stop()
    for (const adapter of this.adapters) {
      try {
        await adapter.stop()
      } catch (error) {
        this.logger.error({ err: error, platform: adapter.platform }, 'Failed to stop adapter')
      }
    }
    if (this.serverStarting) {
      try {
        await this.serverStarting
      } catch (error) {
        this.logger.debug({ err: error }, 'HTTP server startup failed before shutdown')
      }
    }
    await this.server?.stop()
    for (const bot of this.bots.list()) {
      this.unregisterBot(bot)
    }
    this.storage.close()
    this.logger.info('AsaBot stopped')
  }
}
