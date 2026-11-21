import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { Logger } from 'pino'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { OneBotAdapter } from '../src/adapters/onebot11/adapter.ts'
import { onebot11Schema } from '../src/adapters/onebot11/config.ts'
import { MockOneBot } from '../src/adapters/onebot11/testing.ts'
import { createApp } from '../src/bootstrap.ts'
import type { App } from '../src/core/app.ts'
import type { Bot } from '../src/core/bot.ts'
import { configSchema } from '../src/core/config/schema.ts'
import { NotConnectedError, SendQueueFullError } from '../src/core/errors.ts'
import { HttpServer } from '../src/server/index.ts'

const apps: App[] = []
const mocks: MockOneBot[] = []
const directories: string[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop()
  for (const mock of mocks.splice(0)) await mock.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function mock(options: ConstructorParameters<typeof MockOneBot>[0] = {}): Promise<MockOneBot> {
  const instance = new MockOneBot(options)
  mocks.push(instance)
  await instance.ready
  return instance
}

async function setup(
  options: {
    token?: string
    interval?: number
    jitter?: number
    maxPending?: number
    forwardUrl?: string
    logger?: Logger
    liveness?: { pingInterval?: number; pongTimeout?: number; heartbeatCheckInterval?: number }
  } = {},
): Promise<{ app: App; url: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'asabot-m5-'))
  directories.push(directory)
  const config = configSchema.parse({
    dataDir: directory,
    pluginLoader: { dirs: [], hotReload: false },
    server: { port: 0 },
  })
  const settings = onebot11Schema.parse({
    apiTimeout: 1_000,
    reconnect: { minDelay: 15, maxDelay: 30 },
    connections: options.forwardUrl ? [{ type: 'forward', url: options.forwardUrl }] : [],
    reverse: { enabled: true, accessToken: options.token ?? 'reverse-secret' },
    sendQueue: {
      interval: options.interval ?? 0,
      jitter: options.jitter ?? 0,
      maxPending: options.maxPending ?? 100,
    },
  })
  const logger = options.logger ?? pino({ level: 'silent' })
  const app = createApp(config, { logger })
  app.useAdapter(new OneBotAdapter(settings, app, options.liveness))
  app.useServer(new HttpServer(app))
  apps.push(app)
  await app.start()
  const port = app.server?.address()?.port
  if (port === undefined) throw new Error('HTTP server did not start')
  return { app, url: `ws://127.0.0.1:${port}/onebot/v11/ws` }
}

async function online(app: App, selfId: string): Promise<Bot> {
  await vi.waitFor(() => expect(app.getBot('onebot11', selfId)?.status).toBe('online'), { interval: 5 })
  const bot = app.getBot('onebot11', selfId)
  if (bot === undefined) throw new Error('Bot did not come online')
  return bot
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) =>
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  )
}

function rejectedUpgrade(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    socket.on('error', () => {})
    socket.once('open', () => {
      socket.close()
      reject(new Error('Unexpected successful upgrade'))
    })
    socket.once('unexpected-response', (_request, response) => {
      let body = ''
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      response.once('end', () => {
        resolve({ status: response.statusCode ?? 0, body })
        socket.terminate()
      })
    })
  })
}

