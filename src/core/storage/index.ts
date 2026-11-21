import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Logger } from 'pino'
import type { DispatchEvent } from '../dispatch/types.ts'
import { parseDuration } from '../utils/duration.ts'
import { CredentialStore } from './credentials.ts'

/** 访问控制列表类型：黑名单或白名单。 */
export type AccessList = 'block' | 'allow'
/** 访问控制对象类型：用户或群。 */
export type AccessSubject = 'user' | 'group'
/** 一条用户或群访问控制记录。 */
export interface AccessEntry {
  list: AccessList
  subject: AccessSubject
  key: string
}

export interface GroupRuleSummary {
  groupKey: string
  plugins: number
  configs: number
  commands: number
}

type Migration = string | ((db: DatabaseSync) => void)

const coreMigrations: Migration[] = [
  `CREATE TABLE kv (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER,
    PRIMARY KEY (plugin, key));
   CREATE TABLE plugin_group_state (plugin TEXT NOT NULL, group_key TEXT NOT NULL, enabled INTEGER NOT NULL,
    PRIMARY KEY (plugin, group_key));
   CREATE TABLE access_list (list TEXT NOT NULL, subject TEXT NOT NULL, key TEXT NOT NULL,
    PRIMARY KEY (list, subject, key));`,
  `CREATE TABLE plugin_tables (plugin TEXT NOT NULL, table_name TEXT PRIMARY KEY);`,
  `CREATE TABLE scheduled_tasks (plugin TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL,
    run_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (plugin, name, key));`,
  `CREATE TABLE plugin_group_config (plugin TEXT NOT NULL, group_key TEXT NOT NULL, config TEXT NOT NULL,
    PRIMARY KEY (plugin, group_key));
   CREATE TABLE command_group_state (command TEXT NOT NULL, group_key TEXT NOT NULL, enabled INTEGER NOT NULL,
    PRIMARY KEY (command, group_key));`,
  `CREATE TABLE tasks (
     id TEXT PRIMARY KEY, plugin TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL,
     payload TEXT NOT NULL, state TEXT NOT NULL, run_at INTEGER NOT NULL, next_run_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
     attempt INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
     policy TEXT NOT NULL, error TEXT, cancel_reason TEXT
   );
   CREATE INDEX tasks_due ON tasks(state, next_run_at);
   CREATE INDEX tasks_key ON tasks(plugin, name, key, created_at DESC);
   CREATE TABLE task_attempts (
     id TEXT PRIMARY KEY, task_id TEXT NOT NULL, plugin TEXT NOT NULL, attempt INTEGER NOT NULL,
     started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT NOT NULL, error TEXT,
     UNIQUE(task_id, attempt)
   );
   CREATE INDEX task_attempts_task ON task_attempts(task_id, attempt);
   INSERT INTO tasks (id, plugin, name, key, payload, state, run_at, next_run_at, created_at, updated_at, policy)
     SELECT lower(hex(randomblob(16))), plugin, name, key, payload, 'pending', run_at, run_at,
       CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER),
       '{"maxRetries":0,"delay":5000,"maxDelay":300000}' FROM scheduled_tasks;
   DROP TABLE scheduled_tasks;`,
  `CREATE TABLE bot_admins (bot_key TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (bot_key, user_id));
   CREATE TABLE plugin_bot_policy (bot_key TEXT NOT NULL, plugin TEXT NOT NULL, enabled INTEGER, config TEXT, PRIMARY KEY (bot_key, plugin));`,
  (db) => {
    // NULL marks previously known accounts whose old defaults are captured once plugins are discovered.
    db.exec(`CREATE TABLE bot_plugin_defaults (bot_key TEXT NOT NULL PRIMARY KEY, plugins TEXT);
      INSERT INTO bot_plugin_defaults (bot_key)
        SELECT bot_key FROM bot_admins UNION SELECT bot_key FROM plugin_bot_policy;`)
    if (
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'p_history_messages'").get()
    ) {
      db.exec(`INSERT OR IGNORE INTO bot_plugin_defaults (bot_key)
        SELECT DISTINCT json_array(platform, self_id) FROM p_history_messages WHERE platform <> 'virtual'`)
    }
  },
  `CREATE TABLE bot_accounts (
     bot_key TEXT PRIMARY KEY, nickname TEXT, avatar TEXT, capabilities TEXT,
     connection TEXT, connection_id TEXT, binding_key TEXT, last_online_at INTEGER
   );
   CREATE INDEX bot_accounts_connection ON bot_accounts(connection_id);
   INSERT INTO bot_accounts (bot_key)
     SELECT bot_key FROM bot_plugin_defaults WHERE json_extract(bot_key, '$[0]') <> 'virtual';`,
  `ALTER TABLE tasks ADD COLUMN delivery_failure TEXT;
   ALTER TABLE task_attempts ADD COLUMN delivery_failure TEXT;`,
  `CREATE TABLE plugin_credentials (
     id TEXT PRIMARY KEY, plugin TEXT NOT NULL, purpose TEXT NOT NULL, label TEXT NOT NULL,
     created_at INTEGER NOT NULL, ciphertext BLOB NOT NULL, retired INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX plugin_credentials_purpose ON plugin_credentials(plugin, purpose, retired);`,
]

/** SQLite 存储及插件状态、迁移和访问控制管理器。 */
export class Storage {
  private database?: DatabaseSync
  private cleanup?: NodeJS.Timeout
  private readonly dataDir: string
  private readonly logger: Logger | undefined
  private readonly groups = new Map<string, boolean>()
  private readonly commandGroups = new Map<string, boolean>()
  private readonly accessEntries = new Map<string, Set<string>>()
  readonly credentials: CredentialStore
  readonly access: {
    add: (list: AccessList, subject: AccessSubject, key: string) => void
    remove: (list: AccessList, subject: AccessSubject, key: string) => void
    list: (list?: AccessList, subject?: AccessSubject) => AccessEntry[]
  }

