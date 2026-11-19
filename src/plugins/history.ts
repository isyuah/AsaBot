import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { stream } from 'hono/streaming'
import { z } from 'zod'
import type { MessageThread } from '../core/bot.ts'
import { durationSchema } from '../core/config/schema.ts'
import type { DispatchTrace } from '../core/dispatch/trace.ts'
import type { Message } from '../core/message/index.ts'
import { plainText } from '../core/message/index.ts'
import { definePlugin } from '../core/plugin/definition.ts'
import { formatTarget, parseTarget, type Target } from '../core/target.ts'

/** 历史记录中的收发消息、会话及可选关联事件。 */
export interface HistoryMessage {
  id: number
  eventId?: string
  direction: 'in' | 'out'
  platform: string
  selfId: string
  channel: string
  target: Target
  userId?: string
  nickname?: string
  messageId?: string
  message: Message
  text: string
  time: number
}

/** 历史会话及其消息数和最近一条消息。 */
export interface HistoryChannel {
  channel: string
  platform: string
  selfId: string
  type: 'group' | 'private'
  id: string
  thread?: MessageThread
  count: number
  last: HistoryMessage
}

/** 按会话、用户、游标或文本筛选历史消息的条件。 */
export interface HistoryQuery {
  channel?: string
  userId?: string
  before?: number
  limit?: number
  q?: string
}

/** 查询历史消息和事件分发追踪的插件服务。 */
export interface HistoryService {
  query(options?: HistoryQuery): HistoryMessage[]
  trace(eventId: string): DispatchTrace | undefined
}

declare module '@asabot/core' {
  interface Services {
    history: HistoryService
  }
}

type Row = Record<string, unknown>

function historyMessage(row: Row): HistoryMessage {
  const channel = String(row.channel)
  return {
    id: Number(row.id),
    ...(row.event_id === null ? {} : { eventId: String(row.event_id) }),
    direction: row.direction as 'in' | 'out',
    platform: String(row.platform),
    selfId: String(row.self_id),
    channel,
    target: parseTarget(channel),
    ...(row.user_id === null ? {} : { userId: String(row.user_id) }),
    ...(row.nickname === null ? {} : { nickname: String(row.nickname) }),
    ...(row.message_id === null ? {} : { messageId: String(row.message_id) }),
    message: JSON.parse(String(row.message)) as Message,
    text: String(row.text),
    time: Number(row.time),
  }
}

function redactBase64(value: string): string {
  return value.replace(/base64:\/\/[A-Za-z0-9+/=]+/g, (data) =>
    data.length > 64 ? `${data.slice(0, 64)}… (length=${data.length})` : data,
  )
}

function messageJson(message: Message): string {
  return JSON.stringify(message, (_key, value: unknown) =>
    typeof value === 'string' ? redactBase64(value) : value,
  )
}

