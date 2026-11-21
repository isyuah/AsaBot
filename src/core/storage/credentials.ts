import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { PluginError } from '../errors.ts'
import type { PluginCredentialInfo, PluginCredentialValue } from '../plugin/credentials.ts'
import { constantTimeEqual } from '../utils/security.ts'

export class CredentialUnavailableError extends PluginError {
  constructor(cause?: unknown) {
    super('无法解密插件凭据，请检查凭据主密钥和数据库备份', { cause })
  }
}

export class DuplicateCredentialError extends PluginError {
  constructor() {
    super('这个用途下已存在相同的凭据')
  }
}

const metadata = 'id, purpose, label, created_at, retired'
const nonceSize = 12
const tagSize = 16

function credentialInfo(row: Record<string, SQLOutputValue>): PluginCredentialInfo {
  return {
    id: String(row.id),
    group: String(row.purpose),
    label: String(row.label),
    createdAt: Number(row.created_at),
    active: row.retired === 0,
  }
}

const aad = (plugin: string, group: string, id: string) => Buffer.from(JSON.stringify([plugin, group, id]))

function decrypt(row: Record<string, SQLOutputValue>, key: Buffer): string {
  try {
    if (!(row.ciphertext instanceof Uint8Array)) throw new TypeError('Expected encrypted credential bytes')
    const bytes = row.ciphertext
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, nonceSize), {
      authTagLength: tagSize,
    })
    decipher.setAAD(aad(String(row.plugin), String(row.purpose), String(row.id)))
    decipher.setAuthTag(bytes.subarray(nonceSize, nonceSize + tagSize))
    return Buffer.concat([decipher.update(bytes.subarray(nonceSize + tagSize)), decipher.final()]).toString(
      'utf8',
    )
  } catch (error) {
    throw new CredentialUnavailableError(error)
  }
}

export class CredentialStore {
  private readonly database: () => DatabaseSync
  private readonly keyFile: string

  constructor(database: () => DatabaseSync, dataDir: string) {
    this.database = database
    this.keyFile = join(dataDir, 'plugin-credentials.key')
  }

  has(plugin: string): boolean {
    return (
      this.database().prepare('SELECT 1 FROM plugin_credentials WHERE plugin = ? LIMIT 1').get(plugin) !==
      undefined
    )
  }

  list(
    plugin: string,
    { group, activeOnly = false }: { group?: string; activeOnly?: boolean } = {},
  ): PluginCredentialInfo[] {
    return this.database()
      .prepare(
        `SELECT ${metadata} FROM plugin_credentials WHERE plugin = ?${group === undefined ? '' : ' AND purpose = ?'}${activeOnly ? ' AND retired = 0' : ''} ORDER BY created_at DESC, id`,
      )
      .all(plugin, ...(group === undefined ? [] : [group]))
      .map(credentialInfo)
  }

  read(plugin: string, id: string): string | undefined {
    const row = this.database()
      .prepare('SELECT * FROM plugin_credentials WHERE plugin = ? AND id = ?')
      .get(plugin, id)
    return row && decrypt(row, this.readKey(false))
  }

  readAll(plugin: string, group: string): PluginCredentialValue[] {
    const rows = this.database()
      .prepare(
        'SELECT * FROM plugin_credentials WHERE plugin = ? AND purpose = ? AND retired = 0 ORDER BY created_at DESC, id',
      )
      .all(plugin, group)
    if (!rows.length) return []
    const key = this.readKey(false)
    return rows.map((row) => ({ ...credentialInfo(row), value: decrypt(row, key) }))
  }

  create(
    plugin: string,
    group: string,
    label: string,
    value = randomBytes(32).toString('base64url'),
  ): PluginCredentialInfo {
    const db = this.database()
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = db.prepare('SELECT * FROM plugin_credentials LIMIT 1').get()
      const key = this.readKey(existing === undefined)
      // A replaced key may still have the right size. Authenticate existing ciphertext before accepting it.
      if (existing) decrypt(existing, key)
      for (const row of db
        .prepare('SELECT * FROM plugin_credentials WHERE plugin = ? AND purpose = ?')
        .iterate(plugin, group)) {
        if (constantTimeEqual(value, decrypt(row, key))) throw new DuplicateCredentialError()
      }
      const id = randomUUID()
      const createdAt = Date.now()
      const nonce = randomBytes(nonceSize)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(aad(plugin, group, id))
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      const ciphertext = Buffer.concat([nonce, cipher.getAuthTag(), bytes])
      db.prepare(
        'INSERT INTO plugin_credentials (id, plugin, purpose, label, created_at, ciphertext) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, plugin, group, label, createdAt, ciphertext)
      db.exec('COMMIT')
      return { id, group, label, createdAt, active: true }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  revoke(plugin: string, id: string): boolean {
    return (
      this.database().prepare('DELETE FROM plugin_credentials WHERE plugin = ? AND id = ?').run(plugin, id)
        .changes !== 0
    )
  }

  retireMissingGroups(plugin: string, groups: string[]): void {
    this.database()
      .prepare(
        'UPDATE plugin_credentials SET retired = 1 WHERE plugin = ? AND retired = 0 AND purpose NOT IN (SELECT value FROM json_each(?))',
      )
      .run(plugin, JSON.stringify(groups))
  }

  private readKey(allowCreate: boolean): Buffer {
    try {
      const key = readFileSync(this.keyFile)
      if (key.length !== 32) throw new CredentialUnavailableError()
      return key
    } catch (error) {
      if (error instanceof CredentialUnavailableError) throw error
      if (!allowCreate || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new CredentialUnavailableError(error)
      try {
        writeFileSync(this.keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 })
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new CredentialUnavailableError(writeError)
      }
      return this.readKey(false)
    }
  }
}
