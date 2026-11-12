import type { Bot } from '../bot.ts'
import type { BaseEvent } from '../event/index.ts'

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

export interface PluginState {
  name: string
  version?: string
  description?: string
  source: 'builtin' | 'file' | 'package'
  path?: string
  state: 'loading' | 'active' | 'failed' | 'disabled'
  error?: string
  enabled: boolean
  provides: string[]
  inject: { name: string; optional: boolean }[]
  configSchema?: Record<string, unknown>
}

// Framework events can be emitted before an adapter has registered a Bot.
export interface PluginStateEvent extends Omit<BaseEvent, 'bot'> {
  readonly kind: 'internal'
  readonly name: 'plugin.state'
  readonly bot?: Bot
  readonly plugin: PluginState
}
