import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OneBotAdapter } from '../src/adapters/onebot11/adapter.ts'
import { createApp } from '../src/bootstrap.ts'
import { App } from '../src/core/app.ts'
import { isOneBot } from '../src/core/bot.ts'
import { configSchema } from '../src/core/config/schema.ts'
import { type ApiError, ApiTimeoutError, NotConnectedError } from '../src/core/errors.ts'
import type { Session } from '../src/core/event/index.ts'
import { createLogger } from '../src/core/logger.ts'
import { seg } from '../src/core/message/index.ts'
import { MockOneBot } from '../src/testing/mock-onebot.ts'

const resources: Array<{ app: App; mock: MockOneBot }> = []

afterEach(async () => {
  for (const { app, mock } of resources.splice(0)) {
    try {
      await app.stop()
    } finally {
      await mock.close()
    }
  }
})

async function setup(options: ConstructorParameters<typeof MockOneBot>[0] = {}) {
  const mock = new MockOneBot(options)
  await mock.ready
  const config = configSchema.parse({
    onebot11: {
      apiTimeout: 100,
      reconnect: { minDelay: 10, maxDelay: 30 },
      connections: [{ type: 'forward', url: mock.url, accessToken: 'test-token' }],
    },
  })
  const app = createApp(config)
  resources.push({ app, mock })
  const online = waitForEvent(app, 'bot.online')
  await app.start()
  const event = await online
  expect(event.bot.selfId).toBe(options?.userId ?? '10000')
  return { app, mock, config }
}

function waitForEvent(app: App, name: 'bot.online' | 'bot.offline') {
  return new Promise<{ bot: { selfId: string } }>((resolve) => {
    app.events.on(name, (event) => resolve(event))
  })
}

