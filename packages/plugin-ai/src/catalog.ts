import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  type Capability,
  type CatalogView,
  type ChannelDraft,
  type ChannelSettings,
  type ChannelView,
  capabilities,
  type Defaults,
  type Feature,
  type ModelDraft,
  type ModelInfo,
  type ModelView,
  type Policy,
  protocolInfo,
} from './contracts.ts'
import { AiError } from './errors.ts'
import type { StoredCredential, Vault } from './vault.ts'

interface Channel extends ChannelSettings {
  id: string
  credential: StoredCredential
}

export interface Target {
  model: ModelView
  channel: Channel
}

type Row = Record<string, SQLOutputValue>
type Capture = NonNullable<CatalogView['capture']>
const emptyPolicy: Policy = { defaults: {}, allowlist: null }

export const catalogMigration = `CREATE TABLE p_ai_channels (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL, base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL, timeout_ms INTEGER NOT NULL, credential TEXT NOT NULL
) STRICT;
CREATE TABLE p_ai_models (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES p_ai_channels(id), name TEXT NOT NULL,
  upstream_model TEXT NOT NULL, enabled INTEGER NOT NULL, capabilities TEXT NOT NULL, UNIQUE(channel_id, upstream_model)
) STRICT;
CREATE TABLE p_ai_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE p_ai_policies (source TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`

function modelRow(row: Row): ModelView {
  return {
    id: String(row.id),
    name: String(row.name),
    channelId: String(row.channel_id),
    upstreamModel: String(row.upstream_model),
    enabled: row.enabled === 1,
    capabilities: JSON.parse(String(row.capabilities)),
  }
}

function channelRow(row: Row): Channel {
  return {
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    protocol: row.protocol as Channel['protocol'],
    timeoutMs: Number(row.timeout_ms),
    enabled: row.enabled === 1,
    credential: JSON.parse(String(row.credential)),
  }
}

export class Catalog {
  private readonly db: DatabaseSync
  private readonly vault: Vault

  constructor(db: DatabaseSync, vault: Vault) {
    this.db = db
    this.vault = vault
  }

  channel(id: string): Channel | undefined {
    const row = this.db.prepare('SELECT * FROM p_ai_channels WHERE id = ?').get(id)
    return row && channelRow(row)
  }

  private model(id: string): ModelView | undefined {
    const row = this.db.prepare('SELECT * FROM p_ai_models WHERE id = ?').get(id)
    return row && modelRow(row)
  }

  private view({ credential, ...channel }: Channel): ChannelView {
    return {
      ...channel,
      credential: { kind: credential.kind, status: this.vault.state(channel.id, credential) },
    }
  }

  secret(channel: Channel): string | undefined {
    return this.vault.resolve(channel.id, channel.credential)
  }

  snapshot(consumers: string[], now = Date.now()): CatalogView {
    const policies = this.policies()
    return {
      channels: this.db
        .prepare('SELECT * FROM p_ai_channels ORDER BY name, id')
        .all()
        .map((row) => this.view(channelRow(row))),
      models: this.db.prepare('SELECT * FROM p_ai_models ORDER BY name, id').all().map(modelRow),
      defaults: this.defaults(),
      policies,
      consumers: [...new Set([...consumers, ...Object.keys(policies)])].sort(),
      capture: this.capture(now),
    }
  }

  private policies(): Record<string, Policy> {
    return Object.fromEntries(
      this.db
        .prepare('SELECT * FROM p_ai_policies')
        .all()
        .map((row) => [String(row.source), JSON.parse(String(row.value))]),
    )
  }

  private policy(source: string): Policy {
    const row = this.db.prepare('SELECT value FROM p_ai_policies WHERE source = ?').get(source)
    return row ? JSON.parse(String(row.value)) : emptyPolicy
  }

