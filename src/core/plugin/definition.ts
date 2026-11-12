import type { z } from 'zod'
import type { Context } from './context.ts'

export interface PluginDefinition<Schema extends z.ZodType | undefined = z.ZodType | undefined> {
  name: string
  version?: string
  description?: string
  config?: Schema
  depends?: string[]
  setup(ctx: Context<Schema extends z.ZodType ? z.output<Schema> : undefined>): void | Promise<void>
}

export function definePlugin(definition: PluginDefinition<undefined>): PluginDefinition<undefined>
export function definePlugin<Schema extends z.ZodType>(
  definition: PluginDefinition<Schema>,
): PluginDefinition<Schema>
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition
}
