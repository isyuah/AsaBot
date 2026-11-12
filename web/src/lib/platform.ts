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
