import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite'
import type { Target } from './catalog.ts'
import {
  type AiUsage,
  type FinishedState,
  type QueryFilters,
  type RequestDetail,
  type RequestPage,
  type RequestRecord,
  type UsageGroup,
  type UsageReport,
  type UsageTotals,
  usageFields,
} from './contracts.ts'
import { AiError } from './errors.ts'
import { dayMs, utcDay } from './schema.ts'

type Row = Record<string, SQLOutputValue>
type RequestStart = Pick<
  RequestRecord,
  'id' | 'source' | 'capability' | 'mode' | 'startedAt' | 'eventId' | 'platform' | 'selfId'
>
type RequestFinish = {
  status: FinishedState
  durationMs?: number
  upstreamModel?: string
  error?: AiError
  usage?: AiUsage
}

const metrics = usageFields.map((field) => ({ field, sum: `${field}_sum`, count: `${field}_count` }))
const dailyKeys = 'day, source, channel_id, model_id, capability, status'
const metricColumns = metrics.flatMap(({ sum, count }) => [sum, count])
const totalColumns = ['requests', 'billed_successes', 'duration_sum', 'duration_count', ...metricColumns]

export const auditMigration = `CREATE TABLE p_ai_requests (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
  capability TEXT NOT NULL, mode TEXT NOT NULL, started_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'running',
  channel_id TEXT, channel_name TEXT, model_id TEXT, model_name TEXT, protocol TEXT, upstream_model TEXT,
  event_id TEXT, platform TEXT, self_id TEXT, duration_ms REAL, error TEXT, usage TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX p_ai_requests_time ON p_ai_requests(started_at);
CREATE INDEX p_ai_requests_source_seq ON p_ai_requests(source, seq DESC);
CREATE INDEX p_ai_requests_channel_seq ON p_ai_requests(channel_id, seq DESC);
CREATE INDEX p_ai_requests_model_seq ON p_ai_requests(model_id, seq DESC);
CREATE INDEX p_ai_requests_status ON p_ai_requests(status);
CREATE TABLE p_ai_content (
  id TEXT PRIMARY KEY REFERENCES p_ai_requests(id) ON DELETE CASCADE, input TEXT, output TEXT, expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX p_ai_content_expires ON p_ai_content(expires_at);
CREATE TABLE p_ai_daily (
  day TEXT NOT NULL, source TEXT NOT NULL, channel_id TEXT NOT NULL, model_id TEXT NOT NULL,
  capability TEXT NOT NULL, status TEXT NOT NULL, channel_name TEXT NOT NULL, model_name TEXT NOT NULL,
  requests INTEGER NOT NULL, billed_successes INTEGER NOT NULL, duration_sum REAL NOT NULL, duration_count INTEGER NOT NULL,
  ${metrics.map(({ sum, count }) => `${sum} REAL NOT NULL, ${count} INTEGER NOT NULL`).join(', ')},
  PRIMARY KEY (${dailyKeys})
) STRICT, WITHOUT ROWID;`

const upsertDay = `INSERT INTO p_ai_daily (${dailyKeys}, channel_name, model_name, ${totalColumns.join(', ')})
  VALUES (${Array.from({ length: 8 + totalColumns.length }, () => '?').join(', ')})
  ON CONFLICT(${dailyKeys}) DO UPDATE SET channel_name = excluded.channel_name, model_name = excluded.model_name,
  ${totalColumns.map((key) => `${key} = ${key} + excluded.${key}`).join(', ')}`

const totalsSql = totalColumns.map((key) => `SUM(${key}) AS ${key}`).join(', ')
const dimensionColumns = {
  source: 'source',
  channel: 'channel_id',
  model: 'model_id',
  capability: 'capability',
} as const

