import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { VirtualAdapter } from '../src/adapters/virtual/index.ts'
import { createApp } from '../src/bootstrap.ts'
import { configSchema } from '../src/core/config/schema.ts'
import { createLogger, getRecentLogs } from '../src/core/logger.ts'
import { createSession, type DispatchTrace, definePlugin, type Session, seg } from '../src/index.ts'

describe('dispatch traces', () => {
  it('correlates command outcomes, prompt consumption, outgoing messages and logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asabot-trace-'))
    const logger = createLogger({ level: 'info', destination: { write: () => true }, pretty: false })
    const app = createApp(
      configSchema.parse({
        dataDir: dir,
        pluginLoader: { dirs: [], hotReload: false },
        server: { port: 0, panelPassword: 'trace-password' },
      }),
      { logger },
    )
    const mock = new VirtualAdapter(app)
    app.useAdapter(mock)
    let release!: () => void
    let arrived = 0
    let savedSession: Session | undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    app.plugins.register(
      definePlugin({
        name: 'trace-test',
        setup(ctx) {
          ctx.on('message', (session) => {
            if (session.text === 'capture') savedSession = session
          })
          ctx
            .command('number <value:integer>')
            .cooldown('1h')
            .action(({ args }) => {
              ctx.logger.info('trace-test handler log')
              return `number:${args.value}`
            })
          ctx
            .command('locked')
            .permission('superuser')
            .action(() => 'locked')
          ctx.command('ask').action(async ({ session }) => (await session.prompt('question'))?.text)
          ctx.middleware(async (_session, next) => {
            await next()
          })
          ctx.match('match-trace', () => 'matched')
          ctx.command('parallel <label>').action(async ({ args }) => {
            if (++arrived === 2) release()
            await barrier
            ctx.logger.info({ label: args.label }, 'parallel handler log')
            return args.label
          })
        },
      }),
    )
    const traces: DispatchTrace[] = []
    const sent: { messageId: string; eventId?: string }[] = []
    app.events.on('dispatch.trace', ({ trace }) => {
      traces.push(trace)
    })
    app.events.on('bot.message.sent', (event) => {
      sent.push(event)
    })
    try {
      await app.start()
      await mock.receive('/number bad', { user: '20', group: '10' })
      await vi.waitFor(() => expect(traces).toHaveLength(1))
      expect(traces[0]?.steps).toContainEqual(
        expect.objectContaining({ stage: 'command', command: 'number', outcome: 'invalid' }),
      )
      await mock.receive('/locked', { user: '20', group: '10' })
      await vi.waitFor(() => expect(traces).toHaveLength(2))
      expect(traces[1]?.steps).toContainEqual(
        expect.objectContaining({ stage: 'command', command: 'locked', outcome: 'denied' }),
      )
      await mock.receive('/number 1', { user: '20', group: '10' })
      await vi.waitFor(() => expect(traces).toHaveLength(3))
      const successful = traces[2] as DispatchTrace
      expect(successful.steps).toContainEqual(
        expect.objectContaining({
          stage: 'command',
          plugin: 'trace-test',
          command: 'number',
          outcome: 'handled',
        }),
      )
      expect(successful.steps).toContainEqual(
        expect.objectContaining({ stage: 'middleware', plugin: 'trace-test', outcome: 'passed' }),
      )
      expect(successful.sent).toHaveLength(1)
      expect(sent).toContainEqual(
        expect.objectContaining({ messageId: successful.sent[0], eventId: successful.eventId }),
      )
      expect(getRecentLogs()).toContainEqual(
        expect.objectContaining({
          msg: 'trace-test handler log',
          eventId: successful.eventId,
          plugin: 'trace-test',
        }),
      )
      await mock.receive('/number 2', { user: '20', group: '10' })
      await vi.waitFor(() => expect(traces).toHaveLength(4))
      expect(traces[3]?.steps).toContainEqual(
        expect.objectContaining({ stage: 'command', outcome: 'cooldown' }),
      )
      await mock.receive('/ask', { user: '20', group: '10' })
      await mock.receive('answer', { user: '20', group: '10' })
      await vi.waitFor(() => expect(traces).toHaveLength(6))
      expect(traces.flatMap((trace) => trace.steps)).toContainEqual(
        expect.objectContaining({ stage: 'prompt', plugin: 'trace-test', outcome: 'handled' }),
      )

      const url = `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
      const login = await fetch(`${url}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'trace-password' }),
      })
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      if (!cookie) throw new Error('Missing cookie')
      const response = await fetch(`${url}/logs?eventId=${successful.eventId}`, { headers: { cookie } })
      const records: { msg: string; eventId: string }[] = await response.json()
      expect(records).toContainEqual(
        expect.objectContaining({ msg: 'trace-test handler log', eventId: successful.eventId }),
      )
      expect(records.every((record) => record.eventId === successful.eventId)).toBe(true)
      expect(traces).toHaveLength(6)
      const makeSession = (label: string) =>
        createSession(
          {
            id: `parallel-${label}`,
            platform: 'virtual',
            selfId: mock.bot.selfId,
            time: Date.now(),
            raw: undefined,
            bot: mock.bot,
            messageType: 'group',
            groupId: '10',
            messageId: label,
            userId: label,
            sender: { userId: label, nickname: label },
            isSuperuser: false,
            isBotAdmin: false,
            message: [seg.text(`/parallel ${label}`)],
          },
          app.sessionServices,
        )
      await Promise.all(['a', 'b'].map((label) => app.dispatcher.dispatch(makeSession(label))))
      for (const label of ['a', 'b']) {
        const trace = traces.find((item) => item.eventId === `parallel-${label}`)
        expect(trace?.sent).toHaveLength(1)
        expect(sent).toContainEqual(
          expect.objectContaining({ messageId: trace?.sent[0], eventId: `parallel-${label}` }),
        )
        expect(getRecentLogs()).toContainEqual(
          expect.objectContaining({ label, eventId: `parallel-${label}`, msg: 'parallel handler log' }),
        )
      }
      expect(traces).toHaveLength(8)
      await mock.receive('match-trace', { user: '20', group: '10' })
      await vi.waitFor(() => expect(traces).toHaveLength(9))
      expect(traces[8]?.steps).toContainEqual(
        expect.objectContaining({ stage: 'matcher', plugin: 'trace-test', outcome: 'handled' }),
      )
      await mock.receive('capture', { user: '20', group: '10' })
      await vi.waitFor(() => expect(traces).toHaveLength(10))
      if (!savedSession) throw new Error('Session was not captured')
      const pending = savedSession.prompt()
      await mock.receive('captured answer', { user: '20', group: '10' })
      await pending
      await vi.waitFor(() => expect(traces).toHaveLength(11))
      expect(traces[10]?.steps).toContainEqual(
        expect.objectContaining({ stage: 'prompt', plugin: 'trace-test', outcome: 'handled' }),
      )
      app.storage.access.add('block', 'group', 'virtual:10')
      await app.dispatcher.dispatch(makeSession('blocked'))
      expect(traces).toHaveLength(12)
      expect(traces[11]?.steps).toEqual([expect.objectContaining({ stage: 'filter', outcome: 'blocked' })])
    } finally {
      await app.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
