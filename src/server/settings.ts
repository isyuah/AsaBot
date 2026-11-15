import { z } from 'zod'
import type { App } from '../core/app.ts'
import {
  formatIssuePath,
  InterpolationError,
  interpolateConfigValues,
  readRawConfig,
} from '../core/config/load.ts'
import { type Config, configSchema } from '../core/config/schema.ts'
import { writeConfigValue } from '../core/config/write.ts'
import { type ConnectionConfig, connectionSchema } from '../core/connections.ts'
import { ConfigError } from '../core/errors.ts'
import { actorIdentitySchema } from '../core/identity.ts'
import { constantTimeEqual } from '../core/utils/security.ts'

const placeholder = '********'
const sensitive = new Set(['accessToken', 'token', 'password', 'apiToken', 'appSecret'])
const reference = /^\$\{[A-Za-z_][A-Za-z\d_]*(?::-[^}]*)?\}$/

const commandInput = z
  .object({
    prefixes: z.array(z.string()).optional(),
    mentionAsPrefix: z.boolean().optional(),
    privateRequirePrefix: z.boolean().optional(),
    replyOnError: z.boolean().optional(),
    replyOnDenied: z.boolean().optional(),
    suggest: z.enum(['off', 'direct', 'always']).optional(),
  })
  .strict()

export const settingsInput = z
  .object({
    superusers: z.array(actorIdentitySchema).optional(),
    timezone: z.string().optional(),
    command: commandInput.optional(),
  })
  .strict()

export const setupInput = z
  .object({
    code: z.string(),
    // The password is written to the YAML literally, where `${...}` would be read back as an env reference.
    password: z
      .string()
      .min(8)
      .refine((value) => !value.includes('${'), 'Password must not contain "${"'),
    superusers: z.array(actorIdentitySchema),
  })
  .strict()

type SettingsInput = z.output<typeof settingsInput>
type SetupInput = z.output<typeof setupInput>
type ConfigRecord = Record<string, unknown>

export class SetupCodeError extends Error {}

export class SettingsValidationError extends Error {
  readonly issues: { path: string; message: string }[]

  constructor(issues: { path: string; message: string }[]) {
    super('Configuration is invalid')
    this.issues = issues
  }
}

