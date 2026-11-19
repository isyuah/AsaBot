import type { ActorIdentity, BotIdentity } from './identity.ts'
import { botKey } from './identity.ts'
import type { Storage } from './storage/index.ts'

export class BotPolicies {
  private readonly adminUsers = new Map<string, Set<string>>()
  private readonly plugins = new Map<string, { enabled?: boolean; config?: Record<string, unknown> }>()
  private readonly defaults = new Map<string, Set<string>>()
  private readonly subscribers = new Set<() => void>()
  constructor(privateStorage: Storage) {
    this.storage = privateStorage
  }
  private readonly storage: Storage

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  private publish(): void {
    for (const listener of this.subscribers) listener()
  }

  load(): void {
    this.adminUsers.clear()
    this.plugins.clear()
    this.defaults.clear()
    for (const row of this.storage.db.prepare('SELECT bot_key, user_id FROM bot_admins').all()) {
      const key = String(row.bot_key)
      const users = this.adminUsers.get(key) ?? new Set<string>()
      users.add(String(row.user_id))
      this.adminUsers.set(key, users)
    }
    for (const row of this.storage.db.prepare('SELECT * FROM plugin_bot_policy').all()) {
      this.plugins.set(JSON.stringify([String(row.bot_key), String(row.plugin)]), {
        ...(row.enabled === null ? {} : { enabled: row.enabled === 1 }),
        ...(row.config === null ? {} : { config: JSON.parse(String(row.config)) as Record<string, unknown> }),
      })
    }
    for (const row of this.storage.db
      .prepare('SELECT * FROM bot_plugin_defaults WHERE plugins IS NOT NULL')
      .all()) {
      this.defaults.set(String(row.bot_key), new Set(JSON.parse(String(row.plugins)) as string[]))
    }
  }

  captureExistingDefaults(plugins: string[]): void {
    const defaults = new Set(plugins)
    const migrated = this.storage.db
      .prepare('UPDATE bot_plugin_defaults SET plugins = ? WHERE plugins IS NULL RETURNING bot_key')
      .all(JSON.stringify(plugins))
    for (const row of migrated) this.defaults.set(String(row.bot_key), defaults)
  }

  enroll(bot: BotIdentity, initialPlugins: () => string[]): void {
    if (bot.platform === 'virtual') return
    const key = botKey(bot)
    if (this.defaults.has(key)) return
    const plugins = initialPlugins()
    this.storage.db.prepare('INSERT INTO bot_plugin_defaults VALUES (?, ?)').run(key, JSON.stringify(plugins))
    this.defaults.set(key, new Set(plugins))
  }

  defaultPluginEnabled(bot: BotIdentity, plugin: string): boolean {
    // The playground and events without a real account use globally enabled plugins.
    return (bot.platform === 'virtual' ? undefined : this.defaults.get(botKey(bot)))?.has(plugin) ?? true
  }

  admins(bot: BotIdentity): string[] {
    return [...(this.adminUsers.get(botKey(bot)) ?? [])].sort()
  }
  isAdmin(actor: ActorIdentity): boolean {
    return this.adminUsers.get(botKey(actor))?.has(actor.userId) === true
  }
  setAdmins(bot: BotIdentity, users: string[]): void {
    const db = this.storage.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM bot_admins WHERE bot_key = ?').run(botKey(bot))
      for (const user of new Set(users))
        db.prepare('INSERT INTO bot_admins VALUES (?, ?)').run(botKey(bot), user)
      db.exec('COMMIT')
      this.adminUsers.set(botKey(bot), new Set(users))
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    this.publish()
  }
  plugin(bot: BotIdentity, plugin: string): { enabled?: boolean; config?: Record<string, unknown> } {
    return this.plugins.get(JSON.stringify([botKey(bot), plugin])) ?? {}
  }
  setPlugin(
    bot: BotIdentity,
    plugin: string,
    policy: { enabled?: boolean; config?: Record<string, unknown> },
  ): void {
    if (policy.enabled === undefined && policy.config === undefined) {
      this.storage.db
        .prepare('DELETE FROM plugin_bot_policy WHERE bot_key = ? AND plugin = ?')
        .run(botKey(bot), plugin)
      this.plugins.delete(JSON.stringify([botKey(bot), plugin]))
    } else {
      this.storage.db
        .prepare(
          'INSERT INTO plugin_bot_policy (bot_key, plugin, enabled, config) VALUES (?, ?, ?, ?) ON CONFLICT(bot_key, plugin) DO UPDATE SET enabled = excluded.enabled, config = excluded.config',
        )
        .run(
          botKey(bot),
          plugin,
          policy.enabled === undefined ? null : Number(policy.enabled),
          policy.config === undefined ? null : JSON.stringify(policy.config),
        )
      this.plugins.set(JSON.stringify([botKey(bot), plugin]), policy)
    }
    this.publish()
  }
  configured(plugin: string): (BotIdentity & { config: Record<string, unknown> })[] {
    return this.storage.db
      .prepare('SELECT bot_key, config FROM plugin_bot_policy WHERE plugin = ? AND config IS NOT NULL')
      .all(plugin)
      .map((row) => {
        const [platform, selfId] = JSON.parse(String(row.bot_key)) as [string, string]
        return { platform, selfId, config: JSON.parse(String(row.config)) as Record<string, unknown> }
      })
  }
}
