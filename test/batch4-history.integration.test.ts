import { describe, expect, it } from 'vitest'
import { definePlugin, type HistoryMessage, type HistoryService, isSegment, seg } from '../src/index.ts'
import { cleanHistory } from '../src/plugins/history.ts'
import { createTestApp } from '../src/testing/index.ts'

describe('history plugin', () => {
  it('records messages and traces, exposes paginated panel routes, exports and cleans history', async () => {
    const t = await createTestApp({
      config: {
        plugins: { history: { config: { ignorePlatforms: [] } } },
        server: { port: 0, panelPassword: 'history-password' },
      },
      plugins: [
        definePlugin({
          name: 'history-reply',
          setup(ctx) {
            ctx.match('hello', () => 'world')
          },
        }),
      ],
    })
    const history = t.app.plugins.inject('history') as HistoryService
    const base = `http://127.0.0.1:${t.app.server?.address()?.port}/api/panel`
    try {
      const login = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'history-password' }),
      })
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      if (!cookie) throw new Error('Missing cookie')
      const request = (path: string) => fetch(`${base}/ext/history${path}`, { headers: { cookie } })
      await t.say('hello')
      await t.say([seg.image(`base64://${'A'.repeat(200)}`), seg.text('second')])
      const all = history.query({ channel: 'virtual:10000:group:10' })
      expect(all).toHaveLength(3)
      const incoming = all.find((item) => item.text === 'hello') as HistoryMessage
      const outgoing = all.find((item) => item.text === 'world') as HistoryMessage
      expect(incoming).toMatchObject({ direction: 'in', userId: '20', nickname: '20' })
      expect(outgoing).toMatchObject({ direction: 'out', eventId: incoming.eventId })
      expect(history.trace(incoming.eventId as string)).toMatchObject({
        eventId: incoming.eventId,
        sent: [outgoing.messageId],
      })
      const image = all.find((item) => item.text === 'second')?.message[0]
      expect(image && isSegment(image, 'image') ? image.data.file : undefined).toBe(
        `base64://${'A'.repeat(55)}… (length=209)`,
      )
      expect(await (await request('/channels')).json()).toMatchObject([
        {
          channel: 'virtual:10000:group:10',
          platform: 'virtual',
          selfId: '10000',
          type: 'group',
          id: '10',
          count: 3,
          last: { text: 'second' },
        },
      ])
      const first = (await (
        await request('/messages?channel=virtual%3A10000%3Agroup%3A10&limit=1')
      ).json()) as { items: HistoryMessage[]; more: boolean }
      expect(first.more).toBe(true)
      const second = (await (await request(`/messages?limit=1&before=${first.items[0]?.id}`)).json()) as {
        items: HistoryMessage[]
        more: boolean
      }
      expect(second.items[0]?.id).toBeLessThan(first.items[0]?.id as number)
      expect(await (await request('/messages?q=world')).json()).toMatchObject({
        items: [{ text: 'world' }],
        more: false,
      })
      expect(await (await request(`/traces/${incoming.eventId}`)).json()).toMatchObject({
        eventId: incoming.eventId,
      })
      expect((await request('/traces/unknown')).status).toBe(404)
      const exported = await request('/export?channel=virtual%3A10000%3Agroup%3A10')
      expect(exported.headers.get('content-type')).toContain('application/x-ndjson')
      const lines = (await exported.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as HistoryMessage)
      expect(lines.map((item) => item.text)).toEqual(['hello', 'world', 'second'])
      const db = t.app.storage.db
      db.prepare('UPDATE p_history_messages SET time = ? WHERE id = ?').run(100, incoming.id)
      db.prepare('UPDATE p_history_messages SET time = ? WHERE id = ?').run(1100, outgoing.id)
      db.prepare('UPDATE p_history_messages SET time = ? WHERE text = ?').run(1200, 'second')
      db.prepare('UPDATE p_history_traces SET time = 100').run()
      cleanHistory(db, 1000, 1, 1500)
      expect(history.query().map((item) => item.text)).toEqual(['second'])
      expect(history.trace(incoming.eventId as string)).toBeUndefined()
    } finally {
      await t.dispose()
    }
  })

  it('ignores virtual messages by default', async () => {
    const t = await createTestApp()
    try {
      await t.say('hello')
      expect((t.app.plugins.inject('history') as HistoryService).query()).toEqual([])
    } finally {
      await t.dispose()
    }
  })
})
