import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Adapter, AdapterDefinition, AdapterHost } from './adapter.ts'
import type { App } from './app.ts'
import type { Bot } from './bot.ts'
import { ConfigError } from './errors.ts'
import { botIdentitySchema, botKey } from './identity.ts'
import { redactSchemaText } from './utils/redact.ts'

export const connectionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().trim().min(1).max(120),
    adapter: z.string().min(1),
    enabled: z.boolean().default(true),
    config: z.unknown(),
  })
  .strict()
export type ConnectionConfig = z.output<typeof connectionSchema>
export interface ConnectionState {
  id: string
  name: string
  adapter: string
  platform: string
  enabled: boolean
  state: 'disabled' | 'connecting' | 'waiting' | 'online' | 'retrying' | 'error' | 'offline' | 'reauthorize'
  changedAt: number
  lastConnectedAt?: number
  lastError?: string
  errorAt?: number
  nextRetryAt?: number
  endpoints: string[]
  bots: { platform: string; selfId: string }[]
}
interface Entry {
  config: ConnectionConfig
  state: ConnectionState
  adapter?: Adapter
  bots: Map<string, Bot>
  generation: number
}

/** 一条持久连接对应一个独立驱动实例；监听连接可登记多台机器人。 */
export class Connections {
  private readonly app: App
  private readonly definitions = new Map<string, { definition: AdapterDefinition; source: string }>()
  private readonly entries = new Map<string, Entry>()
  private readonly subscribers = new Set<() => void>()
  private running = false

  constructor(app: App) {
    this.app = app
  }

