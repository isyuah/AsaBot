import { useQuery } from '@tanstack/react-query'
import { api } from './api.ts'

/** Platforms of the connected bots, used to build `${platform}:${id}` keys without assuming any protocol. */
export function usePlatforms(): string[] {
  const bots = useQuery({ queryKey: ['bots'], queryFn: api.bots })
  return [...new Set((bots.data ?? []).map((bot) => bot.platform))]
}

/** Opaque platform IDs: anything non-empty without whitespace is acceptable; only the adapter knows the format. */
export function isValidId(value: string): boolean {
  return /^\S+$/.test(value.trim())
}

const platformNames: Record<string, string> = {
  onebot11: 'OneBot 11',
  feishu: '飞书',
  virtual: '虚拟适配器',
  wecom: '企业微信',
  'weixin-clawbot': '微信 ClawBot',
}

/** Display name of an adapter platform; unknown platforms show their raw identifier. */
export function platformName(platform: string): string {
  return platformNames[platform] ?? platform
}
