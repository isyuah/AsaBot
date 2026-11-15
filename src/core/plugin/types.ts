import type { Bot } from '../bot.ts'
import type { CapabilityRequirements } from '../capabilities.ts'
import type { BaseEvent } from '../event/index.ts'

/** 插件面板页面的标题、图标、静态目录和可选入口文件。 */
export interface PanelPageOptions {
  title: string
  icon?: string
  root: URL | string
  entry?: string
}

export interface PanelPage {
  title: string
  icon?: string
  root: string
  entry: string
}

/** 插件的来源、运行状态、依赖服务及可选错误信息。 */
export interface PluginState {
  name: string
  version?: string
  description?: string
  depends?: string[]
  source: 'builtin' | 'file' | 'package'
  path?: string
  state: 'loading' | 'active' | 'failed' | 'disabled'
  error?: string
  enabled: boolean
  provides: string[]
  inject: { name: string; optional: boolean }[]
  configSchema?: Record<string, unknown>
  capabilities?: CapabilityRequirements
}

// Framework events can be emitted before an adapter has registered a Bot.
/** 插件状态变化事件；机器人可能尚未上线，bot 因而可缺省。 */
export interface PluginStateEvent extends Omit<BaseEvent, 'bot'> {
  readonly kind: 'internal'
  readonly name: 'plugin.state'
  readonly bot?: Bot
  readonly plugin: PluginState
}