  register(definition: AdapterDefinition, source: string): void {
    if (this.definitions.has(definition.id)) throw new ConfigError(`Duplicate adapter "${definition.id}"`)
    this.definitions.set(definition.id, { definition, source })
  }
  definition(id: string): AdapterDefinition {
    const item = this.definitions.get(id)
    if (!item) throw new ConfigError(`Unknown adapter "${id}"`)
    return item.definition
  }
  catalog() {
    return [...this.definitions.values()].map(({ definition, source }) => {
      const { create: _create, configSchema, setup, accountId: _accountId, ...metadata } = definition
      return {
        ...metadata,
        ...(setup && { setup: { kind: setup.kind } }),
        source,
        configSchema: setup
          ? { type: 'object' }
          : z.toJSONSchema(configSchema, { io: 'input', unrepresentable: 'any' }),
      }
    })
  }
  validate(configs: ConnectionConfig[]): ConnectionConfig[] {
    const ids = new Set<string>()
    const accounts = new Set<string>()
    return configs.map((config) => {
      if (ids.has(config.id)) throw new ConfigError(`Duplicate connection ID "${config.id}"`)
      ids.add(config.id)
      const definition = this.definition(config.adapter)
      const result = definition.configSchema.safeParse(config.config)
      if (!result.success)
        throw new ConfigError(`connections.${config.id}.config: ${this.error(config, result.error)}`)
      if (definition.accountId) {
        const selfId = definition.accountId(result.data)
        if (!botIdentitySchema.shape.selfId.safeParse(selfId).success)
          throw new ConfigError(`connections.${config.id}: invalid Bot ID`)
        const key = botKey({ platform: definition.platform, selfId })
        if (accounts.has(key))
          throw new ConfigError(`Bot ${definition.platform}:${selfId} 已绑定到另一条连接`)
        accounts.add(key)
      }
      return { ...config, config: result.data }
    })
  }
  list(): ConnectionState[] {
    return [...this.entries.values()].map((entry) => ({
      ...entry.state,
      endpoints: [...entry.state.endpoints],
      bots: [...entry.bots.values()].map(({ platform, selfId }) => ({ platform, selfId })),
    }))
  }
  knownBots(): Bot[] {
    return [...this.entries.values()].flatMap((entry) => [...entry.bots.values()])
  }
  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }
  private publish(): void {
    for (const listener of this.subscribers) {
      try {
        listener()
      } catch (error) {
        this.app.logger.error({ err: error }, 'Connection subscriber failed')
      }
    }
  }
  private error(config: ConnectionConfig, error: unknown): string {
    return redactSchemaText(
      error instanceof Error ? error.message : String(error),
      config.config,
      z.toJSONSchema(this.definition(config.adapter).configSchema, { io: 'input', unrepresentable: 'any' }),
    )
  }
  private update(entry: Entry, state: Partial<ConnectionState>): void {
    const changed = state.state !== undefined && state.state !== entry.state.state
    Object.assign(entry.state, state, changed ? { changedAt: Date.now() } : {})
    if (state.state === 'online') {
      if (changed) entry.state.lastConnectedAt = Date.now()
      entry.state.nextRetryAt = undefined
    }
    this.publish()
  }
  async apply(configs: ConnectionConfig[]): Promise<void> {
    const parsed = this.validate(configs)
    for (const [id, entry] of this.entries) {
      if (!parsed.some((config) => config.id === id)) {
        await this.stopEntry(entry)
        this.entries.delete(id)
      }
    }
    for (const config of parsed) {
      let entry = this.entries.get(config.id)
      if (entry && isDeepStrictEqual(entry.config, config)) continue
      const { accountId } = this.definition(config.adapter)
      const replaced =
        entry &&
        (entry.config.adapter !== config.adapter ||
          (accountId && accountId(entry.config.config) !== accountId(config.config)))
      if (entry?.adapter && !replaced && entry.config.enabled && config.enabled) {
        const changed = !isDeepStrictEqual(entry.config.config, config.config)
        entry.config = config
        entry.state.name = config.name
        if (changed) {
          this.update(entry, { state: 'connecting', nextRetryAt: undefined })
          try {
            await entry.adapter.reconfigure(config.config)
          } catch (error) {
            this.update(entry, { state: 'error', lastError: this.error(config, error), errorAt: Date.now() })
          }
        }
        continue
      }
      if (entry) await this.stopEntry(entry)
      if (!entry) {
        entry = {
          config,
          generation: 0,
          bots: new Map(),
          state: {
            id: config.id,
            name: config.name,
            adapter: config.adapter,
            platform: this.definition(config.adapter).platform,
            enabled: config.enabled,
            state: 'disabled',
            changedAt: Date.now(),
            endpoints: [],
            bots: [],
          },
        }
        this.entries.set(config.id, entry)
      }
      if (replaced) {
        entry.bots.clear()
        Object.assign(entry.state, { lastConnectedAt: undefined, lastError: undefined, errorAt: undefined })
      }
      entry.config = config
      Object.assign(entry.state, {
        name: config.name,
        adapter: config.adapter,
        platform: this.definition(config.adapter).platform,
        enabled: config.enabled,
      })
      if (this.running && config.enabled) await this.startEntry(entry)
      else this.update(entry, { state: config.enabled ? 'offline' : 'disabled' })
    }
    this.publish()
  }
  async reconnect(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new ConfigError('Connection not found')
    if (!entry.config.enabled) throw new ConfigError('Connection is disabled')
    await this.stopEntry(entry)
    await this.startEntry(entry)
  }
  async start(): Promise<void> {
    this.running = true
    await this.apply(this.app.config.connections)
  }
  async stop(): Promise<void> {
    this.running = false
    for (const entry of this.entries.values()) await this.stopEntry(entry)
  }
  private async stopEntry(entry: Entry): Promise<void> {
    entry.generation++
    await entry.adapter?.stop()
    entry.adapter = undefined
    for (const bot of entry.bots.values()) this.app.unregisterBot(bot)
    this.update(entry, {
      state: entry.config.enabled ? 'offline' : 'disabled',
      endpoints: [],
      nextRetryAt: undefined,
    })
  }
  private async startEntry(entry: Entry): Promise<void> {
    const generation = ++entry.generation
    this.update(entry, { state: 'connecting', nextRetryAt: undefined })
    const app = this.app
    const current = () => generation === entry.generation
    const { config } = entry
    const definition = this.definition(config.adapter)
    const store = app.storage.store(
      `@adapter:${JSON.stringify([config.adapter, config.id, definition.accountId?.(config.config)])}`,
      () => {
        if (!current()) throw new Error('Connection is stopped')
      },
    )
    const host: AdapterHost = {
      connection: {
        id: config.id,
        store,
        update: ({ error, ...state }) => {
          if (!current()) return
          this.update(entry, {
            ...state,
            ...(error ? { lastError: this.error(entry.config, error), errorAt: Date.now() } : {}),
          })
        },
      },
      logger: app.logger.child({ connectionId: entry.config.id }),
      sessionServices: app.sessionServices,
      get ignoreSelf() {
        return app.ignoreSelf
      },
      emit: (event) => {
        if (!current()) return
        if (event.name === 'bot.online') this.update(entry, { state: 'online' })
        if (event.name === 'bot.offline')
          this.update(entry, {
            state: [...entry.bots.values()].some((bot) => bot.status === 'online')
              ? 'online'
              : entry.state.endpoints.length > 0
                ? 'waiting'
                : 'offline',
          })
        app.emit(event)
      },
      registerBot: (bot) => {
        if (!current()) return
        const existing = app.bots.get(bot.platform, bot.selfId)
        if (existing && existing !== bot && existing.status === 'online')
          throw new Error(`Bot ${bot.platform}:${bot.selfId} already belongs to another connection`)
        entry.bots.set(botKey(bot), bot)
        app.registerBot(bot)
        app.setBotInfo(bot, { connection: entry.config.adapter, connectionId: entry.config.id })
        this.publish()
      },
      unregisterBot: (bot) => {
        if (current()) {
          app.unregisterBot(bot)
          this.publish()
        }
      },
      setBotInfo: (bot, info) => app.setBotInfo(bot, { ...info, connectionId: entry.config.id }),
      registerUpgrade: (path, handler) => {
        const endpoint = `/connections/${encodeURIComponent(entry.config.id)}${path}`
        const remove = app.registerUpgrade(endpoint, handler)
        entry.state.endpoints.push(endpoint)
        this.publish()
        return () => {
          remove()
          if (current()) {
            entry.state.endpoints = entry.state.endpoints.filter((item) => item !== endpoint)
            this.publish()
          }
        }
      },
      whenIdle: () => app.whenIdle(),
      isSuperuser: (actor) => app.isSuperuser(actor),
      isBotAdmin: (actor) => app.isBotAdmin(actor),
      prepareOutgoing: (input) => app.prepareOutgoing(input),
      invokeApi: (call, execute) => app.invokeApi(call, execute),
    }
    try {
      entry.adapter = definition.create(config.config, host)
      await entry.adapter.start()
    } catch (error) {
      const lastError = this.error(entry.config, error)
      this.update(entry, { state: 'error', lastError, errorAt: Date.now() })
      app.logger.error({ connectionId: entry.config.id, reason: lastError }, 'Connection failed')
    }
  }
}