describe('OneBot forward adapter', () => {
  it('connects, converts a group message, and replies with a quote', async () => {
    const { app, mock } = await setup({ token: 'test-token', userId: '10001' })
    const sessionPromise = new Promise<{
      messageId: string
      userId: string
      groupId?: string
      text: string
      toMe: boolean
      sender: { nickname: string; role?: string }
    }>((resolve) => {
      app.events.on('message.group', async (session) => {
        if (session.text === 'hello') {
          await session.reply('world')
          resolve(session)
        }
      })
    })
    mock.emitGroupMessage({
      groupId: '200',
      userId: '300',
      nickname: 'Alice',
      role: 'admin',
      message: 'hello',
    })
    const session = await sessionPromise
    expect(session).toMatchObject({
      messageId: expect.any(String),
      userId: '300',
      groupId: '200',
      text: 'hello',
      toMe: false,
      sender: { userId: '300', nickname: 'Alice', role: 'admin' },
    })
    const call = await mock.waitForCall('send_group_msg', (item) => item.params.group_id === 200)
    expect(call.params.message).toEqual([
      { type: 'reply', data: { id: Number(session.messageId) } },
      { type: 'text', data: { text: 'world' } },
    ])
  })

  it('raises timeout and API errors from typed calls', async () => {
    const { app, mock } = await setup({ token: 'test-token' })
    const bot = app.bots.list()[0]
    if (bot === undefined) throw new Error('bot did not come online')
    const never = mock.onCall('get_group_list', () => new Promise(() => {}))
    await expect(bot.getGroupList()).rejects.toBeInstanceOf(ApiTimeoutError)
    never()
    const failed = mock.onCall('get_version_info', () => ({ status: 'ok', retcode: 42, wording: 'failed' }))
    await expect(bot.call('get_version_info')).rejects.toMatchObject({
      name: 'ApiError',
      action: 'get_version_info',
      retcode: 42,
      wording: 'failed',
    } satisfies Partial<ApiError>)
    failed()
  })

  it('marks mentions and replies to sent messages as addressed to the bot', async () => {
    const { app, mock } = await setup({ token: 'test-token', userId: '10001' })
    const bot = app.bots.list()[0]
    if (bot === undefined || !isOneBot(bot)) throw new Error('OneBot did not come online')
    const sentEvent = new Promise<string>((resolve) => {
      app.events.on('bot.message.sent', (event) => resolve(event.messageId))
    })
    const sent = await bot.onebot.sendGroupMsg('200', 'previous')
    expect(await sentEvent).toBe(sent.messageId)

    const replySession = new Promise<Session>((resolve) => {
      app.events.on('message.group', (session) => {
        if (session.text === 'reference') resolve(session)
      })
    })
    mock.emitGroupMessage({
      groupId: '200',
      userId: '300',
      message: [seg.reply(sent.messageId), seg.text('reference')],
    })
    expect((await replySession).toMe).toBe(true)

    const mentionSession = new Promise<Session>((resolve) => {
      app.events.on('message.group', (session) => {
        if (session.text === 'mention') resolve(session)
      })
    })
    mock.emitGroupMessage({ groupId: '200', userId: '300', message: [seg.at('10001'), seg.text('mention')] })
    const session = await mentionSession
    expect(session.toMe).toBe(true)
    await session.reply('ok', { at: true })
    const call = await mock.waitForCall(
      'send_group_msg',
      (item) =>
        Array.isArray(item.params.message) &&
        item.params.message.some((part: { type: string }) => part.type === 'at'),
    )
    expect(call.params.message).toEqual([
      { type: 'reply', data: { id: Number(session.messageId) } },
      { type: 'at', data: { qq: 300 } },
      { type: 'text', data: { text: 'ok' } },
    ])
  })

  it('normalizes local media and treats a string as plain text', async () => {
    const { app, mock } = await setup({ token: 'test-token' })
    const bot = app.bots.list()[0]
    if (bot === undefined) throw new Error('bot did not come online')
    const directory = await mkdtemp(join(tmpdir(), 'asabot-media-'))
    const file = join(directory, 'image.bin')
    await writeFile(file, Buffer.from('media'))
    try {
      await bot.sendGroup('200', [seg.image(file), seg.record(Buffer.from('record'))])
      const call = await mock.waitForCall('send_group_msg')
      expect(call.params.message).toEqual([
        { type: 'image', data: { file: 'base64://bWVkaWE=' } },
        { type: 'record', data: { file: 'base64://cmVjb3Jk' } },
      ])
      await bot.sendPrivate('300', '[CQ:at,qq=10000]')
      const plain = await mock.waitForCall('send_private_msg')
      expect(plain.params.message).toEqual([{ type: 'text', data: { text: '[CQ:at,qq=10000]' } }])
    } finally {
      await unlink(file)
      await rmdir(directory)
    }
  })

  it('passes received media and forward segments through unchanged when re-sent', async () => {
    const { app, mock } = await setup({ token: 'test-token' })
    const received = new Promise<Session>((resolve) => {
      app.events.on('message.group', (session) => resolve(session))
    })
    // NapCat reports images by platform file name plus URL, and forwards by an opaque string resid.
    mock.emitGroupMessage({
      groupId: '200',
      userId: '300',
      message: [
        { type: 'image', data: { file: 'ABCDEF0123.jpg', url: 'https://example.invalid/i.jpg' } },
        { type: 'forward', data: { id: 'Tsx8resid' } },
      ],
    })
    const session = await received
    await session.send(session.message)
    const call = await mock.waitForCall('send_group_msg')
    expect(call.params.message).toEqual([
      { type: 'image', data: { file: 'ABCDEF0123.jpg', url: 'https://example.invalid/i.jpg' } },
      { type: 'forward', data: { id: 'Tsx8resid' } },
    ])
  })

  it('delivers events that arrive before login completes', async () => {
    const mock = new MockOneBot({ token: 'test-token' })
    await mock.ready
    // Push a message while get_login_info is still in flight.
    mock.onCall('get_login_info', async () => {
      mock.emitGroupMessage({ groupId: '200', userId: '300', message: 'early' })
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { user_id: 10000, nickname: 'MockBot' }
    })
    const config = configSchema.parse({
      onebot11: {
        apiTimeout: 500,
        reconnect: { minDelay: 10, maxDelay: 30 },
        connections: [{ type: 'forward', url: mock.url, accessToken: 'test-token' }],
      },
    })
    const app = createApp(config)
    resources.push({ app, mock })
    const early = new Promise<string>((resolve) => {
      app.events.on('message.group', (session) => resolve(session.text))
    })
    await app.start()
    await expect(early).resolves.toBe('early')
  })

  it('keeps sent-message events of the bot out of message listeners', async () => {
    const { app, mock } = await setup({ token: 'test-token' })
    const bot = app.bots.list()[0]
    if (bot === undefined) throw new Error('bot did not come online')
    const names: string[] = []
    app.events.on('message', (event) => {
      names.push(event.name)
    })
    const sent = new Promise<string>((resolve) => {
      app.events.on('bot.message.sent', (event) => resolve(event.messageId))
    })
    const received = new Promise<void>((resolve) => {
      app.events.on('message.group', () => resolve())
    })
    await bot.sendGroup('200', 'outgoing')
    await expect(sent).resolves.toEqual(expect.any(String))
    mock.emitGroupMessage({ groupId: '200', userId: '300', message: 'incoming' })
    await received
    expect(names).toEqual(['message.group'])
  })

  it('dispatches all matching event levels and isolates synchronous listener errors', async () => {
    const { app } = await setup({ token: 'test-token' })
    const bot = app.bots.list()[0]
    if (bot === undefined) throw new Error('bot did not come online')
    const logged = vi.spyOn(app.logger, 'error').mockImplementation(() => {})
    const received: string[] = []
    app.events.on('notice', () => {
      received.push('notice')
      throw new Error('listener failure')
    })
    app.events.on('notice.notify', async () => {
      await Promise.resolve()
      received.push('notify')
    })
    app.events.on('notice.notify.poke', (event) => received.push(event.targetId))
    await app.events.emit({
      id: crypto.randomUUID(),
      platform: bot.platform,
      selfId: bot.selfId,
      time: Date.now(),
      kind: 'notice',
      name: 'notice.notify.poke',
      noticeType: 'notify',
      subType: 'poke',
      userId: '1',
      targetId: bot.selfId,
      raw: {},
      bot,
    })
    expect(received).toEqual(expect.arrayContaining(['notice', 'notify', bot.selfId]))
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'notice.notify.poke' }),
      'Event listener failed',
    )
    logged.mockRestore()
  })

  it('converts notices, requests and typed API results', async () => {
    const { app, mock } = await setup({ token: 'test-token', userId: '10001' })
    const bot = app.bots.list()[0]
    if (bot === undefined || !isOneBot(bot)) throw new Error('OneBot did not come online')
    expect(await bot.onebot.getVersionInfo()).toEqual({
      appName: 'MockOneBot',
      appVersion: '1',
      protocolVersion: 'v11',
    })
    expect(await bot.onebot.getMsg('123')).toMatchObject({ messageId: '123', sender: { userId: '10001' } })
    const poke = new Promise<{ userId: string; targetId: string; groupId?: string }>((resolve) => {
      app.events.on('notice.notify.poke', (event) => resolve(event))
    })
    mock.emitNotice({
      notice_type: 'notify',
      sub_type: 'poke',
      group_id: 200,
      user_id: 300,
      target_id: 10001,
    })
    expect(await poke).toMatchObject({ userId: '300', targetId: '10001', groupId: '200' })

    const request = new Promise<void>((resolve) => {
      app.events.on('request.group.invite', async (event) => {
        await event.approve()
        resolve()
      })
    })
    mock.push({
      post_type: 'request',
      request_type: 'group',
      sub_type: 'invite',
      group_id: 200,
      user_id: 300,
      flag: 'flag',
    })
    await request
    const call = await mock.waitForCall('set_group_add_request')
    expect(call.params).toMatchObject({ flag: 'flag', sub_type: 'invite', approve: true })
  })

  it('rejects pending calls on disconnect and reconnects the same bot', async () => {
    const { app, mock } = await setup({ token: 'test-token', userId: '10001' })
    const bot = app.bots.list()[0]
    if (bot === undefined) throw new Error('bot did not come online')
    const offline = waitForEvent(app, 'bot.offline')
    const nextOnline = waitForEvent(app, 'bot.online')
    const never = mock.onCall('get_group_list', () => new Promise(() => {}))
    const pending = bot.getGroupList()
    await mock.waitForCall('get_group_list')
    mock.dropConnections()
    await expect(pending).rejects.toBeInstanceOf(NotConnectedError)
    await offline
    await nextOnline
    expect(app.bots.list()[0]).toBe(bot)
    never()
  })

  it('replaces the registered bot when a connection logs in as another account', async () => {
    const { app, mock } = await setup({ token: 'test-token', userId: '10001' })
    const oldBot = app.bots.list()[0]
    if (oldBot === undefined) throw new Error('bot did not come online')
    mock.onCall('get_login_info', () => ({ user_id: 10002, nickname: 'New account' }))
    const offline = waitForEvent(app, 'bot.offline')
    const online = waitForEvent(app, 'bot.online')
    mock.dropConnections()
    await offline
    const event = await online
    expect(event.bot.selfId).toBe('10002')
    expect(app.getBot('onebot11', '10001')).toBeUndefined()
    expect(app.getBot('onebot11', '10002')).not.toBe(oldBot)
    await expect(oldBot.sendGroup('200', 'old account')).rejects.toBeInstanceOf(NotConnectedError)
    await expect(oldBot.sendGroup('200', seg.image('missing-file'))).rejects.toBeInstanceOf(NotConnectedError)
  })

  it('reconnects when the server stops responding to ping and does not reconnect after stop', async () => {
    const mock = new MockOneBot({ token: 'test-token', respondToPing: false })
    await mock.ready
    const config = configSchema.parse({
      onebot11: {
        apiTimeout: 100,
        reconnect: { minDelay: 10, maxDelay: 20 },
        connections: [{ type: 'forward', url: mock.url, accessToken: 'test-token' }],
      },
    })
    const app = new App(config)
    app.useAdapter(
      new OneBotAdapter(config.onebot11, app, {
        pingInterval: 15,
        pongTimeout: 15,
        heartbeatCheckInterval: 5,
        heartbeatTimeoutMultiplier: 2,
        stableTime: 30,
      }),
    )
    resources.push({ app, mock })
    const onlineCount = { value: 0 }
    app.events.on('bot.online', () => {
      onlineCount.value += 1
    })
    await app.start()
    const offline = waitForEvent(app, 'bot.offline')
    await offline
    const reconnect = waitForEvent(app, 'bot.online')
    await reconnect
    const countAfterReconnect = onlineCount.value
    const callCount = mock.calls.filter((call) => call.action === 'get_login_info').length
    await app.stop()
    expect(app.bots.list()).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(onlineCount.value).toBe(countAfterReconnect)
    expect(mock.calls.filter((call) => call.action === 'get_login_info')).toHaveLength(callCount)
  })

  it('reconnects when heartbeats stop after being received', async () => {
    const mock = new MockOneBot({ token: 'test-token', heartbeat: true, heartbeatInterval: 20 })
    await mock.ready
    const config = configSchema.parse({
      onebot11: {
        apiTimeout: 100,
        reconnect: { minDelay: 10, maxDelay: 20 },
        connections: [{ type: 'forward', url: mock.url, accessToken: 'test-token' }],
      },
    })
    const app = new App(config)
    app.useAdapter(new OneBotAdapter(config.onebot11, app, { heartbeatCheckInterval: 5 }))
    resources.push({ app, mock })
    const heartbeat = new Promise<void>((resolve) => app.events.on('meta.heartbeat', () => resolve()))
    const offline = waitForEvent(app, 'bot.offline')
    const online = waitForEvent(app, 'bot.online')
    await app.start()
    await online
    await heartbeat
    const reconnect = waitForEvent(app, 'bot.online')
    mock.setHeartbeat(false)
    await offline
    await reconnect
  })

  it('backs off quietly when authentication fails', async () => {
    const mock = new MockOneBot({ token: 'right-token' })
    await mock.ready
    let output = ''
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    })
    const config = configSchema.parse({
      onebot11: {
        reconnect: { minDelay: 5, maxDelay: 10 },
        connections: [
          {
            type: 'forward',
            url: `${mock.url}?access_token=url-secret&other=ok`,
            accessToken: 'wrong-token',
          },
        ],
      },
    })
    const app = createApp(config, { logger: createLogger({ level: 'debug', destination, pretty: false }) })
    resources.push({ app, mock })
    await app.start()
    await vi.waitFor(() => expect(mock.connectionAttempts).toBeGreaterThan(1), {
      interval: 10,
      timeout: 1_000,
    })
    expect(app.bots.list()).toHaveLength(0)
    expect(output).not.toContain('url-secret')
    expect(output).not.toContain('wrong-token')
    expect(output).toContain('other=ok')
  })
})
