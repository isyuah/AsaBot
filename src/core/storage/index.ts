import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Logger } from 'pino'
import type { DispatchEvent } from '../dispatch/types.ts'
import { parseDuration } from '../utils/duration.ts'

export type AccessList = 'block' | 'allow'
export type AccessSubject = 'user' | 'group'
export interface AccessEntry {
  list: AccessList
  subject: AccessSubject
  key: string
}

const coreMigrations = [
  `CREATE TABLE kv (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER,
    PRIMARY KEY (plugin, key));
   CREATE TABLE plugin_group_state (plugin TEXT NOT NULL, group_key TEXT NOT NULL, enabled INTEGER NOT NULL,
    PRIMARY KEY (plugin, group_key));
   CREATE TABLE access_list (list TEXT NOT NULL, subject TEXT NOT NULL, key TEXT NOT NULL,
    PRIMARY KEY (list, subject, key));`,
  `CREATE TABLE plugin_tables (plugin TEXT NOT NULL, table_name TEXT PRIMARY KEY);`,
]

export class Storage {
  private database?: DatabaseSync
  private cleanup?: NodeJS.Timeout
  private readonly dataDir: string
  private readonly logger: Logger | undefined
  private readonly groups = new Map<string, boolean>()
  private readonly accessEntries = new Map<string, Set<string>>()
  readonly access: {
    add: (list: AccessList, subject: AccessSubject, key: string) => void
    remove: (list: AccessList, subject: AccessSubject, key: string) => void
    list: (list?: AccessList, subject?: AccessSubject) => AccessEntry[]
  }

  constructor(dataDir: string, logger?: Logger) {
    this.dataDir = dataDir
    this.logger = logger
    this.access = {
      add: (list, subject, key) => {
        this.db.prepare('INSERT OR IGNORE INTO access_list VALUES (?, ?, ?)').run(list, subject, key)
        this.accessSet(list, subject).add(key)
      },
      remove: (list, subject, key) => {
        this.db
          .prepare('DELETE FROM access_list WHERE list = ? AND subject = ? AND key = ?')
          .run(list, subject, key)
        this.accessSet(list, subject).delete(key)
      },
      list: (list, subject) => {
        const entries: AccessEntry[] = []
        for (const currentList of ['block', 'allow'] as const) {
          for (const currentSubject of ['user', 'group'] as const) {
            if ((list && list !== currentList) || (subject && subject !== currentSubject)) continue
            for (const key of this.accessSet(currentList, currentSubject)) {
              entries.push({ list: currentList, subject: currentSubject, key })
            }
          }
        }
        return entries
      },
    }
  }

  get db(): DatabaseSync {
    if (!this.database) throw new Error('Storage is not open')
    return this.database
  }