  private setting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM p_ai_settings WHERE key = ?').get(key)
    return row && JSON.parse(String(row.value))
  }

  private setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO p_ai_settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value))
  }

  private defaults(): Defaults {
    return this.setting<Defaults>('defaults') ?? {}
  }

  private validateDefaults(defaults: Defaults, allowlist: string[] | null): void {
    for (const capability of capabilities) {
      const modelId = defaults[capability]
      if (!modelId) continue
      const model = this.model(modelId)
      if (!model) throw new AiError('MODEL_UNAVAILABLE')
      if (!model.capabilities.includes(capability)) throw new AiError('CAPABILITY_UNSUPPORTED')
      if (allowlist && !allowlist.includes(modelId)) throw new AiError('MODEL_FORBIDDEN')
    }
  }

  saveDefaults(defaults: Defaults): void {
    this.validateDefaults(defaults, null)
    this.setSetting('defaults', defaults)
  }

  savePolicy(source: string, input: Policy): void {
    const allowlist = input.allowlist === null ? null : [...new Set(input.allowlist)]
    if (allowlist?.some((modelId) => !this.model(modelId))) throw new AiError('MODEL_UNAVAILABLE')
    this.validateDefaults(input.defaults, allowlist)
    this.db
      .prepare(
        'INSERT INTO p_ai_policies VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET value = excluded.value',
      )
      .run(source, JSON.stringify({ defaults: input.defaults, allowlist }))
  }

  deletePolicy(source: string): void {
    this.db.prepare('DELETE FROM p_ai_policies WHERE source = ?').run(source)
  }

  capture(now: number): Capture | null {
    const capture = this.setting<Capture>('capture')
    return capture && capture.until > now ? capture : null
  }

  setCapture(source: string | null, now = Date.now()): Capture | null {
    if (source === null) {
      this.db.prepare("DELETE FROM p_ai_settings WHERE key = 'capture'").run()
      return null
    }
    const capture = { source, until: now + 30 * 60_000 }
    this.setSetting('capture', capture)
    return capture
  }

  saveChannel(input: ChannelDraft, id?: string): ChannelView {
    const previous = id === undefined ? undefined : this.channel(id)
    if (id !== undefined && !previous) throw new AiError('NOT_FOUND')
    if (previous && input.protocol !== previous.protocol) {
      const models = this.db
        .prepare('SELECT * FROM p_ai_models WHERE channel_id = ?')
        .all(previous.id)
        .map(modelRow)
      if (
        models.some((model) =>
          model.capabilities.some((item) => !protocolInfo[input.protocol].supports.includes(item)),
        )
      )
        throw new AiError('CONFLICT', { message: '已有模型的能力与新协议不兼容' })
    }
    if (
      previous &&
      previous.credential.kind !== 'none' &&
      input.credential === undefined &&
      (previous.protocol !== input.protocol ||
        new URL(previous.baseUrl).origin !== new URL(input.baseUrl).origin)
    )
      throw new AiError('CONFLICT', { message: '更改协议或服务器时，请重新配置密钥' })
    const channelId = id ?? randomUUID()
    const { credential, ...settings } = input
    const stored =
      credential === undefined
        ? (previous?.credential ?? { kind: 'none' })
        : this.vault.seal(
            channelId,
            credential,
            !this.db
              .prepare(
                "SELECT 1 FROM p_ai_channels WHERE json_extract(credential, '$.kind') = 'key' AND id <> ? LIMIT 1",
              )
              .get(channelId),
          )
    this.db
      .prepare(`INSERT INTO p_ai_channels VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, protocol = excluded.protocol, base_url = excluded.base_url, enabled = excluded.enabled,
      timeout_ms = excluded.timeout_ms, credential = excluded.credential`)
      .run(
        channelId,
        settings.name,
        settings.protocol,
        settings.baseUrl,
        Number(settings.enabled),
        settings.timeoutMs,
        JSON.stringify(stored),
      )
    return this.view({ id: channelId, ...settings, credential: stored })
  }

  deleteChannel(id: string): void {
    if (this.db.prepare('SELECT 1 FROM p_ai_models WHERE channel_id = ? LIMIT 1').get(id))
      throw new AiError('CONFLICT', { message: '请先移除此渠道下的模型' })
    if (!this.db.prepare('DELETE FROM p_ai_channels WHERE id = ?').run(id).changes)
      throw new AiError('NOT_FOUND')
  }

  saveModel(input: ModelDraft, id?: string): ModelView {
    const previous = id === undefined ? undefined : this.model(id)
    if (id !== undefined && !previous) throw new AiError('NOT_FOUND')
    if (previous && previous.channelId !== input.channelId)
      throw new AiError('CONFLICT', { message: '已有模型不能更换所属渠道，请在目标渠道新建模型' })
    const channel = this.channel(input.channelId)
    if (!channel) throw new AiError('NOT_FOUND')
    const supported = [...new Set(input.capabilities)]
    if (
      supported.some((item) => !protocolInfo[channel.protocol].supports.includes(item)) ||
      (!supported.includes('chat') && featuresFor(supported)) ||
      !capabilities.some((item) => supported.includes(item))
    )
      throw new AiError('CAPABILITY_UNSUPPORTED')
    if (previous) {
      const removed = capabilities.filter(
        (item) => previous.capabilities.includes(item) && !supported.includes(item),
      )
      if (
        removed.length &&
        [this.defaults(), ...Object.values(this.policies()).map((item) => item.defaults)].some((defaults) =>
          removed.some((item) => defaults[item] === previous.id),
        )
      )
        throw new AiError('CONFLICT', { message: '移除能力前，请先更改对应的默认模型' })
    }
    const modelId = id ?? randomUUID()
    if (
      this.db
        .prepare('SELECT 1 FROM p_ai_models WHERE channel_id = ? AND upstream_model = ? AND id <> ?')
        .get(input.channelId, input.upstreamModel, modelId)
    )
      throw new AiError('CONFLICT', { message: '此渠道已添加同名的上游模型' })
    this.db
      .prepare(`INSERT INTO p_ai_models VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, upstream_model = excluded.upstream_model, enabled = excluded.enabled, capabilities = excluded.capabilities`)
      .run(
        modelId,
        input.channelId,
        input.name,
        input.upstreamModel,
        Number(input.enabled),
        JSON.stringify(supported),
      )
    return { ...input, id: modelId, capabilities: supported }
  }

  deleteModel(id: string): void {
    if (
      Object.values(this.defaults()).includes(id) ||
      Object.values(this.policies()).some(
        (item) => item.allowlist?.includes(id) || Object.values(item.defaults).includes(id),
      )
    )
      throw new AiError('CONFLICT', { message: '请先从默认模型、指派和白名单中移除此模型' })
    if (!this.db.prepare('DELETE FROM p_ai_models WHERE id = ?').run(id).changes)
      throw new AiError('NOT_FOUND')
  }

  listModels(source: string, capability?: Capability | Feature): ModelInfo[] {
    const { allowlist } = this.policy(source)
    return this.db
      .prepare(`SELECT model.* FROM p_ai_models model JOIN p_ai_channels channel ON channel.id = model.channel_id
      WHERE model.enabled = 1 AND channel.enabled = 1 ORDER BY model.name, model.id`)
      .all()
      .map(modelRow)
      .filter(
        (model) =>
          (allowlist === null || allowlist.includes(model.id)) &&
          (!capability || model.capabilities.includes(capability)),
      )
      .map(({ id, name, capabilities }) => ({ id, name, capabilities }))
  }

  resolve(source: string, capability: Capability, modelId?: string): Target {
    const { allowlist, defaults } = this.policy(source)
    const selected = modelId ?? defaults[capability] ?? this.defaults()[capability]
    if (!selected) throw new AiError('MODEL_NOT_CONFIGURED')
    if (allowlist !== null && !allowlist.includes(selected)) throw new AiError('MODEL_FORBIDDEN')
    const model = this.model(selected)
    const channel = model && this.channel(model.channelId)
    if (!model?.enabled || !channel?.enabled) throw new AiError('MODEL_UNAVAILABLE')
    return { model, channel }
  }
}

function featuresFor(supported: (Capability | Feature)[]): boolean {
  return supported.some(
    (item) => item === 'vision' || item === 'stream' || item === 'tools' || item === 'structured',
  )
}