function selectMessages(
  db: DatabaseSync,
  options: HistoryQuery,
  order: 'id DESC' | 'time DESC, id DESC' | 'time ASC, id ASC',
  limit?: number,
): HistoryMessage[] {
  const conditions: string[] = []
  const values: SQLInputValue[] = []
  if (options.channel !== undefined) {
    conditions.push('channel = ?')
    values.push(options.channel)
  }
  if (options.userId !== undefined) {
    conditions.push('user_id = ?')
    values.push(options.userId)
  }
  if (options.before !== undefined) {
    conditions.push('id < ?')
    values.push(options.before)
  }
  if (options.q !== undefined) {
    conditions.push('instr(text, ?) > 0')
    values.push(options.q)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const clause = limit === undefined ? '' : 'LIMIT ?'
  if (limit !== undefined) values.push(limit)
  return db
    .prepare(`SELECT * FROM p_history_messages ${where} ORDER BY ${order} ${clause}`)
    .all(...values)
    .map(historyMessage)
}

/** Run a retention sweep at a supplied time, also used by the hourly task. */
export function cleanHistory(
  db: DatabaseSync,
  retention: number,
  maxMessages: number,
  now = Date.now(),
): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM p_history_messages WHERE time < ?').run(now - retention)
    db.prepare('DELETE FROM p_history_traces WHERE time < ?').run(now - retention)
    db.prepare(`DELETE FROM p_history_messages WHERE id IN (
      SELECT id FROM p_history_messages ORDER BY time DESC, id DESC LIMIT -1 OFFSET ?
    )`).run(maxMessages)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export default definePlugin({
  name: 'history',
  description: '记录消息和分发追踪',
  defaultOnNewBots: true,
  config: z.object({
    retention: durationSchema.default(7 * 86_400_000),
    maxMessages: z.number().int().nonnegative().default(100_000),
    ignorePlatforms: z.array(z.string()).default(['virtual']),
  }),
  setup(ctx) {
    ctx.migrate([
      `CREATE TABLE p_history_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, direction TEXT NOT NULL,
        platform TEXT NOT NULL, self_id TEXT NOT NULL, channel TEXT NOT NULL,
        user_id TEXT, nickname TEXT, message_id TEXT, message TEXT NOT NULL,
        text TEXT NOT NULL, time INTEGER NOT NULL
      );
      CREATE INDEX p_history_messages_channel_id ON p_history_messages(channel, id DESC);
      CREATE INDEX p_history_messages_time ON p_history_messages(time);
      CREATE TABLE p_history_traces (event_id TEXT PRIMARY KEY, trace TEXT NOT NULL, time INTEGER NOT NULL);`,
    ])
    const db = ctx.db
    const insert = db.prepare(`INSERT INTO p_history_messages
      (event_id, direction, platform, self_id, channel, user_id, nickname, message_id, message, text, time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const ignored = (platform: string): boolean => ctx.config.ignorePlatforms.includes(platform)
    ctx.on('message', (session) => {
      if (ignored(session.platform)) return
      insert.run(
        session.id,
        'in',
        session.platform,
        session.selfId,
        session.channelKey,
        session.userId,
        session.sender.card ?? session.sender.nickname,
        session.messageId,
        messageJson(session.message),
        redactBase64(session.text),
        session.time,
      )
    })
    ctx.on('bot.message.sent', (event) => {
      if (ignored(event.platform)) return
      const id = event.messageType === 'group' ? event.groupId : event.userId
      if (id === undefined) throw new Error('Sent message has no target')
      insert.run(
        event.eventId ?? null,
        'out',
        event.platform,
        event.selfId,
        formatTarget({
          platform: event.platform,
          selfId: event.selfId,
          type: event.messageType,
          id,
          thread: event.thread,
        }),
        event.selfId,
        event.bot.nickname ?? null,
        event.messageId,
        messageJson(event.message),
        redactBase64(plainText(event.message)),
        event.time,
      )
    })
    ctx.on('dispatch.trace', ({ trace }) => {
      if (ignored(trace.platform)) return
      db.prepare('INSERT OR REPLACE INTO p_history_traces VALUES (?, ?, ?)').run(
        trace.eventId,
        JSON.stringify(trace),
        trace.time,
      )
    })
    const service: HistoryService = {
      query(options = {}) {
        return selectMessages(
          db,
          options,
          'time DESC, id DESC',
          Math.max(1, Math.min(options.limit ?? 50, 200)),
        )
      },
      trace(eventId) {
        const row = db.prepare('SELECT trace FROM p_history_traces WHERE event_id = ?').get(eventId)
        return row ? (JSON.parse(String(row.trace)) as DispatchTrace) : undefined
      },
    }
    ctx.provide('history', service)
    ctx.interval('1h', () => cleanHistory(db, ctx.config.retention, ctx.config.maxMessages))
    ctx.panel.route((app) => {
      app.get('/channels', (c) => {
        const rows = db
          .prepare(`SELECT * FROM (
          SELECT *, count(*) OVER (PARTITION BY channel) AS channel_count,
            row_number() OVER (PARTITION BY channel ORDER BY time DESC, id DESC) AS position
          FROM p_history_messages
        ) WHERE position = 1 ORDER BY time DESC, id DESC LIMIT 200`)
          .all()
        const channels: HistoryChannel[] = rows.map((row) => {
          const last = historyMessage(row)
          const { target } = last
          return {
            channel: last.channel,
            platform: last.platform,
            selfId: last.selfId,
            type: target.type,
            id: target.id,
            ...(target.thread === undefined ? {} : { thread: target.thread }),
            count: Number(row.channel_count),
            last,
          }
        })
        return c.json(channels)
      })
      app.get('/messages', (c) => {
        const input = z
          .object({
            channel: z.string().optional(),
            before: z.coerce.number().int().positive().optional(),
            limit: z.coerce.number().int().positive().optional(),
            q: z.string().optional(),
          })
          .safeParse(c.req.query())
        if (!input.success) return c.json({ error: 'Invalid query parameters' }, 400)
        const limit = Math.min(input.data.limit ?? 50, 200)
        const items = selectMessages(db, input.data, 'id DESC', limit + 1)
        const more = items.length > limit
        if (more) items.pop()
        return c.json({ items, more })
      })
      app.get('/traces/:eventId', (c) => {
        const trace = service.trace(c.req.param('eventId'))
        return trace ? c.json(trace) : c.json({ error: 'Trace not found' }, 404)
      })
      app.get('/export', (c) => {
        const channel = c.req.query('channel')
        const statement = db.prepare(
          `SELECT * FROM p_history_messages ${channel === undefined ? '' : 'WHERE channel = ?'} ORDER BY time ASC, id ASC`,
        )
        c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
        return stream(c, async (output) => {
          const rows = channel === undefined ? statement.iterate() : statement.iterate(channel)
          for (const row of rows) await output.write(`${JSON.stringify(historyMessage(row))}\n`)
        })
      })
    })
  },
})
