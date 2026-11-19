import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { AdapterDefinition, QrConnectionSetup } from '../core/adapter.ts'
import { capabilitySchema } from '../core/capabilities.ts'
import { ConfigError } from '../core/errors.ts'

const accountId = z.custom<NonNullable<AdapterDefinition['accountId']>>(
  (value) => typeof value === 'function',
)
const qrSetup = z.object({
  kind: z.literal('qr'),
  start: z.custom<QrConnectionSetup['start']>((value) => typeof value === 'function'),
})

const definitionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    platform: z.string().regex(/^[^:\s]+$/),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string(),
    connectionTypes: z.array(z.string()),
    capabilities: capabilitySchema,
    configSchema: z.custom<z.ZodType>(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'safeParse' in value &&
        typeof value.safeParse === 'function',
    ),
    create: z.custom<AdapterDefinition['create']>((value) => typeof value === 'function'),
  })
  .and(
    z.union([
      z.object({ setup: qrSetup, accountId }),
      z.object({ setup: z.undefined().optional(), accountId: accountId.optional() }),
    ]),
  )

/** 从用户项目解析包，保留 Node 的 import 条件导出语义。 */
export async function loadAdapterModules(
  modules: string[],
  cwd = process.cwd(),
): Promise<{ definition: AdapterDefinition; source: string }[]> {
  const loaded: { definition: AdapterDefinition; source: string }[] = []
  for (const specifier of modules) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9_./-]+)?$/i.test(specifier))
      throw new ConfigError(`Invalid adapter package "${specifier}"`)
    const entry = `asabot-adapter:${randomUUID()}`
    const hooks = registerHooks({
      resolve(name, context, nextResolve) {
        return name === entry
          ? nextResolve(specifier, {
              ...context,
              parentURL: pathToFileURL(resolve(cwd, 'package.json')).href,
            })
          : nextResolve(name, context)
      },
    })
    try {
      const module: { default?: unknown } = await import(entry)
      const definition = definitionSchema.parse(module.default)
      loaded.push({ definition, source: specifier })
    } catch (error) {
      throw new ConfigError(`Cannot load adapter package "${specifier}"`, { cause: error })
    } finally {
      hooks.deregister()
    }
  }
  return loaded
}
