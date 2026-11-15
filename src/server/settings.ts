import { z } from 'zod'
import { adapters } from '../adapters/index.ts'
import type { App } from '../core/app.ts'
import {
  formatIssuePath,
  InterpolationError,
  interpolateConfigValues,
  readRawConfig,
} from '../core/config/load.ts'
import { type Config, configSchema } from '../core/config/schema.ts'
import { writeConfigValue } from '../core/config/write.ts'
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
    superusers: z.array(z.string()).optional(),
    timezone: z.string().optional(),
    command: commandInput.optional(),
    adapters: z.record(z.string(), z.unknown()).optional(),
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
    superusers: z.array(z.string()),
    adapters: z.record(z.string(), z.unknown()).optional(),
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

function merge(previous: unknown, next: unknown, path: (string | number)[] = []): unknown {
  const key = path.at(-1)
  if (typeof key === 'string' && sensitive.has(key) && next === placeholder) {
    if (typeof previous !== 'string') {
      throw new SettingsValidationError([
        { path: formatIssuePath(path), message: 'No existing value to preserve' },
      ])
    }
    return previous
  }
  if (Array.isArray(next))
    return next.map((item, index) =>
      merge(Array.isArray(previous) ? previous[index] : undefined, item, [...path, index]),
    )
  if (isRecord(next)) {
    const result: ConfigRecord = isRecord(previous) ? { ...previous } : {}
    for (const [name, value] of Object.entries(next)) {
      Object.defineProperty(result, name, {
        value: merge(isRecord(previous) ? previous[name] : undefined, value, [...path, name]),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return result
  }
  return next
}

function mask(value: unknown, key = ''): unknown {
  if (typeof value === 'string' && sensitive.has(key)) {
    return value && !reference.test(value) ? placeholder : value
  }
  if (Array.isArray(value)) return value.map((item) => mask(item))
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mask(item, name)]))
  return value
}

function validate(raw: unknown): { config: Config; adapters: Record<string, unknown> } {
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
  const parsed: Record<string, unknown> = {}
  const issues: { path: string; message: string }[] = []
  for (const [name, value] of Object.entries(result.data.adapters)) {
    const definition = Object.hasOwn(adapters, name) ? adapters[name] : undefined
    if (!definition) {
      issues.push({
        path: formatIssuePath(['adapters', name]),
        message: `Unknown adapter; available: ${Object.keys(adapters).join(', ')}`,
      })
      continue
    }
    const adapter = definition.configSchema.safeParse(value)
    if (adapter.success) parsed[name] = adapter.data
    else
      issues.push(
        ...adapter.error.issues.map((issue) => ({
          path: formatIssuePath(['adapters', name, ...issue.path]),
          message: issue.message,
        })),
      )
  }
  if (issues.length) throw new SettingsValidationError(issues)
  return { config: result.data, adapters: parsed }
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
    const { config } = validate(raw)
    const configured = isRecord(raw.adapters) ? raw.adapters : {}
    const { overrides: _overrides, ...command } = config.command
    return {
      superusers: config.superusers,
      timezone: config.timezone,
      command,
      adapters: Object.fromEntries(
        Object.entries(configured).map(([name, value]) => {
          const definition = adapters[name]
          if (!definition) throw new Error('Validated adapter is missing from registry')
          return [
            name,
            { value: mask(value), schema: z.toJSONSchema(definition.configSchema, { io: 'input' }) },
          ]
        }),
      ),
      available: Object.keys(adapters),
      restartRequired: config.timezone === this.app.config.timezone ? [] : ['timezone'],
    }
  }

  update(input: SettingsInput) {
    return this.app.plugins.serial(async () => {
      const previous = await this.raw()
      const next = merge(previous, input) as ConfigRecord
      if (input.adapters) {
        const configured = next.adapters as ConfigRecord
        for (const [name, value] of Object.entries(input.adapters))
          if (value === null) delete configured[name]
      }
      const validated = validate(next)
      await this.persist(previous, next)
      this.app.config.superusers = validated.config.superusers
      this.app.config.command = validated.config.command
      await this.app.reconfigureAdapters(validated.adapters)
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
        ...(input.adapters === undefined ? {} : { adapters: input.adapters }),
      }) as ConfigRecord
      next.server = { ...(isRecord(next.server) ? next.server : {}), panelPassword: input.password }
      const validated = validate(next)
      await this.persist(previous, next)
      this.app.config.server.panelPassword = validated.config.server.panelPassword
      this.app.config.superusers = validated.config.superusers
      await this.app.reconfigureAdapters(validated.adapters)
      this.app.setupCode = undefined
    })
  }

  private async persist(previous: ConfigRecord, next: ConfigRecord): Promise<void> {
    if (this.app.configPath)
      await writeConfigValue(this.app.configPath, [], next, { previousValue: previous })
    else this.memory = next
  }
}