describe('OneBot reverse WebSocket', () => {
  it('serves two accounts independently and routes each reply to its own connection', async () => {
    const { app, url } = await setup()
    const first = await mock({ userId: '10001', token: 'reverse-secret' })
    const second = await mock({ userId: '10002', token: 'reverse-secret' })
    app.events.on('message.group', async (session) => session.send(`reply:${session.selfId}`))
    await Promise.all([first.connectReverse(url), second.connectReverse(url)])
    const bots = await Promise.all([online(app, '10001'), online(app, '10002')])
    expect(app.bots.list()).toHaveLength(2)
    for (const bot of bots) expect(app.getBotInfo(bot)).toEqual({ connection: '反向 WS' })
    first.emitGroupMessage({ groupId: '10', userId: '20', message: 'hello' })
    second.emitGroupMessage({ groupId: '11', userId: '21', message: 'hello' })
    const [firstCall, secondCall] = await Promise.all([
      first.waitForCall('send_group_msg'),
      second.waitForCall('send_group_msg'),
    ])
    expect(firstCall.params).toMatchObject({
      group_id: 10,
      message: [{ type: 'text', data: { text: 'reply:10001' } }],
    })
    expect(secondCall.params).toMatchObject({
      group_id: 11,
      message: [{ type: 'text', data: { text: 'reply:10002' } }],
    })
  })

  it('authenticates headers or query tokens and rejects invalid identity or split roles', async () => {
    const { app, url } = await setup()
    const auth = { Authorization: 'Bearer reverse-secret' }
    expect((await rejectedUpgrade(url, { Authorization: 'Bearer wrong', 'X-Self-ID': '10001' })).status).toBe(
      401,
    )
    expect((await rejectedUpgrade(url, auth)).status).toBe(400)
    expect((await rejectedUpgrade(url, { ...auth, 'X-Self-ID': 'abc' })).status).toBe(400)
    const role = await rejectedUpgrade(url, { ...auth, 'X-Self-ID': '10001', 'X-Client-Role': 'API' })
    expect(role.status).toBe(400)
    expect(role.body).toContain('split API/Event')
    const client = await mock({ userId: '10001' })
    await client.connectReverse(`${url}?access_token=reverse-secret`, { role: null })
    await online(app, '10001')
  })

  it('warns for an empty token and never writes the configured token to logs', async () => {
    let output = ''
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    })
    const logger = pino({ level: 'debug' }, destination)
    const unauthenticated = await setup({ token: '', logger })
    const client = await mock({ userId: '10001' })
    await client.connectReverse(unauthenticated.url)
    await online(unauthenticated.app, '10001')
    expect(output).toContain('反向 WS 未设置 token')

    const authenticated = await setup({ token: 'secret-m5-token', logger })
    const failing = await mock({ userId: '10002' })
    failing.onCall('get_login_info', () => {
      throw new Error('secret-m5-token')
    })
    const socket = await failing.connectReverse(`${authenticated.url}?access_token=secret-m5-token`)
    await closed(socket)
    await vi.waitFor(() => expect(output).toContain('OneBot login failed'), { interval: 5 })
    expect(output).not.toContain('secret-m5-token')
  })

  it('closes a connection whose login does not match X-Self-ID', async () => {
    const { app, url } = await setup()
    const legitimate = await mock({ userId: '10002', token: 'reverse-secret' })
    await legitimate.connectReverse(url)
    const bot = await online(app, '10002')
    const client = await mock({ userId: '10001', token: 'reverse-secret' })
    const socket = await client.connectReverse(url, { selfId: '10002' })
    expect((await closed(socket)).code).toBe(1008)
    expect(app.bots.list()).toEqual([bot])
    await expect(bot.getSelf()).resolves.toMatchObject({ userId: '10002' })
  })

  it('retains the Bot instance after a disconnect and reconnect', async () => {
    const { app, url } = await setup()
    const client = await mock({ userId: '10001', token: 'reverse-secret' })
    const socket = await client.connectReverse(url)
    const bot = await online(app, '10001')
    const close = closed(socket)
    socket.close(1000, 'restart')
    await close
    await vi.waitFor(() => expect(bot.status).toBe('offline'), { interval: 5 })
    await client.connectReverse(url)
    expect(await online(app, '10001')).toBe(bot)
    await expect(bot.getSelf()).resolves.toMatchObject({ userId: '10001' })
  })

  it('replaces an existing reverse connection and rejects its pending calls and queued sends', async () => {
    const { app, url } = await setup({ interval: 100, maxPending: 2 })
    const first = await mock({ userId: '10001', token: 'reverse-secret' })
    const second = await mock({ userId: '10001', token: 'reverse-secret' })
    const socket = await first.connectReverse(url)
    const bot = await online(app, '10001')
    await bot.sendGroup('10', 'first')
    first.onCall('get_group_list', () => new Promise(() => {}))
    const pending = expect(bot.getGroupList()).rejects.toBeInstanceOf(NotConnectedError)
    await first.waitForCall('get_group_list')
    const queued = expect(bot.sendGroup('10', 'queued')).rejects.toMatchObject({
      code: 'NO_BOT_ONLINE',
      outcome: 'not_sent',
    })
    const close = closed(socket)
    await second.connectReverse(url)
    expect(await close).toEqual({ code: 1000, reason: 'replaced' })
    await Promise.all([pending, queued])
    expect(await online(app, '10001')).toBe(bot)
    await bot.sendGroup('10', 'new connection')
    expect((await second.waitForCall('send_group_msg')).params.group_id).toBe(10)
  })

  it('replaces an older reverse login that is still pending', async () => {
    const { app, url } = await setup()
    const first = await mock({ userId: '10001', token: 'reverse-secret' })
    const second = await mock({ userId: '10001', token: 'reverse-secret' })
    first.onCall('get_login_info', () => new Promise(() => {}))
    const socket = await first.connectReverse(url)
    const close = closed(socket)
    await first.waitForCall('get_login_info')
    await second.connectReverse(url)
    const bot = await online(app, '10001')
    expect(await close).toEqual({ code: 1000, reason: 'replaced' })
    await expect(bot.getSelf()).resolves.toMatchObject({ userId: '10001' })
  })

  it('keeps the first online transport as owner and transfers the same Bot after it disconnects', async () => {
    const forward = await mock({ userId: '10001' })
    const { app, url } = await setup({ forwardUrl: forward.url })
    const bot = await online(app, '10001')
    const reverse = await mock({ userId: '10001', token: 'reverse-secret' })
    const rejected = await reverse.connectReverse(url)
    await closed(rejected)
    expect(bot.status).toBe('online')
    expect(app.getBotInfo(bot)?.connection).toBe('正向 WS')
    await forward.close()
    await vi.waitFor(() => expect(bot.status).toBe('offline'), { interval: 5 })
    await reverse.connectReverse(url)
    expect(await online(app, '10001')).toBe(bot)
    expect(app.getBotInfo(bot)).toEqual({ connection: '反向 WS' })
  })

  it('keeps a reverse Bot while a forward connection retries, then allows the forward connection to take over', async () => {
    const forward = await mock({ userId: '10001' })
    let releaseLogin: ((value: unknown) => void) | undefined
    let firstLogin = true
    forward.onCall('get_login_info', () => {
      if (!firstLogin) return { user_id: 10001, nickname: 'Forward' }
      firstLogin = false
      return new Promise((resolve) => {
        releaseLogin = resolve
      })
    })
    const { app, url } = await setup({ forwardUrl: forward.url })
    await forward.waitForCall('get_login_info')
    const reverse = await mock({ userId: '10001', token: 'reverse-secret' })
    const socket = await reverse.connectReverse(url)
    const bot = await online(app, '10001')
    if (releaseLogin === undefined) throw new Error('Forward login was not requested')
    releaseLogin({ user_id: 10001, nickname: 'Forward' })
    await vi.waitFor(
      () =>
        expect(forward.calls.filter((call) => call.action === 'get_login_info').length).toBeGreaterThan(1),
      { interval: 5 },
    )
    expect(bot.status).toBe('online')
    expect(app.getBotInfo(bot)).toEqual({ connection: '反向 WS' })
    const close = closed(socket)
    socket.close(1000, 'restart')
    await close
    await vi.waitFor(
      () => {
        expect(app.getBot('onebot11', '10001')).toBe(bot)
        expect(bot.status).toBe('online')
        expect(app.getBotInfo(bot)?.connection).toBe('正向 WS')
      },
      { interval: 5 },
    )
  })

  it('closes reverse clients during app.stop()', async () => {
    const { app, url } = await setup()
    const client = await mock({ token: 'reverse-secret' })
    const socket = await client.connectReverse(url)
    await online(app, '10000')
    const close = closed(socket)
    await app.stop()
    expect(await close).toMatchObject({ code: 1000 })
    expect(app.bots.list()).toHaveLength(0)
    expect(app.server?.address()).toBeNull()
  })

  it('closes reverse clients when ping or heartbeat liveness fails', async () => {
    const { app, url } = await setup({
      liveness: { pingInterval: 15, pongTimeout: 15, heartbeatCheckInterval: 5 },
    })
    const noPong = await mock({ userId: '10001', token: 'reverse-secret', respondToPing: false })
    const socket = await noPong.connectReverse(url)
    const close = closed(socket)
    await online(app, '10001')
    await close
    await vi.waitFor(() => expect(app.getBot('onebot11', '10001')?.status).toBe('offline'), { interval: 5 })

    const heartbeat = await mock({
      userId: '10002',
      token: 'reverse-secret',
      heartbeat: true,
      heartbeatInterval: 20,
    })
    const heartbeatSocket = await heartbeat.connectReverse(url)
    const heartbeatClose = closed(heartbeatSocket)
    const received = new Promise<void>((resolve) => app.events.on('meta.heartbeat', () => resolve()))
    await online(app, '10002')
    await received
    heartbeat.setHeartbeat(false)
    await heartbeatClose
    await vi.waitFor(() => expect(app.getBot('onebot11', '10002')?.status).toBe('offline'), { interval: 5 })
  })
})

