import { join } from 'node:path'
import { z } from 'zod'
import { parseDuration } from '../utils/duration.ts'

export const durationSchema = z
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

export const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error'])

const timezoneSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value })
      return true
    } catch {
      return false
    }
  }, 'Invalid IANA timezone')

const fileSizeSchema = z.union([z.number(), z.string()]).transform((value, context) => {
  const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i.exec(value) : undefined
  const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }
  const size =
    typeof value === 'number'
      ? value
      : match
        ? Number(match[1]) * (units[(match[2] as string).toUpperCase()] as number)
        : NaN
  if (!Number.isSafeInteger(size) || size <= 0) {
    context.issues.push({ code: 'custom', message: 'Invalid file size', input: value })
    return z.NEVER
  }
  return size
})

const logSchema = z
  .object({
    level: logLevelSchema.default('info'),
    file: z
      .object({
        path: z.string().min(1),
        maxSize: fileSizeSchema.default(10 * 1024 * 1024),
        maxFiles: z.number().int().min(1).default(5),
      })
      .strict()
      .optional(),
  })
  .strict()

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

const pluginLoaderSchema = z
  .object({
    dirs: z.array(z.string()).default(['./plugins']),
    uploadDir: z.string().min(1).optional(),
    hotReload: z.union([z.literal('auto'), z.boolean()]).default('auto'),
    setupTimeout: durationSchema
      .refine((value) => value > 0 && value <= 2_147_483_647, 'Invalid setup timeout')
      .default(30_000),
  })
  .strict()

const packagesSchema = z
  .object({
    dir: z.string().min(1).optional(),
    registry: z.url().default('https://registry.npmjs.org'),
    npm: z.string().min(1).default('npm'),
    installTimeout: durationSchema.default(300_000),
  })
  .strict()

const pluginEntrySchema = z
  .object({
    enabled: z.boolean().default(true),
    config: z.unknown().optional(),
  })
  .strict()

const serverSchema = z
  .object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(0).max(65_535).default(5140),
    apiToken: z.string().default(''),
    panelPassword: z.string().default(''),
  })
  .strict()

export const configSchema = z
  .object({
    log: logSchema.default(() => logSchema.parse({})),
    timezone: timezoneSchema.prefault(
      () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    dataDir: z.string().min(1).default('./data'),
    superusers: z.array(z.string()).default([]),
    command: commandSchema.default(() => commandSchema.parse({})),
    dispatch: dispatchSchema.default(() => dispatchSchema.parse({})),
    adapters: z.record(z.string(), z.unknown()).default({}),
    pluginLoader: pluginLoaderSchema.default(() => pluginLoaderSchema.parse({})),
    packages: packagesSchema.default(() => packagesSchema.parse({})),
    plugins: z.record(z.string(), pluginEntrySchema).default({}),
    server: serverSchema.default(() => serverSchema.parse({})),
  })
  .strict()
  .transform((config) => ({
    ...config,
    pluginLoader: {
      ...config.pluginLoader,
      uploadDir: config.pluginLoader.uploadDir ?? config.pluginLoader.dirs[0],
    },
    packages: { ...config.packages, dir: config.packages.dir ?? join(config.dataDir, 'packages') },
  }))

export type Config = z.output<typeof configSchema>
