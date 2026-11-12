import { readFileSync } from 'node:fs'
import type { App } from '../core/app.ts'
import type { Bot } from '../core/bot.ts'
import type { CommandDefinition } from '../core/command/builder.ts'
import { formatUsage } from '../core/command/parse.ts'
import type { PluginState } from '../core/plugin/types.ts'

const version = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

export function botView(app: App, bot: Bot) {
  const info = app.getBotInfo(bot)
  return {
    platform: bot.platform,
    selfId: bot.selfId,
    ...(bot.nickname === undefined ? {} : { nickname: bot.nickname }),
    status: bot.status,
    connection: info?.connection ?? '',
    ...(info?.url === undefined ? {} : { url: info.url }),
  }
}

export function commandView(app: App, command: CommandDefinition) {
  return {
    owner: command.owner,
    path: command.path.join(' '),
    usage: formatUsage(command, app.config.command.prefixes[0] ?? ''),
    description: command.description,
    aliases: [...command.aliases],
    options: command.options.map((option) => ({
      flags: [...option.flags],
      ...(option.description === undefined ? {} : { description: option.description }),
      ...(option.defaultValue === undefined ? {} : { default: option.defaultValue }),
    })),
    examples: [...command.examples],
    permission: command.permission !== undefined,
    scope: command.messageScope,
    hidden: command.hidden,
  }
}

export function pluginView(app: App, state: PluginState) {
  const value = app.plugins.getConfig(state.name)
  let config: unknown
  if (value !== undefined) {
    try {
      const json = JSON.stringify(value)
      if (json !== undefined) config = JSON.parse(json)
    } catch {
      app.logger.warn({ plugin: state.name }, 'Plugin configuration is not JSON serializable')
    }
  }
  return {
    ...state,
    commands: app.dispatcher.registeredCommands(state.name).map((item) => commandView(app, item)),
    ...(config === undefined ? {} : { config }),
  }
}

export function overview(app: App) {
  const states = app.plugins.list()
  const memory = process.memoryUsage()
  return {
    version,
    node: process.version,
    startedAt: app.startedAt,
    memory: { rss: memory.rss, heapUsed: memory.heapUsed },
    bots: app.bots.list().map((bot) => botView(app, bot)),
    plugins: {
      active: states.filter((item) => item.state === 'active').length,
      failed: states.filter((item) => item.state === 'failed').length,
      disabled: states.filter((item) => item.state === 'disabled').length,
    },
    today: app.stats.today(),
  }
}