describe('OneBot send queue', () => {
  it('rejects overflow and queued requests on disconnect', async () => {
    const { app, url } = await setup({ interval: 1_000, maxPending: 1 })
    const client = await mock({ token: 'reverse-secret' })
    await client.connectReverse(url)
    const bot = await online(app, '10000')
    await bot.sendGroup('10', 'first')
    const queued = expect(bot.sendGroup('10', 'queued')).rejects.toMatchObject({
      code: 'NO_BOT_ONLINE',
      outcome: 'not_sent',
    })
    await expect(bot.sendGroup('10', 'overflow')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      outcome: 'not_sent',
    })
    client.dropConnections()
    await queued
    expect(client.calls.filter((call) => call.action === 'send_group_msg')).toHaveLength(1)
  })

  it('applies the queue to each supported raw send action', async () => {
    const { app, url } = await setup({ interval: 1_000, maxPending: 0 })
    const client = await mock({ token: 'reverse-secret' })
    await client.connectReverse(url)
    const bot = await online(app, '10000')
    await bot.sendGroup('10', 'first')
    for (const action of [
      'send_private_msg',
      'send_group_msg',
      'send_msg',
      'send_group_forward_msg',
      'send_private_forward_msg',
    ]) {
      await expect(bot.call(action)).rejects.toBeInstanceOf(SendQueueFullError)
    }
    await expect(bot.getGroupList()).resolves.toEqual([])
  })

  it('does not wait for earlier responses when rate limiting is disabled', async () => {
    const { app, url } = await setup({ interval: 0, maxPending: 0 })
    const client = await mock({ token: 'reverse-secret' })
    client.onCall('send_group_msg', () => new Promise(() => {}))
    await client.connectReverse(url)
    const bot = await online(app, '10000')
    const unconfirmed = { code: 'DELIVERY_UNCONFIRMED', outcome: 'unknown' }
    const first = expect(bot.sendGroup('10', 'first')).rejects.toMatchObject(unconfirmed)
    const second = expect(bot.sendGroup('10', 'second')).rejects.toMatchObject(unconfirmed)
    await vi.waitFor(
      () => expect(client.calls.filter((call) => call.action === 'send_group_msg')).toHaveLength(2),
      { interval: 5 },
    )
    client.dropConnections()
    await Promise.all([first, second])
  })
})