  open(): void {
    if (this.database) return
    mkdirSync(this.dataDir, { recursive: true })
    const db = new DatabaseSync(join(this.dataDir, 'asabot.db'))
    this.database = db
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')
      db.exec('CREATE TABLE IF NOT EXISTS migrations (plugin TEXT PRIMARY KEY, version INTEGER NOT NULL)')
      this.migrate('core', coreMigrations)
      for (const row of db.prepare('SELECT plugin, group_key, enabled FROM plugin_group_state').all()) {
        this.groups.set(JSON.stringify([row.plugin, row.group_key]), row.enabled === 1)
      }
      for (const row of db.prepare('SELECT list, subject, key FROM access_list').all()) {
        this.accessSet(row.list as AccessList, row.subject as AccessSubject).add(String(row.key))
      }
      this.cleanup = setInterval(() => {
        // A failed sweep (e.g. database busy) must not escape as an uncaught exception and stop the process;
        // expired rows are also removed lazily on read, so the next sweep can simply retry.
        try {
          db.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?').run(Date.now())
        } catch (error) {
          this.logger?.warn({ err: error }, 'Expired KV sweep failed')
        }
      }, 60_000)
      this.cleanup.unref()
    } catch (error) {
      db.close()
      this.database = undefined
      throw error
    }
  }

  close(): void {
    if (this.cleanup) clearInterval(this.cleanup)
    this.cleanup = undefined
    this.database?.close()
    this.database = undefined
    this.groups.clear()
    this.accessEntries.clear()
  }

  migrate(owner: string, steps: string[]): void {
    const db = this.db
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT version FROM migrations WHERE plugin = ?').get(owner)
      const version = row === undefined ? 0 : Number(row.version)
      const tables = (): Set<string> =>
        new Set(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
            )
            .all()
            .map((item) => String(item.name)),
        )
      const changes: { name: string; added: boolean }[] = []
      for (let index = version; index < steps.length; index++) {
        const before = tables()
        db.exec(steps[index] as string)
        const after = tables()
        for (const name of before) if (!after.has(name)) changes.push({ name, added: false })
        for (const name of after) if (!before.has(name)) changes.push({ name, added: true })
        if (after.has('plugin_tables')) {
          for (const change of changes.splice(0)) {
            if (change.added)
              db.prepare('INSERT INTO plugin_tables (plugin, table_name) VALUES (?, ?)').run(
                owner,
                change.name,
              )
            else db.prepare('DELETE FROM plugin_tables WHERE table_name = ?').run(change.name)
          }
        }
      }
      if (steps.length > version) {
        db.prepare(
          'INSERT INTO migrations VALUES (?, ?) ON CONFLICT(plugin) DO UPDATE SET version = excluded.version',
        ).run(owner, steps.length)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  store(owner: string, assertActive: () => void = () => {}): KVStore {
    return new KVStore(this, owner, assertActive)
  }

  setGroupEnabled(owner: string, groupKey: string, enabled: boolean): void {
    this.db
      .prepare(
        'INSERT INTO plugin_group_state VALUES (?, ?, ?) ON CONFLICT(plugin, group_key) DO UPDATE SET enabled = excluded.enabled',
      )
      .run(owner, groupKey, enabled ? 1 : 0)
    this.groups.set(JSON.stringify([owner, groupKey]), enabled)
  }

  isGroupEnabled(owner: string, groupKey: string): boolean {
    return this.groups.get(JSON.stringify([owner, groupKey])) !== false
  }

  listGroups(owner: string): { groupKey: string; enabled: boolean }[] {
    return this.db
      .prepare('SELECT group_key, enabled FROM plugin_group_state WHERE plugin = ? ORDER BY group_key')
      .all(owner)
      .map((row) => ({ groupKey: String(row.group_key), enabled: row.enabled === 1 }))
  }

  purgePlugin(owner: string): void {
    const db = this.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('PRAGMA defer_foreign_keys = ON')
      for (const table of ['kv', 'migrations', 'plugin_group_state']) {
        db.prepare(`DELETE FROM ${table} WHERE plugin = ?`).run(owner)
      }
      for (const row of db.prepare('SELECT table_name FROM plugin_tables WHERE plugin = ?').all(owner)) {
        const name = String(row.table_name)
        db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`)
      }
      db.prepare('DELETE FROM plugin_tables WHERE plugin = ?').run(owner)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    for (const key of this.groups.keys()) {
      if ((JSON.parse(key) as string[])[0] === owner) this.groups.delete(key)
    }
  }

  allows(event: DispatchEvent): boolean {
    const userId = 'userId' in event ? event.userId : undefined
    const groupId = 'groupId' in event ? event.groupId : undefined
    const userKey = userId === undefined ? undefined : `${event.platform}:${userId}`
    const groupKey = groupId === undefined ? undefined : `${event.platform}:${groupId}`
    if (userKey && this.accessSet('block', 'user').has(userKey)) return false
    if (groupKey && this.accessSet('block', 'group').has(groupKey)) return false
    const users = this.accessSet('allow', 'user')
    const groups = this.accessSet('allow', 'group')
    if (userKey && users.size > 0 && !users.has(userKey)) return false
    if (groupKey && groups.size > 0 && !groups.has(groupKey)) return false
    return true
  }

  private accessSet(list: AccessList, subject: AccessSubject): Set<string> {
    const key = `${list}:${subject}`
    let entries = this.accessEntries.get(key)
    if (!entries) {
      entries = new Set()
      this.accessEntries.set(key, entries)
    }
    return entries
  }
}

export class KVStore {
  private readonly storage: Storage
  private readonly owner: string
  private readonly assertActive: () => void

  constructor(storage: Storage, owner: string, assertActive: () => void) {
    this.storage = storage
    this.owner = owner
    this.assertActive = assertActive
  }

  get<T>(key: string): T | undefined {
    this.assertActive()
    const row = this.storage.db
      .prepare('SELECT value, expires_at FROM kv WHERE plugin = ? AND key = ?')
      .get(this.owner, key)
    if (!row) return undefined
    if (row.expires_at !== null && Number(row.expires_at) <= Date.now()) {
      this.delete(key)
      return undefined
    }
    return JSON.parse(String(row.value)) as T
  }

  set(key: string, value: unknown, options: { ttl?: string | number } = {}): void {
    this.assertActive()
    const json = JSON.stringify(value)
    if (json === undefined) throw new TypeError('KV value must be JSON serializable')
    const expires = options.ttl === undefined ? null : Date.now() + parseDuration(options.ttl)
    this.storage.db
      .prepare(
        'INSERT INTO kv VALUES (?, ?, ?, ?) ON CONFLICT(plugin, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
      )
      .run(this.owner, key, json, expires)
  }

  delete(key: string): void {
    this.assertActive()
    this.storage.db.prepare('DELETE FROM kv WHERE plugin = ? AND key = ?').run(this.owner, key)
  }

  keys(prefix = ''): string[] {
    this.assertActive()
    this.storage.db
      .prepare('DELETE FROM kv WHERE plugin = ? AND expires_at IS NOT NULL AND expires_at <= ?')
      .run(this.owner, Date.now())
    return this.storage.db
      .prepare('SELECT key FROM kv WHERE plugin = ? ORDER BY key')
      .all(this.owner)
      .map((row) => String(row.key))
      .filter((key) => key.startsWith(prefix))
  }
}
