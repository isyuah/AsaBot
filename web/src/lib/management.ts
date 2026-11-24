import type { QueryClient } from '@tanstack/react-query'
import type { BotView } from './types.ts'

export const botPath = (bot: Pick<BotView, 'platform' | 'selfId'>, tab = 'overview') =>
  `/bots/${encodeURIComponent(bot.platform)}/${encodeURIComponent(bot.selfId)}/${tab}`
export const botDisplayName = (bot: Pick<BotView, 'alias' | 'nickname' | 'selfId'>) =>
  bot.alias || bot.nickname || bot.selfId
export const connectionPath = (id: string) => `/bots/connections/${encodeURIComponent(id)}`
export const pluginPath = (name: string, tab = 'overview') => `/plugin/${encodeURIComponent(name)}/${tab}`
export const adapterPath = (id: string) => `/adapters/${encodeURIComponent(id)}`
export const timeText = (time?: number) =>
  time === undefined ? '—' : new Date(time).toLocaleString('zh-CN', { hour12: false })
export function invalidatePolicies(client: QueryClient): void {
  for (const key of ['bot', 'pluginBots', 'groups', 'group', 'pluginGroups'])
    void client.invalidateQueries({ queryKey: [key] })
}
