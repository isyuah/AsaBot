import { z } from 'zod'
import { parseDuration } from '../utils/duration.ts'

const durationSchema = z
  .union([z.number().finite().nonnegative(), z.string()])
  .transform((value, context) => {
    try {
      return parseDuration(value)
    } catch (error) {
      context.issues.push({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid duration',
        input: value,
      })
      return z.NEVER
    }
  })

const commandSchema = z
  .object({
    prefixes: z.array(z.string()).default(['/']),
    mentionAsPrefix: z.boolean().default(true),
    privateRequirePrefix: z.boolean().default(false),
    replyOnError: z.boolean().default(true),
    replyOnDenied: z.boolean().default(true),
  })
  .strict()

const dispatchSchema = z
  .object({
    handlerTimeout: durationSchema.default(3_600_000),
    ignoreSelf: z.boolean().default(true),
    promptTimeout: durationSchema.default(60_000),
    maxPromptTimeout: durationSchema.default(1_800_000),
  })
  .strict()

const connectionSchema = z
  .object({
    type: z.literal('forward'),
    url: z.url(),
    accessToken: z.string().optional(),
  })
  .strict()

const onebot11Schema = z
  .object({
    apiTimeout: durationSchema.default(30_000),
    reconnect: z
      .object({
        minDelay: durationSchema.default(1_000),
        maxDelay: durationSchema.default(60_000),
      })
      .strict()
      .default(() => ({ minDelay: 1_000, maxDelay: 60_000 })),
    connections: z.array(connectionSchema).default([]),
  })
  .strict()

const pluginLoaderSchema = z
  .object({
    dirs: z.array(z.string()).default(['./plugins']),
    hotReload: z.union([z.literal('auto'), z.boolean()]).default('auto'),
  })
  .strict()

const pluginEntrySchema = z
  .object({
    enabled: z.boolean().default(true),
    config: z.unknown().optional(),
  })
  .strict()

export const configSchema = z
  .object({
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    dataDir: z.string().min(1).default('./data'),
    superusers: z.array(z.string()).default([]),
    command: commandSchema.default(() => commandSchema.parse({})),
    dispatch: dispatchSchema.default(() => dispatchSchema.parse({})),
    onebot11: onebot11Schema.default(() => onebot11Schema.parse({})),
    pluginLoader: pluginLoaderSchema.default(() => pluginLoaderSchema.parse({})),
    plugins: z.record(z.string(), pluginEntrySchema).default({}),
    // server configuration is reserved for M5.
  })
  .strict()

export type Config = z.output<typeof configSchema>
