import type { Logger } from 'pino'
import type { Adapter, AdapterHost } from './adapter.ts'
import { type Bot, BotRegistry } from './bot.ts'
import type { Config } from './config/schema.ts'
import { Dispatcher } from './dispatch/dispatcher.ts'
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

type AppState = 'created' | 'running' | 'stopped'
type Listener = (event: AnyEvent) => unknown | Promise<unknown>
type PublicListener =
  | Listener
  | ((event: Session) => unknown | Promise<unknown>)
  | ((event: NoticeEvent) => unknown | Promise<unknown>)
  | ((event: RequestEvent) => unknown | Promise<unknown>)
  | ((event: MetaEvent) => unknown | Promise<unknown>)

class CoreEvents {
  private readonly dispatcher: Dispatcher
  constructor(dispatcher: Dispatcher) {
    this.dispatcher = dispatcher
  }

  on<K extends keyof EventMap>(
    name: K,
    listener: (event: EventMap[K]) => unknown | Promise<unknown>,
  ): () => void
  on(name: `notice.${string}`, listener: (event: NoticeEvent) => unknown | Promise<unknown>): () => void
  on(name: `request.${string}`, listener: (event: RequestEvent) => unknown | Promise<unknown>): () => void
  on(name: `meta.${string}`, listener: (event: MetaEvent) => unknown | Promise<unknown>): () => void
  on(name: string, listener: Listener): () => void
  on(name: string, listener: PublicListener): () => void {
    return this.dispatcher.on({ owner: 'core' }, name, listener as Listener)
  }

  emit(event: AnyEvent): Promise<void> {
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
  private readonly adapters: Adapter[] = []
  private readonly shutdown = new AbortController()
  private state: AppState = 'created'

  constructor(config: Config, logger: Logger = defaultLogger) {
    this.config = config
    this.logger = logger
    this.dispatcher = new Dispatcher(config, logger, this.shutdown.signal)
    this.sessionServices = this.dispatcher
    this.events = new CoreEvents(this.dispatcher)
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
    void this.dispatcher.dispatch(event).catch((error: unknown) => {
      this.logger.error({ err: error, event: event.name, eventId: event.id }, 'Event dispatch failed')
    })
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

    this.state = 'running'
    for (const adapter of this.adapters) {
      try {
        await adapter.start()
      } catch (error) {
        this.logger.error({ err: error, platform: adapter.platform }, 'Failed to start adapter')
      }
    }
    this.logger.info({ dataDir: this.config.dataDir }, 'AsaBot started')
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') {
      return
    }

    this.state = 'stopped'
    this.shutdown.abort(new DOMException('App stopped', 'AbortError'))
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
    this.logger.info('AsaBot stopped')
  }
}
