import type { App } from '../core/app.ts'
import type { GroupInfo } from '../core/bot.ts'

export interface GroupView {
  groupKey: string
  platform: string
  groupId: string
  name?: string
  bots: string[]
  rules: { plugins: number; configs: number; commands: number }
  access?: 'block' | 'allow'
}

export class Groups {
  private readonly app: App
  private readonly cache = new WeakMap<object, { expires: number; groups: GroupInfo[] }>()

  constructor(app: App) {
    this.app = app
  }

  async list(refresh = false): Promise<GroupView[]> {
    const now = Date.now()
    const online = this.app.bots.list().filter((bot) => bot.status === 'online')
    const fetched = await Promise.all(
      online.map(async (bot) => {
        const cached = this.cache.get(bot)
        if (!refresh && cached && cached.expires > now) return { bot, groups: cached.groups }
        try {
          const groups = await bot.getGroupList()
          this.cache.set(bot, { expires: Date.now() + 5 * 60_000, groups })
          return { bot, groups }
        } catch (error) {
          this.app.logger.warn(
            { err: error, platform: bot.platform, selfId: bot.selfId },
            'Failed to fetch bot groups',
          )
          return { bot, groups: [] }
        }
      }),
    )
    const sources = new Map<string, { platform: string; groupId: string; name?: string; bots: Set<string> }>()
    for (const { bot, groups } of fetched) {
      for (const item of groups) {
        const groupKey = `${bot.platform}:${item.groupId}`
        const current = sources.get(groupKey) ?? {
          platform: bot.platform,
          groupId: item.groupId,
          ...(item.groupName === '' ? {} : { name: item.groupName }),
          bots: new Set<string>(),
        }
        current.bots.add(bot.selfId)
        if (current.name === undefined && item.groupName !== '') current.name = item.groupName
        sources.set(groupKey, current)
      }
    }
    const summaries = this.app.storage.groupRuleSummaries()
    for (const rule of summaries) {
      const separator = rule.groupKey.indexOf(':')
      if (separator <= 0 || separator === rule.groupKey.length - 1) continue
      const platform = rule.groupKey.slice(0, separator)
      const groupId = rule.groupKey.slice(separator + 1)
      if (!sources.has(rule.groupKey)) sources.set(rule.groupKey, { platform, groupId, bots: new Set() })
    }
    const rules = new Map(summaries.map((item) => [item.groupKey, item]))
    return [...sources.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([groupKey, source]) => {
        const summary = rules.get(groupKey) ?? { plugins: 0, configs: 0, commands: 0 }
        const access = this.app.storage.groupAccess(groupKey)
        return {
          groupKey,
          platform: source.platform,
          groupId: source.groupId,
          ...(source.name === undefined ? {} : { name: source.name }),
          bots: [...source.bots].sort(),
          rules: { plugins: summary.plugins, configs: summary.configs, commands: summary.commands },
          ...(access === undefined ? {} : { access }),
        }
      })
  }
}
