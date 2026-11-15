import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { OneBotAdapter, onebot11Schema } from '../src/adapters/onebot11/index.ts'
import { MockOneBot } from '../src/adapters/onebot11/testing.ts'
import { definePlugin, z } from '../src/index.ts'
import { createTestApp, type TestApp } from '../src/testing/index.ts'

const apps: TestApp[] = []
const onebotMocks: MockOneBot[] = []

const sample = definePlugin({
  name: 'panel-sample',
  inject: { optional: ['coins'] },
  config: z.object({ amount: z.number().int().min(1).default(1) }),
  setup(ctx) {
    ctx.route((app) => app.get('/hello', (c) => c.json({ ok: true })))
    ctx.route((app) => app.post('/echo', async (c) => c.json(await c.req.json())))
    ctx.command('dialog').action(async ({ session }) => {
      const first = await session.prompt('name?')
      if (!first) return
      const second = await first.prompt('color?')
      if (second) return `${first.text}:${second.text}`
    })
    ctx
      .command('secret')
      .permission('superuser')
      .hidden()
      .action(() => 'secret')
    ctx
      .command('limited')
      .cooldown('1h')
      .action(() => 'limited')
  },
})

async function start(): Promise<{ t: TestApp; url: string }> {
  const t = await createTestApp({
    plugins: [sample],
    config: {
      server: { port: 0, panelPassword: 'panel-secret', apiToken: 'api-secret' },
      superusers: [{ platform: 'virtual', selfId: '10000', userId: '99' }],
    },
  })
  apps.push(t)
  const port = t.app.server?.address()?.port
  if (port === undefined) throw new Error('HTTP server did not start')
  return { t, url: `http://127.0.0.1:${port}` }
}