  constructor(dataDir: string, logger?: Logger) {
    this.dataDir = dataDir
    this.logger = logger
    this.credentials = new CredentialStore(() => this.db, dataDir)
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
      for (const row of db.prepare('SELECT command, group_key, enabled FROM command_group_state').all()) {
        this.commandGroups.set(JSON.stringify([row.command, row.group_key]), row.enabled === 1)
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
    this.commandGroups.clear()
    this.accessEntries.clear()
  }

  migrate(owner: string, steps: Migration[]): void {
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
        const step = steps[index] as Migration
        if (typeof step === 'string') db.exec(step)
        else step(db)
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

  listGroups(owner: string): { groupKey: string; enabled?: boolean; config?: Record<string, unknown> }[] {
    const groups = this.db
      .prepare('SELECT group_key, enabled FROM plugin_group_state WHERE plugin = ? ORDER BY group_key')
      .all(owner)
      .map((row) => ({ groupKey: String(row.group_key), enabled: row.enabled === 1 }))
    const result: Map<string, { groupKey: string; enabled?: boolean; config?: Record<string, unknown> }> =
      new Map(groups.map((group) => [group.groupKey, group]))
    for (const row of this.db
      .prepare('SELECT group_key, config FROM plugin_group_config WHERE plugin = ?')
      .all(owner)) {
      const groupKey = String(row.group_key)
      const group = result.get(groupKey) ?? { groupKey }
      group.config = JSON.parse(String(row.config)) as Record<string, unknown>
      result.set(groupKey, group)
    }
    return [...result.values()].sort((a, b) => a.groupKey.localeCompare(b.groupKey))
  }

  getGroupConfig(owner: string, groupKey: string): Record<string, unknown> | undefined {
    const row = this.db
      .prepare('SELECT config FROM plugin_group_config WHERE plugin = ? AND group_key = ?')
      .get(owner, groupKey)
    return row ? (JSON.parse(String(row.config)) as Record<string, unknown>) : undefined
  }

  setGroupConfig(owner: string, groupKey: string, config: Record<string, unknown> | null): void {
    if (config === null)
      this.db
        .prepare('DELETE FROM plugin_group_config WHERE plugin = ? AND group_key = ?')
        .run(owner, groupKey)
    else
      this.db
        .prepare(
          'INSERT INTO plugin_group_config VALUES (?, ?, ?) ON CONFLICT(plugin, group_key) DO UPDATE SET config = excluded.config',
        )
        .run(owner, groupKey, JSON.stringify(config))
  }

  setCommandGroupEnabled(command: string, groupKey: string, enabled: boolean): void {
    this.db
      .prepare(
        'INSERT INTO command_group_state VALUES (?, ?, ?) ON CONFLICT(command, group_key) DO UPDATE SET enabled = excluded.enabled',
      )
      .run(command, groupKey, enabled ? 1 : 0)
    this.commandGroups.set(JSON.stringify([command, groupKey]), enabled)
  }

  isCommandGroupEnabled(command: string, groupKey: string): boolean {
    return this.commandGroups.get(JSON.stringify([command, groupKey])) !== false
  }

  disabledCommandGroups(command: string): string[] {
    return [...this.commandGroups]
      .filter(([key, enabled]) => !enabled && (JSON.parse(key) as string[])[0] === command)
      .map(([key]) => (JSON.parse(key) as string[])[1] as string)
      .sort()
  }

  groupRuleSummaries(): GroupRuleSummary[] {
    const result = new Map<string, GroupRuleSummary>()
    const add = (groupKey: string, field: 'plugins' | 'configs' | 'commands'): void => {
      const current = result.get(groupKey) ?? { groupKey, plugins: 0, configs: 0, commands: 0 }
      current[field] += 1
      result.set(groupKey, current)
    }
    for (const row of this.db.prepare('SELECT group_key FROM plugin_group_state').all())
      add(String(row.group_key), 'plugins')
    for (const row of this.db.prepare('SELECT group_key FROM plugin_group_config').all())
      add(String(row.group_key), 'configs')
    for (const row of this.db.prepare('SELECT group_key FROM command_group_state').all())
      add(String(row.group_key), 'commands')
    return [...result.values()].sort((a, b) => a.groupKey.localeCompare(b.groupKey))
  }

  groupAccess(groupKey: string): AccessList | undefined {
    if (this.accessSet('block', 'group').has(groupKey)) return 'block'
    if (this.accessSet('allow', 'group').has(groupKey)) return 'allow'
    return undefined
  }

  purgePlugin(owner: string): void {
    const db = this.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('PRAGMA defer_foreign_keys = ON')
      for (const table of [
        'kv',
        'migrations',
        'plugin_group_state',
        'plugin_group_config',
        'plugin_bot_policy',
        'plugin_credentials',
        'task_attempts',
        'tasks',
      ]) {
        db.prepare(`DELETE FROM ${table} WHERE plugin = ?`).run(owner)
      }
      db.prepare(`UPDATE bot_plugin_defaults
        SET plugins = (SELECT json_group_array(value) FROM json_each(plugins) WHERE value <> ?)
        WHERE EXISTS (SELECT 1 FROM json_each(plugins) WHERE value = ?)`).run(owner, owner)
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

/** 按插件隔离、支持可选过期时间的 JSON 键值存储。 */
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
