import type { AddressInfo } from 'node:net'
import type { Hono } from 'hono'
import type { Logger } from 'pino'
import type { Adapter, AdapterHost } from './adapter.ts'
import { type Bot, BotRegistry } from './bot.ts'
import type { Config } from './config/schema.ts'
import { Dispatcher } from './dispatch/dispatcher.ts'
import { MessageStats } from './dispatch/stats.ts'
import type { DispatchEvent } from './dispatch/types.ts'
import type {
  AnyEvent,
  EventMap,
  MetaEvent,
  NoticeEvent,
  RequestEvent,
  Session,
  SessionServices,
} from './event/index.ts'
import { logger as defaultLogger } from './logger.ts'
import { PluginManager } from './plugin/manager.ts'
import type { PluginStateEvent } from './plugin/types.ts'
import { Storage } from './storage/index.ts'

type AppState = 'created' | 'running' | 'stopped'
export interface ServerService {
  start(): Promise<void>
  stop(): Promise<void>
  address(): AddressInfo | null
}
export interface BotConnectionInfo {
  connection: 'forward' | 'reverse'
  url?: string
}
type Listener = (event: DispatchEvent) => unknown | Promise<unknown>
type PublicListener =
  | Listener
  | ((event: Session) => unknown | Promise<unknown>)
  | ((event: NoticeEvent) => unknown | Promise<unknown>)
  | ((event: RequestEvent) => unknown | Promise<unknown>)
  | ((event: MetaEvent) => unknown | Promise<unknown>)
  | ((event: PluginStateEvent) => unknown | Promise<unknown>)

class CoreEvents {
  private readonly dispatcher: Dispatcher
  constructor(dispatcher: Dispatcher) {
    this.dispatcher = dispatcher
  }

  on<K extends keyof EventMap>(
    name: K,
    listener: (event: EventMap[K]) => unknown | Promise<unknown>,
  ): () => void
  on(name: 'plugin.state', listener: (event: PluginStateEvent) => unknown | Promise<unknown>): () => void
  on(name: `notice.${string}`, listener: (event: NoticeEvent) => unknown | Promise<unknown>): () => void
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
  readonly sessionServices: SessionServices
  readonly events: CoreEvents
  readonly bots = new BotRegistry()
  readonly storage: Storage
  readonly plugins: PluginManager
  readonly stats = new MessageStats()
  readonly startedAt = Date.now()
  server?: ServerService
  private readonly adapters: Adapter[] = []
  private readonly botConnections = new WeakMap<Bot, BotConnectionInfo>()
  private readonly routes = new Map<string, Hono>()
  private readonly dispatchSubscribers = new Set<(event: DispatchEvent) => void>()
  private readonly shutdown = new AbortController()
  private state: AppState = 'created'

  constructor(config: Config, logger: Logger = defaultLogger, options: { configPath?: string } = {}) {
    this.config = config
    this.logger = logger
    this.dispatcher = new Dispatcher(config, logger, this.shutdown.signal)
    this.sessionServices = this.dispatcher
    this.events = new CoreEvents(this.dispatcher)
    this.storage = new Storage(config.dataDir, logger)
    this.plugins = new PluginManager(this, options.configPath)
    this.dispatcher.accessFilter = (event) => this.storage.allows(event)
    this.dispatcher.isEnabledFor = (owner, event) => this.plugins.isEnabledFor(owner, event)
    this.dispatcher.onDispatch = (event) => {
      if (event.platform !== 'playground') {
        if (event.kind === 'message') this.stats.record('received')
        else if (event.name === 'bot.message.sent') this.stats.record('sent')
      }
      for (const subscriber of this.dispatchSubscribers) {
        try {
          subscriber(event)
        } catch {
          this.logger.error('Dispatch subscriber failed')
        }
      }
    }
  }

  useServer(server: ServerService): void {
    if (this.state !== 'created' || this.server) throw new Error('Server must be configured before start')
    this.server = server
  }

  subscribeDispatch(subscriber: (event: DispatchEvent) => void): () => void {
    this.dispatchSubscribers.add(subscriber)
    return () => this.dispatchSubscribers.delete(subscriber)
  }

  setBotConnection(bot: Bot, info: BotConnectionInfo): void {
    this.botConnections.set(bot, info)
  }

  getBotConnection(bot: Bot): BotConnectionInfo | undefined {
    return this.botConnections.get(bot)
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
      await this.server?.start()
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
    await this.server?.stop()
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
    for (const bot of this.bots.list()) {
      this.unregisterBot(bot)
    }
    this.storage.close()
    this.logger.info('AsaBot stopped')
  }
}