async function login(url: string): Promise<string> {
  const response = await fetch(`${url}/api/panel/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'panel-secret' }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')
  expect(cookie).toMatch(/HttpOnly/i)
  expect(cookie).toMatch(/SameSite=Strict/i)
  expect(cookie).toMatch(/Path=\//i)
  if (!cookie) throw new Error('Missing session cookie')
  return cookie.split(';')[0] as string
}

function request(
  url: string,
  cookie: string,
  path: string,
  method = 'GET',
  value?: unknown,
): Promise<Response> {
  return fetch(`${url}/api/panel${path}`, {
    method,
    headers: { Cookie: cookie, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(value ?? {}) }),
  })
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose()
  for (const mock of onebotMocks.splice(0)) await mock.close()
})

describe('HTTP service contract', () => {
  it('keeps plugin views available when a parsed config cannot be represented as JSON', async () => {
    const nonJson = definePlugin({
      name: 'non-json',
      config: z
        .string()
        .default('1')
        .transform((value) => BigInt(value)),
      setup() {},
    })
    const t = await createTestApp({
      plugins: [nonJson],
      config: {
        server: { port: 0, panelPassword: 'panel-secret' },
        plugins: { 'non-json': { config: '1' } },
      },
    })
    apps.push(t)
    const url = `http://127.0.0.1:${t.app.server?.address()?.port}`
    const cookie = await login(url)
    const response = await request(url, cookie, '/plugins')
    expect(response.status).toBe(200)
    const plugins = await response.json()
    const plugin = plugins.find((item: { name: string }) => item.name === 'non-json')
    expect(plugin).toMatchObject({ state: 'active' })
    expect(plugin).not.toHaveProperty('config')
  })

  it('enables the panel and external API independently', async () => {
    const disabled = await createTestApp()
    apps.push(disabled)
    expect(disabled.app.server).toBeUndefined()

    const apiOnly = await createTestApp({ config: { server: { port: 0, apiToken: 'api-only' } } })
    apps.push(apiOnly)
    const port = apiOnly.app.server?.address()?.port
    expect(port).toBeDefined()
    const base = `http://127.0.0.1:${port}`
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({
      ok: true,
      bots: { online: 1, total: 1 },
    })
    expect((await fetch(`${base}/api/panel/session`)).status).toBe(404)
    expect((await fetch(`${base}/`)).status).toBe(404)
    expect(
      (await fetch(`${base}/api/v1/bots`, { headers: { Authorization: 'Bearer api-only' } })).status,
    ).toBe(200)

    const panelOnly = await createTestApp({ config: { server: { port: 0, panelPassword: 'panel-only' } } })
    apps.push(panelOnly)
    const panelPort = panelOnly.app.server?.address()?.port
    expect((await fetch(`http://127.0.0.1:${panelPort}/api/v1/bots`)).status).toBe(404)
    const page = await fetch(`http://127.0.0.1:${panelPort}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
  })

  it('authenticates, limits attempts, checks Origin and revokes sessions', async () => {
    const { url } = await start()
    expect((await fetch(`${url}/api/panel/overview`)).status).toBe(401)
    expect(await (await fetch(`${url}/api/panel/session`)).json()).toEqual({ authenticated: false })
    const cookie = await login(url)
    expect(await (await request(url, cookie, '/session')).json()).toEqual({ authenticated: true })
    expect(
      (
        await fetch(`${url}/api/panel/logout`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: 'https://elsewhere.example',
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(403)
    expect(
      (await fetch(`${url}/api/panel/logout`, { method: 'POST', headers: { Cookie: cookie }, body: '{}' }))
        .status,
    ).toBe(400)
    expect((await request(url, cookie, '/logout', 'POST')).status).toBe(200)
    expect((await request(url, cookie, '/overview')).status).toBe(401)
    for (let i = 0; i < 9; i++) {
      const response = await fetch(`${url}/api/panel/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({
        error: { code: expect.any(String), message: expect.any(String) },
      })
    }
    expect(
      (
        await fetch(`${url}/api/panel/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'panel-secret' }),
        })
      ).status,
    ).toBe(429)
  })

  it('validates and updates the runtime log level through the panel', async () => {
    const { t, url } = await start()
    const cookie = await login(url)
    expect(await (await request(url, cookie, '/logs/level')).json()).toEqual({ level: 'silent' })
    expect(await (await request(url, cookie, '/logs/level', 'PUT', { level: 'warn' })).json()).toEqual({
      level: 'warn',
    })
    expect(t.app.logger.isLevelEnabled('info')).toBe(false)
    const invalid = await request(url, cookie, '/logs/level', 'PUT', { level: 'invalid' })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      error: { code: 'BAD_REQUEST', issues: [{ path: 'level' }] },
    })
    expect(t.app.config.log.level).toBe('info')
  })

  it('provides views, plugin operations, config validation, access control and dynamic routes', async () => {
    const { url } = await start()
    const cookie = await login(url)
    const overview = await (await request(url, cookie, '/overview')).json()
    expect(overview).toMatchObject({
      version: expect.any(String),
      node: process.version,
      bots: [
        {
          platform: 'virtual',
          selfId: '10000',
          status: 'online',
          connection: '虚拟',
          capabilities: {
            segments: expect.arrayContaining(['text', 'markdown', 'button']),
            textStyles: expect.arrayContaining(['bold']),
            actions: expect.arrayContaining(['sendGroup']),
          },
        },
      ],
      plugins: { active: 7 },
      today: { received: 0, sent: 0 },
    })
    const plugins = await (await request(url, cookie, '/plugins')).json()
    expect(plugins.find((item: { name: string }) => item.name === 'panel-sample')).toMatchObject({
      state: 'active',
      provides: [],
      inject: [{ name: 'coins', optional: true }],
      config: { amount: 1 },
      commands: expect.arrayContaining([
        {
          owner: 'panel-sample',
          path: 'secret',
          usage: '/secret',
          permission: true,
          hidden: true,
          scope: 'all',
          options: [],
          examples: [],
          aliases: [],
          description: '',
          disabledGroups: [],
          overrideIssues: [],
        },
      ]),
    })
    expect((await request(url, cookie, '/plugins/admin/disable', 'POST')).status).toBe(409)
    const invalid = await request(url, cookie, '/plugins/panel-sample/config', 'PUT', {
      config: { amount: 0 },
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      error: { issues: [{ path: 'plugins.panel-sample.config.amount', message: expect.any(String) }] },
    })
    expect(
      await (
        await request(url, cookie, '/plugins/panel-sample/config', 'PUT', { config: { amount: 7 } })
      ).json(),
    ).toMatchObject({ config: { amount: 7 }, state: 'active' })
    expect(await (await fetch(`${url}/plugins/panel-sample/hello`)).json()).toEqual({ ok: true })
    expect(
      await (
        await fetch(`${url}/plugins/panel-sample/echo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 1 }),
        })
      ).json(),
    ).toEqual({ value: 1 })
    expect(
      await (
        await request(url, cookie, '/plugins/panel-sample/groups/virtual%3Aplayground%3Agroup%3A10', 'PUT', { enabled: false })
      ).json(),
    ).toEqual({ ok: true })
    expect(await (await request(url, cookie, '/plugins/panel-sample/groups')).json()).toEqual([
      { groupKey: 'virtual:playground:group:10', enabled: false },
    ])
    expect(await (await request(url, cookie, '/plugins/panel-sample/disable', 'POST')).json()).toMatchObject({
      state: 'disabled',
      config: { amount: 7 },
      commands: [],
    })
    expect((await fetch(`${url}/plugins/panel-sample/hello`)).status).toBe(404)
    expect(await (await request(url, cookie, '/plugins/panel-sample/enable', 'POST')).json()).toMatchObject({
      state: 'active',
    })
    expect((await fetch(`${url}/plugins/panel-sample/hello`)).status).toBe(200)
    const entry = { list: 'block', subject: 'user', key: 'playground:20' }
    expect((await request(url, cookie, '/acl', 'POST', entry)).status).toBe(200)
    expect(await (await request(url, cookie, '/acl')).json()).toContainEqual(entry)
    expect((await request(url, cookie, '/acl', 'DELETE', entry)).status).toBe(200)
    expect(await (await request(url, cookie, '/acl')).json()).not.toContainEqual(entry)
    expect((await request(url, cookie, '/acl', 'POST', { ...entry, key: 'virtual:99' })).status).toBe(409)
  })

  it('runs isolated prompt rounds with the real pipeline and excludes them from statistics', async () => {
    const { t, url } = await start()
    const cookie = await login(url)
    const say = async (text: string, user = '20', group: string | null = '10', superuser = false) =>
      (
        await (
          await request(url, cookie, '/playground', 'POST', { text, user: { id: user, superuser }, group })
        ).json()
      ).replies.map((reply: { text: string }) => reply.text)
    expect(await say('/dialog')).toEqual(['name?'])
    expect(await t.say('/ping')).toEqual(['pong'])
    expect(await say('Alice')).toEqual(['color?'])
    expect(await say('blue')).toEqual(['Alice:blue'])
    expect(await say('/secret')).toEqual(['权限不足'])
    expect(await say('/secret', '99', '10', true)).toEqual(['secret'])
    expect(await say('/limited')).toEqual(['limited'])
    expect(await say('/limited')).toEqual([expect.stringContaining('冷却中')])
    await request(url, cookie, '/plugins/panel-sample/groups/virtual%3Aplayground%3Agroup%3A10', 'PUT', {
      enabled: false,
    })
    expect(await say('/dialog')).toEqual([])
    await request(url, cookie, '/acl', 'POST', { list: 'block', subject: 'user', key: 'virtual:21' })
    expect(await say('/ping', '21', null)).toEqual([])
    const result = await (await request(url, cookie, '/overview')).json()
    expect(result.today).toEqual({ received: 1, sent: 1 })
    expect(await (await request(url, cookie, '/stats/messages?range=1h')).json()).toHaveLength(60)
    expect(await (await request(url, cookie, '/stats/messages?range=24h')).json()).toHaveLength(96)
  })

  it('accepts protocol-independent segments and nonnumeric targets', async () => {
    const { t, url } = await start()
    const cookie = await login(url)
    const message = [
      { type: 'at', data: { id: 'user-alice' } },
      { type: 'audio', data: { file: 'base64://AA==' } },
      { type: 'image', data: { file: 'https://example.invalid/image', extra: 2 } },
      { type: 'markdown', data: { content: '**hello**' } },
    ]
    expect(
      (
        await request(url, cookie, '/send', 'POST', {
          target: { platform: 'virtual', type: 'group', id: 'room-alpha' },
          message,
        })
      ).status,
    ).toBe(200)
    expect(t.mock.bot.sends.at(-1)).toMatchObject({ target: 'room-alpha', message })
    expect(
      (
        await request(url, cookie, '/send', 'POST', {
          target: { platform: 'virtual', type: 'private', id: 'user-alice' },
          message: [{ type: 'at', data: {} }],
        })
      ).status,
    ).toBe(400)
  })

  it('rejects local-file media from every HTTP message input', async () => {
    const { t, url } = await start()
    const cookie = await login(url)
    const before = t.mock.bot.sends.length
    for (const file of [
      'file:///etc/passwd',
      'FILE:C:/secrets.txt',
      '/etc/passwd',
      'C:\\Users\\bot\\.env',
      '\\\\host\\share\\a.png',
    ]) {
      const response = await request(url, cookie, '/send', 'POST', {
        target: { platform: 'virtual', type: 'group', id: '1' },
        message: [
          { type: 'text', data: { text: 'x' } },
          { type: 'file', data: { file } },
        ],
      })
      expect(response.status, file).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'BAD_REQUEST', issues: [{ path: 'message[1].data.file' }] },
      })
    }
    const namespaced = await request(url, cookie, '/send', 'POST', {
      target: 'virtual:group:1',
      message: [{ type: 'onebot11:image', data: { file: 'file:///etc/passwd' } }],
    })
    expect(namespaced.status).toBe(400)
    const playground = await request(url, cookie, '/playground', 'POST', {
      user: { id: '1' },
      message: [{ type: 'image', data: { file: 'file:///etc/passwd' } }],
    })
    expect(playground.status).toBe(400)
    const external = await fetch(`${url}/api/v1/send`, {
      method: 'POST',
      headers: { Authorization: 'Bearer api-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: { platform: 'virtual', type: 'group', id: '1' },
        message: [{ type: 'audio', data: { file: '/root/.env' } }],
      }),
    })
    expect(external.status).toBe(400)
    expect(t.mock.bot.sends.length).toBe(before)
  })

  it('pushes hello then messages and sends through the authenticated external API', async () => {
    const { t, url } = await start()
    const cookie = await login(url)
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/api/panel/ws`, {
      headers: { Cookie: cookie },
    })
    const second = new WebSocket(`${url.replace('http:', 'ws:')}/api/panel/ws`, {
      headers: { Cookie: cookie },
    })
    const secondHello = new Promise<void>((resolve, reject) => {
      second.once('message', (data) => {
        if (JSON.parse(data.toString()).type === 'hello') resolve()
        else reject(new Error('Second client did not receive hello first'))
      })
      second.once('error', reject)
    })
    const frames: Record<string, unknown>[] = []
    let notify: (() => void) | undefined
    socket.on('message', (data) => {
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>)
      notify?.()
    })
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      while (!predicate())
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Timed out waiting for WS frame')), 2_000)
          notify = () => {
            clearTimeout(timer)
            notify = undefined
            resolve()
          }
        })
    }
    try {
      await waitFor(() => frames.length > 0)
      await secondHello
      expect(frames[0]).toMatchObject({ type: 'hello', overview: { bots: expect.any(Array) } })
      second.terminate()
      await t.say('hello')
      await waitFor(() => frames.some((frame) => frame.type === 'message'))
      expect(frames.find((frame) => frame.type === 'message')).toMatchObject({
        direction: 'in',
        channel: { type: 'group', id: '10' },
        userId: '20',
        preview: 'hello',
      })
      expect((await fetch(`${url}/api/v1/bots`)).status).toBe(401)
      const response = await fetch(`${url}/api/v1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer api-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'virtual:group:123', message: 'from api' }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ messageId: expect.any(String) })
      expect(t.mock.bot.sends.at(-1)).toMatchObject({
        type: 'group',
        target: '123',
        message: [{ type: 'text', data: { text: 'from api' } }],
      })
      await waitFor(() => frames.some((frame) => frame.type === 'message' && frame.direction === 'out'))

      const mock = new MockOneBot({ userId: '10001' })
      onebotMocks.push(mock)
      await mock.ready
      const online = new Promise<void>((resolve) => {
        const unsubscribe = t.app.events.on('bot.online', (event) => {
          if (event.platform === 'onebot11') {
            unsubscribe()
            resolve()
          }
        })
      })
      t.app.useAdapter(
        new OneBotAdapter(
          onebot11Schema.parse({
            connections: [{ type: 'forward', url: mock.url }],
            sendQueue: { interval: 0 },
          }),
          t.app,
        ),
      )
      await online
      const bot = t.app.getBot('onebot11', '10001')
      if (!bot) throw new Error('OneBot did not come online')
      const bots = await (await request(url, cookie, '/bots')).json()
      expect(bots.find((item: { platform: string }) => item.platform === 'onebot11')).toMatchObject({
        capabilities: {
          segments: expect.arrayContaining(['onebot11:*']),
          textStyles: [],
          actions: expect.arrayContaining(['sendGroup']),
        },
      })
      await waitFor(() => frames.some((frame) => frame.type === 'bot'))
      expect(frames.find((frame) => frame.type === 'bot')).toMatchObject({
        bot: { capabilities: { segments: expect.arrayContaining(['onebot11:*']) } },
      })
      mock.emitGroupMessage({ groupId: '200', userId: '300', message: 'from user' })
      await waitFor(() => frames.some((frame) => frame.type === 'message' && frame.preview === 'from user'))
      await bot.sendPrivate('400', 'from bot')
      await waitFor(() => frames.some((frame) => frame.type === 'message' && frame.preview === 'from bot'))
      expect({
        virtualViewHasAvatar: Object.hasOwn(
          bots.find((item: { platform: string }) => item.platform === 'virtual'),
          'avatar',
        ),
        virtualMessageHasAvatar: Object.hasOwn(
          frames.find((frame) => frame.preview === 'hello') ?? {},
          'avatar',
        ),
        bot: bots.find((item: { platform: string }) => item.platform === 'onebot11').avatar,
        incoming: frames.find((frame) => frame.preview === 'from user')?.avatar,
        outgoing: frames.find((frame) => frame.preview === 'from bot')?.avatar,
        invalid: ['', '123\n', '123x', '１２３'].map((id) => bot.getAvatarUrl?.(id)),
      }).toEqual({
        virtualViewHasAvatar: false,
        virtualMessageHasAvatar: false,
        bot: 'https://q1.qlogo.cn/g?b=qq&nk=10001&s=100',
        incoming: 'https://q1.qlogo.cn/g?b=qq&nk=300&s=100',
        outgoing: 'https://q1.qlogo.cn/g?b=qq&nk=10001&s=100',
        invalid: [undefined, undefined, undefined, undefined],
      })

      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
      expect((await request(url, cookie, '/logout', 'POST')).status).toBe(200)
      await closed
    } finally {
      socket.terminate()
      second.terminate()
    }
  })
})
