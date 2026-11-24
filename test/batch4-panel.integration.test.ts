import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { VirtualAdapter } from '../src/adapters/virtual/index.ts'
import { createApp } from '../src/bootstrap.ts'
import { configSchema } from '../src/core/config/schema.ts'
import { createLogger } from '../src/core/logger.ts'
import { definePlugin, seg, z } from '../src/index.ts'
import { createTestApp, FakeBot } from '../src/testing/index.ts'

const password = 'batch4-panel-secret'

async function client(port: number) {
  const origin = `http://127.0.0.1:${port}`
  const response = await fetch(`${origin}/api/panel/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('Missing cookie')
  return {
    origin,
    cookie,
    request: (path: string, method = 'GET', value?: unknown) =>
      fetch(`${origin}/api/panel${path}`, {
        method,
        headers: { cookie, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
        ...(method === 'GET' ? {} : { body: JSON.stringify(value ?? {}) }),
      }),
  }
}

function rawGet(port: number, path: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path }, (response) => {
      response.resume()
      resolve(response.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('batch 4 panel server', () => {
  it('sets and clears aliases for individual bot accounts without changing their platform names', async () => {
    const t = await createTestApp({ config: { server: { port: 0, panelPassword: password } } })
    const first = Object.assign(new FakeBot('first@im.bot'), { nickname: 'Platform name' })
    const second = new FakeBot('second@im.bot')
    const path = `/bots/${first.platform}/${encodeURIComponent(first.selfId)}`
    let socket: WebSocket | undefined
    let restarted: ReturnType<typeof createApp> | undefined
    try {
      t.app.registerBot(first)
      t.app.registerBot(second)
      const port = t.app.server?.address()?.port
      if (port === undefined) throw new Error('Missing server')
      const { origin, cookie, request } = await client(port)
      socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/panel/ws`, { headers: { cookie } })
      const frames: unknown[] = []
      socket.on('message', (data) => frames.push(JSON.parse(data.toString())))
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: 'hello' })))

      const saved = { selfId: first.selfId, nickname: first.nickname, alias: '工作微信' }
      const response = await request(`${path}/alias`, 'PUT', { alias: '  工作微信  ' })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject(saved)
      await vi.waitFor(() =>
        expect(frames).toContainEqual({ type: 'bot', bot: expect.objectContaining(saved) }),
      )
      expect(await (await request('/bots')).json()).toContainEqual(expect.objectContaining(saved))
      const other = await (
        await request(`/bots/${second.platform}/${encodeURIComponent(second.selfId)}`)
      ).json()
      expect(other.bot).not.toHaveProperty('alias')
      expect((await request(`${path}/alias`, 'PUT', { alias: 'x'.repeat(81) })).status).toBe(400)
      expect((await request('/bots/fake/unknown/alias', 'PUT', { alias: 'Unknown' })).status).toBe(404)

      socket.terminate()
      await t.app.stop()
      restarted = createApp(t.app.config, { logger: t.app.logger })
      await restarted.start()
      const restartedPort = restarted.server?.address()?.port
      if (restartedPort === undefined) throw new Error('Missing server after restart')
      const { request: afterRestart } = await client(restartedPort)
      expect(await (await afterRestart(path)).json()).toMatchObject({ bot: { ...saved, status: 'offline' } })
      const renamed = await afterRestart(`${path}/alias`, 'PUT', { alias: '离线编辑' })
      expect(renamed.status).toBe(200)

      restarted.registerBot(Object.assign(new FakeBot(first.selfId), { nickname: 'New platform name' }))
      expect(await (await afterRestart(path)).json()).toMatchObject({
        bot: { selfId: first.selfId, alias: '离线编辑', nickname: 'New platform name', status: 'online' },
      })
      const cleared = await afterRestart(`${path}/alias`, 'PUT', { alias: null })
      expect(cleared.status).toBe(200)
      expect(await cleared.json()).not.toHaveProperty('alias')
      const detail = await (await afterRestart(path)).json()
      expect(detail.bot).toMatchObject({ selfId: first.selfId, nickname: 'New platform name' })
      expect(detail.bot).not.toHaveProperty('alias')
    } finally {
      socket?.terminate()
      await restarted?.stop()
      await t.dispose()
    }
  })

  it('exposes the same canonical plugin directory to plugins and the panel after file removal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asabot-plugin-catalog-'))
    const entry = join(directory, 'observer.ts')
    await writeFile(entry, "export default { name: 'observer', inject: { optional: ['ai'] }, setup() {} }")
    await writeFile(join(directory, 'duplicate.ts'), "export default { name: 'catalog-user', setup() {} }")
    const config = z.object({
      consumer: z
        .string()
        .meta({ 'x-asabot-options': { source: 'plugins', consumes: 'ai' } })
        .optional(),
    })
    const t = await createTestApp({
      plugins: [
        definePlugin({
          name: 'catalog-user',
          config,
          setup(ctx) {
            ctx.panel.route((routes) => {
              routes.get('/catalog', (c) => c.json(ctx.plugins.list()))
              routes.get('/observer', (c) => c.json(ctx.plugins.get('observer') ?? null))
            })
          },
        }),
        definePlugin({ name: 'required-ai', inject: ['ai'], setup() {} }),
      ],
      pluginDirs: [directory],
      config: {
        plugins: {
          observer: { enabled: false },
          'catalog-user': { enabled: true, config: { consumer: 'observer' } },
        },
        server: { port: 0, panelPassword: password },
      },
    })
    let socket: WebSocket | undefined
    try {
      const port = t.app.server?.address()?.port
      if (port === undefined) throw new Error('Missing server')
      const { origin, cookie, request } = await client(port)
      const catalog = () => request('/plugin-catalog').then((res) => res.json())
      const before = await catalog()
      expect(await (await request('/ext/catalog-user/catalog')).json()).toEqual(before)
      expect(before.filter((item: { name: string }) => item.name === 'catalog-user')).toEqual([
        { name: 'catalog-user', state: 'active', source: 'builtin', enabled: true, provides: [], inject: [] },
      ])
      expect(before).toContainEqual({
        name: 'observer',
        state: 'disabled',
        source: 'file',
        enabled: false,
        provides: [],
        inject: [{ name: 'ai', optional: true }],
      })
      expect(before).toContainEqual({
        name: 'required-ai',
        state: 'failed',
        source: 'builtin',
        enabled: true,
        provides: [],
        inject: [{ name: 'ai', optional: false }],
      })
      expect(await (await request('/ext/catalog-user/observer')).json()).toEqual(
        before.find((item: { name: string }) => item.name === 'observer'),
      )

      socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/panel/ws`, { headers: { cookie } })
      const frames: unknown[] = []
      socket.on('message', (data) => frames.push(JSON.parse(data.toString())))
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: 'hello' })))
      await rm(entry)
      await request('/plugins/rescan', 'POST')
      await vi.waitFor(() => expect(frames).toContainEqual({ type: 'plugins-changed' }))
      expect(await catalog()).toEqual(before.filter((item: { name: string }) => item.name !== 'observer'))
      expect(await (await request('/ext/catalog-user/observer')).json()).toBeNull()
      const plugins = await (await request('/plugins')).json()
      expect(plugins.find((item: { name: string }) => item.name === 'catalog-user')).toMatchObject({
        config: { consumer: 'observer' },
        configSchema: {
          properties: { consumer: { 'x-asabot-options': { source: 'plugins', consumes: 'ai' } } },
        },
      })
    } finally {
      socket?.terminate()
      await t.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serves plugin pages safely, authenticates extension routes and pushes events until unload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asabot-panel-pages-'))
    const root = join(directory, 'page')
    const outside = join(directory, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(root, 'index.html'), '<h1>plugin page</h1>')
    await writeFile(join(root, 'page.js'), 'export const ok = true')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'link'), 'junction')
    const plugin = definePlugin({
      name: 'dashboard',
      setup(ctx) {
        ctx.panel.page({ title: 'Stats', icon: 'chart', root })
        ctx.panel.route((app) => {
          app.get('/stats', (c) => c.json({ total: 42 }))
          app.post('/publish', (c) => {
            ctx.panel.push('updated', { total: 42 })
            return c.json({ ok: true })
          })
        })
      },
    })
    const t = await createTestApp({
      plugins: [plugin],
      config: { server: { port: 0, panelPassword: password } },
    })
    const port = t.app.server?.address()?.port
    if (port === undefined) throw new Error('Missing server')
    const { origin, cookie, request } = await client(port)
    let socket: WebSocket | undefined
    try {
      expect((await fetch(`${origin}/api/panel/ext/dashboard/stats`)).status).toBe(401)
      expect(await (await request('/ext/dashboard/stats')).json()).toEqual({ total: 42 })
      expect(
        (
          await fetch(`${origin}/api/panel/ext/dashboard/publish`, {
            method: 'POST',
            headers: { cookie, origin: 'https://invalid.example', 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(403)
      const plugins = await (await request('/plugins')).json()
      expect(plugins.find((item: { name: string }) => item.name === 'dashboard').page).toEqual({
        title: 'Stats',
        icon: 'chart',
      })
      const page = await fetch(`${origin}/plugin-pages/dashboard/`)
      expect(await page.text()).toBe('<h1>plugin page</h1>')
      expect(page.headers.get('content-security-policy')).toBe(
        'sandbox allow-scripts allow-forms allow-popups',
      )
      expect(page.headers.get('access-control-allow-origin')).toBe('*')
      expect(page.headers.get('content-type')).toContain('text/html')
      expect((await fetch(`${origin}/plugin-pages/dashboard/page.js`)).headers.get('content-type')).toContain(
        'javascript',
      )
      expect(await rawGet(port, '/plugin-pages/dashboard/%2e%2e/outside/secret.txt')).toBe(404)
      expect(await rawGet(port, '/plugin-%70ages/dashboard/%2e%2e/outside/secret.txt')).toBe(404)
      expect(await rawGet(port, '/plugin-%70ages/dashboard/')).toBe(200)
      expect(await rawGet(port, '/plugin-pages/dashboard/%2Foutside/secret.txt')).toBe(404)
      expect((await fetch(`${origin}/plugin-pages/dashboard/link/secret.txt`)).status).toBe(404)
      expect((await fetch(`${origin}/plugin-pages/missing/`)).status).toBe(404)
      socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/panel/ws`, { headers: { cookie } })
      const frames: unknown[] = []
      socket.on('message', (data) => frames.push(JSON.parse(data.toString())))
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: 'hello' })))
      expect((await request('/ext/dashboard/publish', 'POST')).status).toBe(200)
      await vi.waitFor(() =>
        expect(frames).toContainEqual({
          type: 'plugin-event',
          plugin: 'dashboard',
          topic: 'updated',
          data: { total: 42 },
        }),
      )
      await t.app.plugins.disable('dashboard')
      expect((await request('/ext/dashboard/stats')).status).toBe(404)
      expect((await fetch(`${origin}/plugin-pages/dashboard/`)).status).toBe(404)
    } finally {
      socket?.terminate()
      await t.dispose()
      await rm(directory, { recursive: true, force: true })
    }

    const disabled = await createTestApp({
      plugins: [plugin],
      config: { server: { port: 0, apiToken: 'api-only' } },
    })
    try {
      const url = `http://127.0.0.1:${disabled.app.server?.address()?.port}`
      expect((await fetch(`${url}/plugin-pages/dashboard/`)).status).toBe(404)
      expect((await fetch(`${url}/api/panel/ext/dashboard/stats`)).status).toBe(404)
    } finally {
      await disabled.dispose()
    }
  })

  it('merges bot groups with stored rules, caches each bot and exposes group settings', async () => {
    const plugin = definePlugin({
      name: 'group-rules',
      config: z.object({ count: z.number().default(1) }),
      setup(ctx) {
        ctx.command('group-command').action(() => 'ok')
      },
    })
    const t = await createTestApp({
      plugins: [plugin],
      config: { server: { port: 0, panelPassword: password } },
    })
    const other = new VirtualAdapter(t.app, { selfId: '10001' })
    await other.start()
    const groups = vi
      .spyOn(t.mock.bot, 'getGroupList')
      .mockResolvedValue([{ groupId: '10', groupName: 'Ten' }])
    vi.spyOn(other.bot, 'getGroupList').mockRejectedValue(new Error('failed'))
    const warn = vi.spyOn(t.app.logger, 'warn')
    const port = t.app.server?.address()?.port
    if (port === undefined) throw new Error('Missing server')
    const { request } = await client(port)
    try {
      await request('/plugins/group-rules/groups/virtual%3A10000%3Agroup%3A20', 'PUT', {
        enabled: false,
        config: { count: 5 },
      })
      await request('/commands/groups', 'PUT', {
        path: 'group-command',
        groupKey: 'virtual:10000:group:20',
        enabled: false,
      })
      await request('/acl', 'POST', { list: 'block', subject: 'group', key: 'virtual:20' })
      expect(await (await request('/groups')).json()).toEqual([
        {
          groupKey: 'virtual:10000:group:10',
          platform: 'virtual',
          selfId: '10000',
          groupId: '10',
          name: 'Ten',
          bots: ['10000'],
          rules: { plugins: 0, configs: 0, commands: 0 },
        },
        {
          groupKey: 'virtual:10000:group:20',
          platform: 'virtual',
          selfId: '10000',
          groupId: '20',
          bots: [],
          rules: { plugins: 1, configs: 1, commands: 1 },
          access: 'block',
        },
      ])
      expect(warn).toHaveBeenCalled()
      const detail = await (await request('/groups/virtual%3A10000%3Agroup%3A20')).json()
      expect(detail.group.rules).toEqual({ plugins: 1, configs: 1, commands: 1 })
      expect(detail.plugins).toContainEqual({
        name: 'group-rules',
        enabled: false,
        configurable: true,
        override: { count: 5 },
        effectiveConfig: { count: 5 },
        inheritedConfig: { count: 1 },
        configSources: { count: 'group' },
      })
      expect(detail.commands).toContainEqual({ path: 'group-command', owner: 'group-rules', enabled: false })
      expect(groups).toHaveBeenCalledTimes(1)
      groups.mockResolvedValue([{ groupId: '11', groupName: 'Eleven' }])
      expect(
        (await (await request('/groups')).json()).map((item: { groupKey: string }) => item.groupKey),
      ).toContain('virtual:10000:group:10')
      expect(
        (await (await request('/groups?refresh=1')).json()).map(
          (item: { groupKey: string }) => item.groupKey,
        ),
      ).toEqual(['virtual:10000:group:11', 'virtual:10000:group:20'])
      expect(groups).toHaveBeenCalledTimes(2)
    } finally {
      await other.stop()
      await t.dispose()
    }
  })

  it('returns event-scoped traces and logs, simulated events, message IDs and per-request capabilities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asabot-panel-playground-'))
    const logger = createLogger({ level: 'info', destination: { write: () => true }, pretty: false })
    const app = createApp(
      configSchema.parse({
        dataDir: directory,
        pluginLoader: { dirs: [], hotReload: false },
        server: { port: 0, panelPassword: password },
      }),
      { logger },
    )
    let getMessage: ((id: string) => Promise<unknown>) | undefined
    let enterConcurrent!: () => void
    let releaseConcurrent!: () => void
    const concurrentEntered = new Promise<void>((resolve) => {
      enterConcurrent = resolve
    })
    const concurrentReleased = new Promise<void>((resolve) => {
      releaseConcurrent = resolve
    })
    app.plugins.register(
      definePlugin({
        name: 'playground-test',
        setup(ctx) {
          ctx.command('play').action(({ session }) => {
            getMessage = (id) => session.bot.getMessage(id)
            ctx.logger.info('playground command')
            return [seg.markdown('**hello**'), seg.image('base64://AA==')]
          })
          ctx.command('ask-test').action(async ({ session }) => {
            const reply = await session.prompt('question')
            ctx.logger.info('prompt resumed')
            return reply?.text
          })
          ctx.command('chain-test').action(async ({ session }) => {
            const first = await session.prompt('first?')
            const second = await first?.prompt('second?')
            return second?.text
          })
          ctx.command('blocked-play').action(() => {
            ctx.logger.info('blocked playground')
            return 'done'
          })
          ctx.command('concurrent-play').action(async () => {
            enterConcurrent()
            await concurrentReleased
            ctx.logger.info('concurrent playground')
            return 'done'
          })
          ctx.middleware(async (session, next) => {
            await next()
            if (session.text === '/ask-test') {
              ctx.logger.info('middleware resumed')
              await session.send('middleware reply')
            }
          })
          ctx.on('notice.member.join', async (event) => {
            ctx.logger.info({ joinType: event.joinType }, 'member joined')
            await event.bot.sendGroup(event.groupId, `welcome ${event.userId}`)
          })
          ctx.on('request.friend', async (event) => {
            await event.approve('friend')
          })
        },
      }),
    )
    try {
      await app.start()
      const port = app.server?.address()?.port
      if (port === undefined) throw new Error('Missing server')
      const { request } = await client(port)
      const run = async (body: unknown) => (await request('/playground', 'POST', body)).json()
      const first = await run({
        text: '/play',
        user: { id: '20' },
        group: '10',
        capabilities: { segments: ['text'] },
      })
      expect(first.incoming.messageId).toEqual(expect.any(String))
      expect(first.replies).toMatchObject([
        { messageId: expect.any(String), text: 'hello[图片]', message: [{ type: 'text' }] },
      ])
      expect(first.traces).toHaveLength(1)
      const firstId = first.traces[0].eventId
      expect(first.traces[0]).toMatchObject({ name: 'message.group', sent: [first.replies[0].messageId] })
      expect(first.logs).toContainEqual(
        expect.objectContaining({ eventId: firstId, msg: 'playground command' }),
      )
      expect(first.logs.every((record: { eventId: string }) => record.eventId === firstId)).toBe(true)
      expect(await getMessage?.(first.incoming.messageId)).toMatchObject({
        messageId: first.incoming.messageId,
        userId: '20',
      })
      expect(await getMessage?.(first.replies[0].messageId)).toMatchObject({
        messageId: first.replies[0].messageId,
        userId: 'playground',
      })
      const normal = await run({ text: '/play', user: { id: '20' }, group: '10' })
      expect(normal.replies[0].message.map((part: { type: string }) => part.type)).toEqual([
        'markdown',
        'image',
      ])
      expect(normal.logs.every((record: { eventId: string }) => record.eventId !== firstId)).toBe(true)
      const ask = await run({ text: '/ask-test', user: { id: '20' }, group: '10' })
      expect(ask.replies[0].text).toBe('question')
      const answer = await run({ text: 'answer', user: { id: '20' }, group: '10' })
      expect(answer.replies[0].text).toBe('answer')
      expect(answer.replies[1].text).toBe('middleware reply')
      expect(answer.traces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventId: answer.incoming.messageId,
            sent: answer.replies.map((reply: { messageId: string }) => reply.messageId),
            steps: expect.arrayContaining([
              expect.objectContaining({ stage: 'prompt', plugin: 'playground-test' }),
            ]),
          }),
        ]),
      )
      expect(answer.logs).toContainEqual(
        expect.objectContaining({ msg: 'prompt resumed', eventId: answer.incoming.messageId }),
      )
      expect(answer.logs).toContainEqual(
        expect.objectContaining({ msg: 'middleware resumed', eventId: answer.incoming.messageId }),
      )
      expect(answer.traces).toHaveLength(1)
      expect(
        answer.logs.every((record: { eventId: string }) =>
          answer.traces.some((trace: { eventId: string }) => trace.eventId === record.eventId),
        ),
      ).toBe(true)
      const chain = await run({ text: '/chain-test', user: { id: '20' }, group: '10' })
      const middle = await run({ text: 'first answer', user: { id: '20' }, group: '10' })
      expect(chain.traces).toMatchObject([{ eventId: chain.incoming.messageId }])
      expect(middle.replies[0].text).toBe('second?')
      expect(middle.traces).toEqual([
        expect.objectContaining({
          eventId: middle.incoming.messageId,
          sent: [middle.replies[0].messageId],
          steps: expect.arrayContaining([expect.objectContaining({ stage: 'prompt' })]),
        }),
      ])
      const end = await run({ text: 'second answer', user: { id: '20' }, group: '10' })
      expect(end.replies[0].text).toBe('second answer')
      expect(end.traces).toMatchObject([
        { eventId: end.incoming.messageId, sent: [end.replies[0].messageId] },
      ])
      const join = await (
        await request('/playground/event', 'POST', {
          name: 'notice.member.join',
          user: { id: '20' },
          group: '10',
          fields: { userId: '21', joinType: 'invite' },
        })
      ).json()
      expect(join.replies).toMatchObject([{ text: 'welcome 21', messageId: expect.any(String) }])
      expect(join.traces).toMatchObject([{ name: 'notice.member.join' }])
      expect(join.logs).toContainEqual(expect.objectContaining({ joinType: 'invite' }))
      const friend = await (
        await request('/playground/event', 'POST', { name: 'request.friend', user: { id: '20' } })
      ).json()
      expect(friend.actions).toEqual([
        { action: 'approve', params: { name: 'request.friend', userId: '20', remark: 'friend' } },
      ])
      expect(friend.traces).toMatchObject([{ name: 'request.friend' }])
      app.storage.access.add('block', 'user', 'virtual:30')
      const blocked = await run({ text: '/blocked-play', user: { id: '30' }, group: '10' })
      expect(blocked.replies).toEqual([])
      expect(blocked.traces).toMatchObject([
        { eventId: blocked.incoming.messageId, steps: [{ stage: 'filter', outcome: 'blocked' }] },
      ])
      expect(blocked.logs.some((record: { msg: string }) => record.msg === 'blocked playground')).toBe(false)
      const pending = run({ text: '/concurrent-play', user: { id: '20' }, group: '10' })
      await concurrentEntered
      const foreignBot = new VirtualAdapter(app, { selfId: 'foreign' }).bot
      await app.dispatcher.dispatch({
        id: 'unrelated-notice',
        platform: 'other',
        selfId: 'other',
        time: Date.now(),
        kind: 'notice',
        name: 'notice.member.join',
        raw: undefined,
        bot: foreignBot,
        groupId: '10',
        userId: 'unrelated',
        joinType: 'approve',
      })
      releaseConcurrent()
      const concurrent = await pending
      expect(
        concurrent.traces.every((trace: { eventId: string }) => trace.eventId !== 'unrelated-notice'),
      ).toBe(true)
      expect(
        concurrent.logs.every((record: { eventId: string }) => record.eventId !== 'unrelated-notice'),
      ).toBe(true)
      const oversized = await request('/playground', 'POST', {
        text: 'x'.repeat(2 * 1024 * 1024),
        user: { id: '20' },
      })
      expect(oversized.status).toBe(400)
    } finally {
      releaseConcurrent()
      await app.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
