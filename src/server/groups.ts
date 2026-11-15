import type { App } from '../core/app.ts'
import type { GroupInfo } from '../core/bot.ts'
import { groupKeyOf } from '../core/dispatch/types.ts'
import { groupIdentity } from '../core/identity.ts'

export interface GroupView {
  groupKey: string
  platform: string
  groupId: string
  selfId: string
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
    const sources = new Map<
      string,
      { platform: string; selfId: string; groupId: string; name?: string; bots: Set<string> }
    >()
    for (const { bot, groups } of fetched) {
      for (const item of groups) {
        const groupKey = groupKeyOf({ ...bot, groupId: item.groupId })
        const current = sources.get(groupKey) ?? {
          platform: bot.platform,
          selfId: bot.selfId,
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
      const { platform, selfId, groupId } = groupIdentity(rule.groupKey)
      if (!sources.has(rule.groupKey))
        sources.set(rule.groupKey, { platform, selfId, groupId, bots: new Set() })
    }
    const rules = new Map(summaries.map((item) => [item.groupKey, item]))
    return [...sources.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([groupKey, source]) => {
        const summary = rules.get(groupKey) ?? { plugins: 0, configs: 0, commands: 0 }
        const access = this.app.storage.groupAccess(`${source.platform}:${source.groupId}`)
        return {
          groupKey,
          platform: source.platform,
          selfId: source.selfId,
          groupId: source.groupId,
          ...(source.name === undefined ? {} : { name: source.name }),
          bots: [...source.bots].sort(),
          rules: { plugins: summary.plugins, configs: summary.configs, commands: summary.commands },
          ...(access === undefined ? {} : { access }),
        }
      })
  }
}
