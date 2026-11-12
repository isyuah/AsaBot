import type { Logger } from 'pino'
import type { Adapter, AdapterHost } from './adapter.ts'
import { type Bot, BotRegistry } from './bot.ts'
import type { Config } from './config/schema.ts'
import type { AnyEvent, EventMap, MetaEvent, NoticeEvent, RequestEvent, Session } from './event/index.ts'
import { logger as defaultLogger } from './logger.ts'

type AppState = 'created' | 'running' | 'stopped'
type EventListener = (event: AnyEvent) => unknown | Promise<unknown>
type PublicEventListener =
  | EventListener
  | ((event: Session) => unknown | Promise<unknown>)
  | ((event: NoticeEvent) => unknown | Promise<unknown>)
  | ((event: RequestEvent) => unknown | Promise<unknown>)
  | ((event: MetaEvent) => unknown | Promise<unknown>)

export class EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>()
  private readonly logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  on<K extends keyof EventMap>(
    name: K,
    listener: (event: EventMap[K]) => unknown | Promise<unknown>,
  ): () => void
  on(name: `notice.${string}`, listener: (event: NoticeEvent) => unknown | Promise<unknown>): () => void
  on(name: `request.${string}`, listener: (event: RequestEvent) => unknown | Promise<unknown>): () => void
  on(name: `meta.${string}`, listener: (event: MetaEvent) => unknown | Promise<unknown>): () => void
  on(name: string, listener: EventListener): () => void
  on(name: string, listener: PublicEventListener): () => void {
    const entries = this.listeners.get(name) ?? new Set<EventListener>()
    entries.add(listener as EventListener)
    this.listeners.set(name, entries)
    return () => {
      entries.delete(listener as EventListener)
      if (entries.size === 0 && this.listeners.get(name) === entries) {
        this.listeners.delete(name)
      }
    }
  }

  async emit(event: AnyEvent): Promise<void> {
    const names: string[] = []
    const parts = event.name.split('.')
    for (let index = 1; index <= parts.length; index += 1) {
      names.push(parts.slice(0, index).join('.'))
    }
    const listeners = names.flatMap((name) => [...(this.listeners.get(name) ?? [])])
    const results = await Promise.allSettled(
      listeners.map((listener) => Promise.resolve().then(() => listener(event))),
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(
          { err: result.reason, event: event.name, eventId: event.id },
          'Event listener failed',
        )
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}

export class App implements AdapterHost {
  readonly config: Config
  readonly logger: Logger
  readonly events: EventBus
  readonly bots = new BotRegistry()
  private readonly adapters: Adapter[] = []
  private state: AppState = 'created'

  constructor(config: Config, logger: Logger = defaultLogger) {
    this.config = config
    this.logger = logger
    this.events = new EventBus(logger)
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
    void this.events.emit(event)
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
    if (this.state !== 'running') {
      return
    }

    this.state = 'stopped'
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
    this.events.clear()
    this.logger.info('AsaBot stopped')
  }
}