function isRecord(value: unknown): value is ConfigRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function merge(previous: unknown, next: unknown, path: (string | number)[] = [], schema?: unknown): unknown {
  const key = path.at(-1)
  if (
    ((typeof key === 'string' && sensitive.has(key)) || (isRecord(schema) && schema.writeOnly === true)) &&
    next === placeholder
  ) {
    if (typeof previous !== 'string') {
      throw new SettingsValidationError([
        { path: formatIssuePath(path), message: 'No existing value to preserve' },
      ])
    }
    return previous
  }
  if (Array.isArray(next))
    return next.map((item, index) =>
      merge(
        Array.isArray(previous) ? previous[index] : undefined,
        item,
        [...path, index],
        isRecord(schema) ? schema.items : undefined,
      ),
    )
  if (isRecord(next)) {
    const result: ConfigRecord = isRecord(previous) ? { ...previous } : {}
    for (const [name, value] of Object.entries(next)) {
      Object.defineProperty(result, name, {
        value: merge(
          isRecord(previous) ? previous[name] : undefined,
          value,
          [...path, name],
          property(schema, name),
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return result
  }
  return next
}

function property(schema: unknown, name: string): unknown {
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties[name] : undefined
}

function mask(value: unknown, key = '', schema?: unknown): unknown {
  if (typeof value === 'string' && (sensitive.has(key) || (isRecord(schema) && schema.writeOnly === true))) {
    return value && !reference.test(value) ? placeholder : value
  }
  if (Array.isArray(value))
    return value.map((item) => mask(item, '', isRecord(schema) ? schema.items : undefined))
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, mask(item, name, property(schema, name))]),
    )
  return value
}

function validate(raw: unknown, app: App): { config: Config } {
  let interpolated: unknown
  try {
    interpolated = interpolateConfigValues(raw)
  } catch (error) {
    if (error instanceof InterpolationError)
      throw new SettingsValidationError([{ path: error.path, message: error.message }])
    throw error
  }
  const result = configSchema.safeParse(interpolated)
  if (!result.success) {
    throw new SettingsValidationError(
      result.error.issues.map((issue) => ({ path: formatIssuePath(issue.path), message: issue.message })),
    )
  }
  try {
    app.connections.validate(result.data.connections)
  } catch (error) {
    if (error instanceof ConfigError)
      throw new SettingsValidationError([{ path: 'connections', message: error.message }])
    throw error
  }
  return { config: result.data }
}

export class SettingsService {
  private readonly app: App
  private memory: ConfigRecord

  constructor(app: App) {
    this.app = app
    this.memory = structuredClone(app.config)
  }

  private async raw(): Promise<ConfigRecord> {
    if (!this.app.configPath) {
      this.memory.plugins = structuredClone(this.app.config.plugins)
      const command = isRecord(this.memory.command) ? this.memory.command : {}
      command.overrides = structuredClone(this.app.config.command.overrides)
      this.memory.command = command
    }
    const value = this.app.configPath ? await readRawConfig(this.app.configPath) : this.memory
    if (!isRecord(value))
      throw new SettingsValidationError([{ path: '<root>', message: 'Expected an object' }])
    return value
  }

  async get() {
    const raw = await this.raw()
    const { config } = validate(raw, this.app)
    const { overrides: _overrides, ...command } = config.command
    return {
      superusers: config.superusers,
      timezone: config.timezone,
      command,
      restartRequired: config.timezone === this.app.config.timezone ? [] : ['timezone'],
    }
  }

  update(input: SettingsInput) {
    return this.app.plugins.serial(async () => {
      const previous = await this.raw()
      const next = merge(previous, input) as ConfigRecord
      const validated = validate(next, this.app)
      await this.persist(previous, next)
      this.app.config.superusers = validated.config.superusers
      this.app.config.command = validated.config.command
      return this.get()
    })
  }

  setup(input: SetupInput): Promise<void> {
    return this.app.plugins.serial(async () => {
      if (!this.app.setupCode || !constantTimeEqual(input.code, this.app.setupCode))
        throw new SetupCodeError()
      const previous = await this.raw()
      const next = merge(previous, {
        superusers: input.superusers,
      }) as ConfigRecord
      next.server = { ...(isRecord(next.server) ? next.server : {}), panelPassword: input.password }
      const validated = validate(next, this.app)
      await this.persist(previous, next)
      this.app.config.server.panelPassword = validated.config.server.panelPassword
      this.app.config.superusers = validated.config.superusers
      this.app.setupCode = undefined
    })
  }

  async connections() {
    const raw = await this.raw()
    const records = z.array(connectionSchema).parse(raw.connections ?? [])
    return this.app.connections.list().map((state) => {
      const config = records.find((record) => record.id === state.id)
      const schema = this.app.connections
        .catalog()
        .find((adapter) => adapter.id === state.adapter)?.configSchema
      return { ...state, config: mask(config?.config, '', schema) }
    })
  }

  saveConnection(input: ConnectionConfig): Promise<unknown> {
    return this.app.plugins.serial(async () => {
      const previous = await this.raw()
      const records = z.array(connectionSchema).parse(previous.connections ?? [])
      const old = records.find((record) => record.id === input.id)
      const schema = this.app.connections
        .catalog()
        .find((adapter) => adapter.id === input.adapter)?.configSchema
      const nextRecord = {
        ...input,
        config: merge(old?.adapter === input.adapter ? old.config : undefined, input.config, [], schema),
      }
      const next = {
        ...previous,
        connections: old
          ? records.map((record) => (record.id === input.id ? nextRecord : record))
          : [...records, nextRecord],
      }
      const { config } = validate(next, this.app)
      await this.persist(previous, next)
      this.app.config.connections = config.connections
      await this.app.connections.apply(config.connections)
      return this.connections()
    })
  }

  removeConnection(id: string): Promise<unknown> {
    return this.app.plugins.serial(async () => {
      const previous = await this.raw()
      const records = z.array(connectionSchema).parse(previous.connections ?? [])
      const next = { ...previous, connections: records.filter((record) => record.id !== id) }
      const { config } = validate(next, this.app)
      await this.persist(previous, next)
      this.app.config.connections = config.connections
      await this.app.connections.apply(config.connections)
      return this.connections()
    })
  }

  private async persist(previous: ConfigRecord, next: ConfigRecord): Promise<void> {
    if (this.app.configPath)
      await writeConfigValue(this.app.configPath, [], next, { previousValue: previous })
    else this.memory = next
  }
}
