import type { SQLOutputValue } from 'node:sqlite'
import type { BotInfo } from './adapter.ts'
import { type Bot, type BotCapabilities, supports } from './bot.ts'
import { capabilitySchema } from './capabilities.ts'
import { type BotIdentity, botKey } from './identity.ts'
import type { Storage } from './storage/index.ts'

export interface BotAccount extends BotIdentity {
  nickname?: string
  avatar?: string
  capabilities?: BotCapabilities
  connection?: string
  connectionId?: string
  lastOnlineAt?: number
}

export interface BotBinding {
  id: string
  key: string
  multiple: boolean
}

export function botAvatar(bot: Bot): string | undefined {
  return bot.avatar ?? (supports(bot, 'getAvatarUrl') ? bot.getAvatarUrl?.(bot.selfId) : undefined)
}

function publicAvatar(value: string | undefined): string | undefined {
  if (!value) return undefined
  const url = URL.parse(value)
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|credential|authorization|signature|api[_-]?key/i.test(key)) return undefined
  }
  url.hash = ''
  return url.href
}

function account(row: Record<string, SQLOutputValue>): BotAccount {
  const [platform, selfId] = JSON.parse(String(row.bot_key)) as [string, string]
  return {
    platform,
    selfId,
    nickname: row.nickname === null ? undefined : String(row.nickname),
    avatar: row.avatar === null ? undefined : String(row.avatar),
    capabilities:
      row.capabilities === null ? undefined : capabilitySchema.parse(JSON.parse(String(row.capabilities))),
    connection: row.connection === null ? undefined : String(row.connection),
    connectionId: row.connection_id === null ? undefined : String(row.connection_id),
    lastOnlineAt: row.last_online_at === null ? undefined : Number(row.last_online_at),
  }
}

/** Known identities and profile data, independent of the live Bot registry. */
export class BotAccounts {
  private readonly storage: Storage

  constructor(storage: Storage) {
    this.storage = storage
  }

  get(bot: BotIdentity): BotAccount | undefined {
    const row = this.storage.db.prepare('SELECT * FROM bot_accounts WHERE bot_key = ?').get(botKey(bot))
    return row && account(row)
  }

  list(): BotAccount[] {
    return this.storage.db.prepare('SELECT * FROM bot_accounts ORDER BY bot_key').all().map(account)
  }

  record(bot: Bot, info?: BotInfo, lastOnlineAt?: number): void {
    if (bot.platform === 'virtual') return
    this.storage.db
      .prepare(`INSERT INTO bot_accounts (bot_key, nickname, avatar, capabilities, connection, last_online_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(bot_key) DO UPDATE SET
        nickname = COALESCE(excluded.nickname, nickname), avatar = COALESCE(excluded.avatar, avatar),
        capabilities = excluded.capabilities, connection = COALESCE(excluded.connection, connection),
        last_online_at = COALESCE(excluded.last_online_at, last_online_at)`)
      .run(
        botKey(bot),
        bot.nickname || null,
        publicAvatar(botAvatar(bot)) ?? null,
        JSON.stringify(bot.capabilities),
        info?.connection ?? null,
        lastOnlineAt ?? null,
      )
  }

  bind(bot: Bot, binding?: BotBinding): void {
    if (bot.platform === 'virtual') return
    const db = this.storage.db
    const key = botKey(bot)
    if (binding && !binding.multiple)
      db.prepare(`UPDATE bot_accounts SET connection_id = NULL, binding_key = NULL
      WHERE connection_id = ? AND bot_key <> ?`).run(binding.id, key)
    db.prepare('UPDATE bot_accounts SET connection_id = ?, binding_key = ? WHERE bot_key = ?').run(
      binding?.id ?? null,
      binding?.key ?? null,
      key,
    )
  }

  pruneBindings(bindings: ReadonlyMap<string, BotBinding>): void {
    const db = this.storage.db
    const clear = db.prepare(
      'UPDATE bot_accounts SET connection_id = NULL, binding_key = NULL WHERE connection_id = ?',
    )
    for (const row of db
      .prepare('SELECT DISTINCT connection_id, binding_key FROM bot_accounts WHERE connection_id IS NOT NULL')
      .all()) {
      const id = String(row.connection_id)
      if (bindings.get(id)?.key !== row.binding_key) clear.run(id)
    }
  }
}
