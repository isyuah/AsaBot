import type { z } from 'zod'
import type { Adapter, AdapterHost } from '../core/adapter.ts'
import { OneBotAdapter } from './onebot11/adapter.ts'
import { onebot11Schema } from './onebot11/config.ts'

export interface AdapterDefinition {
  configSchema: z.ZodType
  create(config: unknown, host: AdapterHost): Adapter
}

function defineAdapter<T>(
  configSchema: z.ZodType<T>,
  create: (config: T, host: AdapterHost) => Adapter,
): AdapterDefinition {
  return { configSchema, create: (config, host) => create(config as T, host) }
}

export const adapters: Record<string, AdapterDefinition> = {
  onebot11: defineAdapter(
    onebot11Schema,
    (config, host) => new OneBotAdapter(config, host, { ignoreSelf: host.ignoreSelf }),
  ),
}
