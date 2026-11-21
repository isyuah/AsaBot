import type { z } from 'zod'
import type { CapabilityRequirements } from '../capabilities.ts'
import type { Context } from './context.ts'

/** 插件名称、可选配置 schema、依赖及 setup 入口的定义。 */
export interface PluginDefinition<Schema extends z.ZodType | undefined = z.ZodType | undefined> {
  /** 全局唯一的插件名称。 */
  name: string
  /** 插件版本，用于展示。 */
  version?: string
  /** 插件说明，用于展示。 */
  description?: string
  /** 内置和文件插件的 HTTPS 图标 URL；npm 插件在 keywords 中声明 asabot-icon:<URL>。 */
  iconUrl?: string
  /** 安装时用于初始化「新机器人默认启用」；不声明时为 false。 */
  defaultOnNewBots?: boolean
  /** 校验配置并推导 ctx.config 类型的 zod schema。 */
  config?: Schema
  /** 必须先加载的插件名称。 */
  depends?: string[]
  /** 使用的必需或可选服务名称；只能通过 ctx 注入已声明的服务。 */
  inject?: string[] | { required?: string[]; optional?: string[] }
  /** 能力需求只用于兼容性提示，不阻止插件在机器人上启用。 */
  capabilities?: CapabilityRequirements
  /** 插件启动入口；可以注册命令和其他资源。 */
  setup(ctx: Context<Schema extends z.ZodType ? z.output<Schema> : undefined>): void | Promise<void>
}

export function serviceDependencies(inject: PluginDefinition['inject']): {
  required: readonly string[]
  optional: readonly string[]
} {
  return Array.isArray(inject)
    ? { required: inject, optional: [] }
    : { required: inject?.required ?? [], optional: inject?.optional ?? [] }
}

/**
 * 定义插件并从 zod schema 推导 ctx.config 类型；返回原插件定义。
 * @example
 * definePlugin({ name: 'hello', setup(ctx) { ctx.command('hello').action(() => '你好') } })
 */
export function definePlugin(definition: PluginDefinition<undefined>): PluginDefinition<undefined>
/** 定义插件并从 zod schema 推导 ctx.config 类型；返回原插件定义。 */
export function definePlugin<Schema extends z.ZodType>(
  definition: PluginDefinition<Schema>,
): PluginDefinition<Schema>
/** 定义插件并从 zod schema 推导 ctx.config 类型；返回原插件定义。 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition
}
