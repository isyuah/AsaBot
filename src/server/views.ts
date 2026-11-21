import { readFileSync } from 'node:fs'
import type { App } from '../core/app.ts'
import type { Bot } from '../core/bot.ts'
import { type BotAccount, botAvatar } from '../core/bot-accounts.ts'
import { compatibility } from '../core/capabilities.ts'
import type { CommandDefinition } from '../core/command/builder.ts'
import { formatUsage } from '../core/command/parse.ts'
import { type BotIdentity, botKey } from '../core/identity.ts'
import type { PluginState } from '../core/plugin/types.ts'

const version = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

function botView(app: App, account: BotAccount, live?: Bot) {
  const info = live && app.getBotInfo(live)
  return {
    ...account,
    nickname: live?.nickname || account.nickname,
    avatar: (live && botAvatar(live)) ?? account.avatar,
    status: live?.status ?? 'offline',
    connection: info?.connection ?? account.connection ?? '',
    capabilities: live?.capabilities ?? account.capabilities,
  }
}

export function commandView(app: App, command: CommandDefinition) {
  const path = command.path.join(' ')
  const override = app.config.command.overrides[path]
  return {
    owner: command.owner,
    path,
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
    ...(override === undefined ? {} : { override }),
    disabledGroups: app.storage.disabledCommandGroups(path),
    overrideIssues: app.dispatcher.overrideIssues(command),
  }
}

export function pluginView(app: App, state: PluginState) {
  const { credentialGroups, ...view } = state
  const value = app.plugins.getConfig(state.name)
  const page = app.getPanelPage(state.name)
  let config: unknown
  if (value !== undefined) {
    try {
      const json = JSON.stringify(value)
      if (json !== undefined) config = JSON.parse(json)
    } catch (error) {
      app.logger.warn({ err: error, plugin: state.name }, 'Plugin configuration is not JSON serializable')
    }
  }
  return {
    ...view,
    hasCredentials: Boolean(credentialGroups?.length) || app.storage.credentials.has(state.name),
    defaultOnNewBots: app.config.plugins[state.name]?.defaultOnNewBots ?? false,
    provides: [...state.provides],
    inject: [...state.inject],
    removable: state.source !== 'builtin',
    ...(state.source === 'package' ? { package: app.plugins.packageInfo(state.name) } : {}),
    commands: app.dispatcher.registeredCommands(state.name).map((item) => commandView(app, item)),
    ...(config === undefined ? {} : { config }),
    ...(page === undefined
      ? {}
      : { page: { title: page.title, ...(page.icon === undefined ? {} : { icon: page.icon }) } }),
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
    bots: panelBots(app),
    plugins: {
      active: states.filter((item) => item.state === 'active').length,
      failed: states.filter((item) => item.state === 'failed').length,
      disabled: states.filter((item) => item.state === 'disabled').length,
    },
    today: app.stats.today(),
  }
}

export function panelBot(app: App, identity: BotIdentity) {
  const { platform, selfId } = identity
  const live = app.getBot(platform, selfId)
  const account = app.botAccounts.get(identity)
  if (live || account) return botView(app, account ?? { platform, selfId }, live)
}

export function panelBots(app: App) {
  const accounts = new Map(app.botAccounts.list().map((account) => [botKey(account), account]))
  for (const bot of app.bots.list()) {
    if (!accounts.has(botKey(bot))) accounts.set(botKey(bot), { platform: bot.platform, selfId: bot.selfId })
  }
  return [...accounts.values()].map((account) =>
    botView(app, account, app.getBot(account.platform, account.selfId)),
  )
}

export function botPluginView(app: App, bot: BotAccount, name: string) {
  const state = app.plugins.get(name)
  if (!state) throw new Error('Unknown plugin')
  const policy = app.policies.plugin(bot, name)
  return {
    ...pluginView(app, state),
    botEnabled: app.plugins.isEnabledOnBot(name, bot),
    botDefaultEnabled: app.policies.defaultPluginEnabled(bot, name),
    overrideEnabled: policy.enabled,
    override: policy.config,
    effectiveConfig:
      state.configSchema && app.plugins.getConfig(name) !== undefined
        ? app.plugins.configFor(name, bot)
        : undefined,
    configSources:
      state.configSchema && app.plugins.getConfig(name) !== undefined
        ? app.plugins.configSources(name, bot)
        : {},
    compatibility: bot.capabilities && compatibility(state.capabilities, bot.capabilities),
  }
}