function optionalText(value: SQLOutputValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function record(row: Row): RequestRecord {
  return {
    id: String(row.id),
    source: String(row.source),
    startedAt: Number(row.started_at),
    capability: row.capability as RequestRecord['capability'],
    mode: row.mode as RequestRecord['mode'],
    status: row.status as RequestRecord['status'],
    durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : undefined,
    channelId: optionalText(row.channel_id),
    channelName: optionalText(row.channel_name),
    modelId: optionalText(row.model_id),
    modelName: optionalText(row.model_name),
    protocol: optionalText(row.protocol) as RequestRecord['protocol'],
    upstreamModel: optionalText(row.upstream_model),
    eventId: optionalText(row.event_id),
    platform: optionalText(row.platform),
    selfId: optionalText(row.self_id),
    error: typeof row.error === 'string' ? JSON.parse(row.error) : undefined,
    usage: JSON.parse(String(row.usage)),
  }
}

function totals(row: Row): UsageTotals {
  const durationCount = Number(row.duration_count)
  return {
    requests: Number(row.requests),
    succeeded: Number(row.billed_successes),
    averageMs: durationCount ? Number(row.duration_sum) / durationCount : null,
    usage: Object.fromEntries(
      metrics.flatMap(({ field, sum, count }) =>
        Number(row[count]) ? [[field, { value: Number(row[sum]), reported: Number(row[count]) }]] : [],
      ),
    ),
  }
}

function filters(
  query: QueryFilters,
  extra: [string, SQLInputValue][],
): { where: string; params: SQLInputValue[] } {
  const clauses = [...extra]
  if (query.source !== undefined) clauses.push(['source = ?', query.source])
  if (query.channelId !== undefined) clauses.push(['channel_id = ?', query.channelId])
  if (query.modelId !== undefined) clauses.push(['model_id = ?', query.modelId])
  if (query.capability !== undefined) clauses.push(['capability = ?', query.capability])
  if (query.status !== undefined) clauses.push(['status = ?', query.status])
  return {
    where: clauses.length ? `WHERE ${clauses.map(([clause]) => clause).join(' AND ')}` : '',
    params: clauses.map(([, value]) => value),
  }
}

export class Audit {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  begin(entry: RequestStart): void {
    this.db
      .prepare(`INSERT INTO p_ai_requests (id, source, capability, mode, started_at, event_id, platform, self_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.id,
        entry.source,
        entry.capability,
        entry.mode,
        entry.startedAt,
        entry.eventId ?? null,
        entry.platform ?? null,
        entry.selfId ?? null,
      )
  }

  target(id: string, { model, channel }: Target): void {
    this.db
      .prepare(`UPDATE p_ai_requests SET channel_id = ?, channel_name = ?, model_id = ?, model_name = ?,
      protocol = ?, upstream_model = ? WHERE id = ?`)
      .run(channel.id, channel.name, model.id, model.name, channel.protocol, model.upstreamModel, id)
  }

  content(id: string, column: 'input' | 'output', text: string, expiresAt: number): void {
    this.db
      .prepare(`INSERT INTO p_ai_content (id, ${column}, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET ${column} = excluded.${column}`)
      .run(id, text, expiresAt)
  }

  finish(id: string, end: RequestFinish): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const { error, durationMs, status, upstreamModel, usage = {} } = end
      const row = this.db
        .prepare(`UPDATE p_ai_requests SET status = ?, duration_ms = ?,
        upstream_model = coalesce(?, upstream_model), error = ?, usage = ?
        WHERE id = ? AND status = 'running' RETURNING *`)
        .get(
          status,
          durationMs ?? null,
          upstreamModel ?? null,
          error
            ? JSON.stringify({ code: error.code, message: error.message, httpStatus: error.httpStatus })
            : null,
          JSON.stringify(usage),
          id,
        )
      if (row) this.aggregate(record(row), status)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private aggregate(entry: RequestRecord, status: FinishedState): void {
    this.db
      .prepare(upsertDay)
      .run(
        utcDay(entry.startedAt),
        entry.source,
        entry.channelId ?? '',
        entry.modelId ?? '',
        entry.capability,
        status,
        entry.channelName ?? '',
        entry.modelName ?? '',
        1,
        Number(status === 'succeeded'),
        entry.durationMs ?? 0,
        Number(entry.durationMs !== undefined),
        ...metrics.flatMap(({ field }) => [
          entry.usage[field] ?? 0,
          Number(entry.usage[field] !== undefined),
        ]),
      )
  }

  recover(): void {
    for (const row of this.db.prepare("SELECT id FROM p_ai_requests WHERE status = 'running'").all())
      this.finish(String(row.id), { status: 'interrupted', error: new AiError('INTERRUPTED') })
  }

  cleanup(now = Date.now()): void {
    this.db.prepare('DELETE FROM p_ai_content WHERE expires_at <= ?').run(now)
    this.db
      .prepare("DELETE FROM p_ai_requests WHERE started_at < ? AND status <> 'running'")
      .run(now - 30 * dayMs)
  }

  list(query: QueryFilters & { before?: number; limit: number }): RequestPage {
    const extra: [string, SQLInputValue][] = []
    if (query.before !== undefined) extra.push(['seq < ?', query.before])
    if (query.from !== undefined) extra.push(['started_at >= ?', Date.parse(query.from)])
    if (query.to !== undefined) extra.push(['started_at < ?', Date.parse(query.to) + dayMs])
    const { where, params } = filters(query, extra)
    const rows = this.db
      .prepare(`SELECT * FROM p_ai_requests ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...params, query.limit + 1)
    const items = rows.slice(0, query.limit)
    return {
      items: items.map(record),
      next: rows.length > query.limit ? Number(items.at(-1)?.seq) : undefined,
    }
  }

  detail(id: string, now = Date.now()): RequestDetail {
    const row = this.db.prepare('SELECT * FROM p_ai_requests WHERE id = ?').get(id)
    if (!row) throw new AiError('NOT_FOUND')
    const content = this.db.prepare('SELECT * FROM p_ai_content WHERE id = ? AND expires_at > ?').get(id, now)
    return {
      ...record(row),
      content: content
        ? {
            input: optionalText(content.input),
            output: optionalText(content.output),
            expiresAt: Number(content.expires_at),
          }
        : undefined,
    }
  }

  usage(query: QueryFilters & { groupBy: UsageGroup }, now = Date.now()): UsageReport {
    const to = query.to ?? utcDay(now)
    const from = query.from ?? utcDay(Date.parse(to) - 6 * dayMs)
    if (from > to || Date.parse(to) - Date.parse(from) > 365 * dayMs)
      throw new AiError('INVALID_INPUT', { message: '统计区间不能超过 366 天' })
    const { where, params } = filters(query, [
      ['day >= ?', from],
      ['day <= ?', to],
    ])
    const table = `FROM p_ai_daily ${where}`
    const dayRows = this.db.prepare(`SELECT day, ${totalsSql} ${table} GROUP BY day`).all(...params)
    const byDay = new Map(dayRows.map((row) => [String(row.day), totals(row)]))
    const daily: UsageReport['daily'] = []
    for (let time = Date.parse(from); time <= Date.parse(to); time += dayMs) {
      const day = utcDay(time)
      daily.push({ day, ...(byDay.get(day) ?? { requests: 0, succeeded: 0, averageMs: null, usage: {} }) })
    }
    const dimension = dimensionColumns[query.groupBy]
    const label =
      query.groupBy === 'model' || query.groupBy === 'channel'
        ? `coalesce((SELECT name FROM p_ai_${query.groupBy === 'model' ? 'models' : 'channels'} WHERE id = grouped.key), grouped.snapshot)`
        : 'grouped.key'
    const snapshot =
      query.groupBy === 'model' ? 'max(model_name)' : query.groupBy === 'channel' ? 'max(channel_name)' : "''"
    const groupRows = this.db
      .prepare(`SELECT grouped.*, ${label} AS label FROM
      (SELECT ${dimension} AS key, ${snapshot} AS snapshot, ${totalsSql} ${table}
        GROUP BY ${dimension} ORDER BY requests DESC, key LIMIT 101) grouped`)
      .all(...params)
    const total = this.db
      .prepare(`SELECT ${totalsSql} ${table}`)
      .all(...params)
      .map(totals)[0]
    if (total === undefined) throw new Error('Missing AI usage aggregation row')
    return {
      from,
      to,
      total,
      daily,
      groups: groupRows
        .slice(0, 100)
        .map((row) => ({ key: String(row.key), name: String(row.label), ...totals(row) })),
      moreGroups: groupRows.length > 100,
    }
  }
}

const sensitive = /token|password|secret|authorization|credential|api[_-]?key|private[_-]?key|^_auth$/i

export function capturedText(value: unknown, key: string | undefined): string {
  const redact = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') {
      return (key ? item.replaceAll(key, '[已隐藏]') : item)
        .replace(/\bBearer\s+[\w.~+/-]+=*/gi, 'Bearer [已隐藏]')
        .replace(/\b(?:sk|AIza)[\w-]{12,}/g, '[已隐藏]')
        .replace(
          /([\w-]*(?:token|password|secret)|authorization|credential|api[_-]?key|private[_-]?key)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+|$)/gi,
          '$1=[已隐藏]',
        )
        .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, '[已省略二进制]')
        .slice(0, 16_000)
    }
    if (depth > 10) return '[已截断]'
    if (item instanceof Uint8Array) return '[已省略媒体]'
    if (Array.isArray(item)) return item.slice(0, 100).map((child) => redact(child, depth + 1))
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .slice(0, 100)
          .map(([field, child]) => [
            String(redact(field, depth + 1)),
            sensitive.test(field) ? '[已隐藏]' : redact(child, depth + 1),
          ]),
      )
    return item
  }
  const text = JSON.stringify(redact(value, 0), null, 2)
  return text.length <= 16_000 ? text : `${text.slice(0, 16_000)}\n[已截断]`
}
