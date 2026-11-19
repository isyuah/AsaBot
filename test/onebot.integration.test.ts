import { mkdtemp, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OneBotAdapter } from '../src/adapters/onebot11/adapter.ts'
import { type ApiError, isOneBot, onebot11Schema } from '../src/adapters/onebot11/index.ts'
import { MockOneBot } from '../src/adapters/onebot11/testing.ts'
import { createApp } from '../src/bootstrap.ts'
import { App } from '../src/core/app.ts'
import { configSchema } from '../src/core/config/schema.ts'
import { ApiTimeoutError, NotConnectedError } from '../src/core/errors.ts'
import type { EventMap, NoticeEvent, RequestEvent, Session } from '../src/core/event/index.ts'
import { createLogger } from '../src/core/logger.ts'
import { plainText, seg } from '../src/core/message/index.ts'
import { definePlugin, type PluginDefinition } from '../src/core/plugin/definition.ts'

const resources: Array<{ app: App; mock: MockOneBot }> = []
const dataDirectories: string[] = []

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'asabot-onebot-'))
  dataDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const { app, mock } of resources.splice(0)) {
    try {
      await app.stop()
    } finally {
      await mock.close()
    }
  }
  for (const directory of dataDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function setup(
  options: ConstructorParameters<typeof MockOneBot>[0] = {},
  plugins: PluginDefinition[] = [],
) {
  const mock = new MockOneBot(options)
  await mock.ready
  const config = configSchema.parse({
    dataDir: await dataDirectory(),
    pluginLoader: { dirs: [], hotReload: false },
    connections: [
      {
        id: 'primary',
        name: 'OneBot',
        adapter: 'onebot11',
        config: {
          apiTimeout: 100,
          reconnect: { minDelay: 10, maxDelay: 30 },
          type: 'forward',
          url: mock.url,
          accessToken: 'test-token',
        },
      },
    ],
  })
  const app = createApp(config)
  for (const plugin of plugins) app.plugins.register(plugin)
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
    mock.onCall('send_group_msg', () => new Promise(() => {}))
    await expect(app.send('onebot11:10000:group:200', 'waiting for ack')).rejects.toMatchObject({
      code: 'DELIVERY_TIMEOUT',
      outcome: 'unknown',
      target: { platform: 'onebot11', selfId: '10000', type: 'group', id: '200' },
    })
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
      await bot.sendGroup('200', [seg.image(file), seg.audio(Buffer.from('record'))])
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
    // Implementations report images by platform file name plus URL, and forwards by an opaque resource id
    // (NapCat uses a string resid). Both must survive a re-send unchanged.
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
      dataDir: await dataDirectory(),
      pluginLoader: { dirs: [], hotReload: false },
      connections: [
        {
          id: 'primary',
          name: 'OneBot',
          adapter: 'onebot11',
          config: {
            apiTimeout: 500,
            reconnect: { minDelay: 10, maxDelay: 30 },
            type: 'forward',
            url: mock.url,
            accessToken: 'test-token',
          },
        },
      ],
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
    app.events.on('notice.member', async (event) => {
      await Promise.resolve()
      received.push('member')
      received.push(event.groupId)
    })
    app.events.on('notice.member.join', (event) => received.push(event.userId))
    await app.events.emit({
      id: crypto.randomUUID(),
      platform: bot.platform,
      selfId: bot.selfId,
      time: Date.now(),
      kind: 'notice',
      name: 'notice.member.join',
      joinType: 'approve',
      groupId: '2',
      userId: bot.selfId,
      raw: {},
      bot,
    })
    expect(received).toEqual(expect.arrayContaining(['notice', 'member', '2', bot.selfId]))
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'notice.member.join' }),
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
    const notices: NoticeEvent[] = []
    const platformNotices: EventMap['notice.onebot11'][] = []
    const platformTypes: string[] = []
    const recalled: string[] = []
    const muted: number[] = []
    app.events.on('notice', (event) => notices.push(event))
    app.events.on('notice.onebot11', (event) => {
      platformNotices.push(event)
      platformTypes.push(event.platformType)
    })
    app.events.on('notice.message', (event) => recalled.push(event.messageId))
    app.events.on('notice.member.mute', (event) => muted.push(event.duration))
    const warn = vi.spyOn(app.logger, 'warn').mockImplementation(() => {})
    const member = { group_id: 200, user_id: 300, operator_id: 400 }
    const cases = [
      {
        raw: { ...member, notice_type: 'group_increase', sub_type: 'approve' },
        expected: {
          name: 'notice.member.join',
          groupId: '200',
          userId: '300',
          operatorId: '400',
          joinType: 'approve',
        },
      },
      {
        raw: { ...member, notice_type: 'group_increase', sub_type: 'invite' },
        expected: { name: 'notice.member.join', joinType: 'invite' },
      },
      {
        raw: { ...member, notice_type: 'group_decrease', sub_type: 'leave' },
        expected: {
          name: 'notice.member.leave',
          groupId: '200',
          userId: '300',
          operatorId: '400',
          reason: 'leave',
        },
      },
      {
        raw: { ...member, notice_type: 'group_decrease', sub_type: 'kick' },
        expected: { name: 'notice.member.leave', userId: '300', reason: 'kick' },
      },
      {
        raw: { ...member, notice_type: 'group_decrease', sub_type: 'kick_me' },
        expected: { name: 'notice.member.leave', userId: '10001', reason: 'kick' },
      },
      {
        raw: { ...member, notice_type: 'group_ban', sub_type: 'ban', duration: 60 },
        expected: {
          name: 'notice.member.mute',
          groupId: '200',
          userId: '300',
          operatorId: '400',
          duration: 60_000,
        },
      },
      {
        raw: { ...member, notice_type: 'group_ban', sub_type: 'lift_ban', duration: 0 },
        expected: { name: 'notice.member.unmute', groupId: '200', userId: '300', operatorId: '400' },
      },
      {
        raw: { ...member, notice_type: 'group_admin', sub_type: 'set' },
        expected: { name: 'notice.member.role', groupId: '200', userId: '300', role: 'admin' },
      },
      {
        raw: { ...member, notice_type: 'group_admin', sub_type: 'unset' },
        expected: { name: 'notice.member.role', role: 'member' },
      },
      {
        raw: { ...member, notice_type: 'group_recall', message_id: 500 },
        expected: {
          name: 'notice.message.recall',
          groupId: '200',
          userId: '300',
          operatorId: '400',
          messageId: '500',
        },
      },
      {
        raw: { notice_type: 'friend_recall', user_id: 300, message_id: 501 },
        expected: { name: 'notice.message.recall', userId: '300', messageId: '501' },
      },
      {
        raw: { notice_type: 'notify', sub_type: 'poke', group_id: 200, user_id: 300, target_id: 10001 },
        expected: { name: 'notice.poke', userId: '300', targetId: '10001', groupId: '200' },
      },
      {
        raw: { notice_type: 'notify', sub_type: 'poke', user_id: 300, target_id: 10001 },
        expected: { name: 'notice.poke', userId: '300', targetId: '10001' },
      },
      {
        raw: { ...member, notice_type: 'group_upload' },
        expected: {
          name: 'notice.onebot11.group_upload',
          platformType: 'group_upload',
          groupId: '200',
          userId: '300',
          operatorId: '400',
        },
      },
      {
        raw: { notice_type: 'notify', sub_type: 'lucky_king', group_id: 200, user_id: 300 },
        expected: {
          name: 'notice.onebot11.notify.lucky_king',
          platformType: 'notify',
          subType: 'lucky_king',
          groupId: '200',
          userId: '300',
        },
      },
      {
        raw: { notice_type: 'constructor', user_id: 300 },
        expected: { name: 'notice.onebot11.constructor', platformType: 'constructor', userId: '300' },
      },
    ]
    for (const { raw } of cases) mock.emitNotice(raw)
    await vi.waitFor(() => expect(notices).toHaveLength(cases.length))
    expect(notices).toMatchObject(cases.map(({ expected }) => expected))
    expect(notices[6]).not.toHaveProperty('duration')
    expect(notices[10]).not.toHaveProperty('groupId')
    expect(notices[12]).not.toHaveProperty('groupId')
    expect(platformNotices).toHaveLength(3)
    expect(platformTypes).toEqual(['group_upload', 'notify', 'constructor'])
    expect(recalled).toEqual(['500', '501'])
    expect(muted).toEqual([60_000])

    mock.emitNotice({ notice_type: 'group_increase', sub_type: 'approve', group_id: 200, operator_id: 400 })
    mock.emitNotice({ ...member, notice_type: 'group_admin', sub_type: 'invalid' })
    mock.emitNotice({ notice_type: 'notify', sub_type: 'poke', user_id: 300 })
    mock.emitNotice({ ...member, notice_type: 'group_ban', sub_type: 'ban', duration: 'invalid' })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(4))
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'Ignoring malformed OneBot notice')
    expect(notices).toHaveLength(cases.length)
    warn.mockRestore()

    const requests: RequestEvent[] = []
    const groupRequests: Array<'request.group.join' | 'request.group.invite'> = []
    app.events.on('request', (event) => requests.push(event))
    app.events.on('request.group', (event) => groupRequests.push(event.name))
    mock.push({ post_type: 'request', request_type: 'friend', user_id: 300, comment: 'friend', flag: 'f' })
    mock.push({
      post_type: 'request',
      request_type: 'group',
      sub_type: 'add',
      group_id: 200,
      user_id: 300,
      comment: 'join',
      flag: 'j',
    })
    mock.push({
      post_type: 'request',
      request_type: 'group',
      sub_type: 'invite',
      group_id: 200,
      user_id: 300,
      comment: 'invite',
      flag: 'i',
    })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    expect(requests).toMatchObject([
      { name: 'request.friend', userId: '300', comment: 'friend' },
      { name: 'request.group.join', groupId: '200', userId: '300', comment: 'join' },
      { name: 'request.group.invite', groupId: '200', userId: '300', comment: 'invite' },
    ])
    expect(groupRequests).toEqual(['request.group.join', 'request.group.invite'])
    const [friend, join, invite] = requests
    if (friend === undefined || join === undefined || invite === undefined)
      throw new Error('Missing requests')
    await friend.approve('remark')
    await join.reject('reason')
    await invite.approve()
    expect((await mock.waitForCall('set_friend_add_request')).params).toMatchObject({
      flag: 'f',
      approve: true,
      remark: 'remark',
    })
    expect(
      (await mock.waitForCall('set_group_add_request', (call) => call.params.flag === 'j')).params,
    ).toMatchObject({ flag: 'j', sub_type: 'add', approve: false, reason: 'reason' })
    expect(
      (await mock.waitForCall('set_group_add_request', (call) => call.params.flag === 'i')).params,
    ).toMatchObject({ flag: 'i', sub_type: 'invite', approve: true })
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
    expect(app.botAccounts.get(oldBot)).not.toHaveProperty('connectionId', 'primary')
    expect(app.connections.list()[0]?.bots).toEqual([{ platform: 'onebot11', selfId: '10002' }])
    await expect(oldBot.sendGroup('200', 'old account')).rejects.toMatchObject({
      code: 'NO_BOT_ONLINE',
      outcome: 'not_sent',
    })
    await expect(oldBot.sendGroup('200', seg.image('missing-file'))).rejects.toMatchObject({
      code: 'NO_BOT_ONLINE',
    })
  })

  it('reconnects when the server stops responding to ping and does not reconnect after stop', async () => {
    const mock = new MockOneBot({ token: 'test-token', respondToPing: false })
    await mock.ready
    const config = configSchema.parse({
      dataDir: await dataDirectory(),
      pluginLoader: { dirs: [], hotReload: false },
      connections: [
        {
          id: 'primary',
          name: 'OneBot',
          adapter: 'onebot11',
          config: {
            apiTimeout: 100,
            reconnect: { minDelay: 10, maxDelay: 20 },
            type: 'forward',
            url: mock.url,
            accessToken: 'test-token',
          },
        },
      ],
    })
    config.connections = []
    const app = new App(config)
    app.useAdapter(
      new OneBotAdapter(
        onebot11Schema.parse({
          apiTimeout: 100,
          reconnect: { minDelay: 10, maxDelay: 20 },
          connections: [{ type: 'forward', url: mock.url, accessToken: 'test-token' }],
        }),
        app,
        {
          pingInterval: 15,
          pongTimeout: 15,
          heartbeatCheckInterval: 5,
          heartbeatTimeoutMultiplier: 2,
          stableTime: 30,
        },
      ),
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
      dataDir: await dataDirectory(),
      pluginLoader: { dirs: [], hotReload: false },
      connections: [
        {
          id: 'primary',
          name: 'OneBot',
          adapter: 'onebot11',
          config: {
            apiTimeout: 100,
            reconnect: { minDelay: 10, maxDelay: 20 },
            type: 'forward',
            url: mock.url,
            accessToken: 'test-token',
          },
        },
      ],
    })
    config.connections = []
    const app = new App(config)
    app.useAdapter(
      new OneBotAdapter(
        onebot11Schema.parse({
          apiTimeout: 100,
          reconnect: { minDelay: 10, maxDelay: 20 },
          connections: [{ type: 'forward', url: mock.url, accessToken: 'test-token' }],
        }),
        app,
        { heartbeatCheckInterval: 5 },
      ),
    )
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
      dataDir: await dataDirectory(),
      pluginLoader: { dirs: [], hotReload: false },
      connections: [
        {
          id: 'primary',
          name: 'OneBot',
          adapter: 'onebot11',
          config: {
            reconnect: { minDelay: 5, maxDelay: 10 },
            type: 'forward',
            url: `${mock.url}?access_token=url-secret&other=ok`,
            accessToken: 'wrong-token',
          },
        },
      ],
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

describe('OneBot neutral management and forwarding', () => {
  it('converts mute durations and fetched messages at the protocol boundary', async () => {
    const { app, mock } = await setup({ token: 'test-token' })
    const bot = app.bots.list()[0]
    if (!bot) throw new Error('OneBot did not come online')
    mock.onCall('get_msg', () => ({
      message_id: 789,
      time: 1234,
      group_id: 200,
      sender: { user_id: 300, nickname: 'Alice', card: 'A', role: 'admin' },
      message: [
        { type: 'at', data: { qq: 400 } },
        { type: 'record', data: { file: 'voice-id' } },
        { type: 'forward', data: { id: 'opaque-resid' } },
      ],
    }))
    for (const duration of [0, 1, 1_000, 1_001]) await bot.muteMember('200', '300', duration)
    expect(mock.calls.filter((call) => call.action === 'set_group_ban').map((call) => call.params)).toEqual([
      { group_id: 200, user_id: 300, duration: 0 },
      { group_id: 200, user_id: 300, duration: 1 },
      { group_id: 200, user_id: 300, duration: 1 },
      { group_id: 200, user_id: 300, duration: 2 },
    ])
    expect(await bot.getMessage('789')).toEqual({
      messageId: '789',
      messageType: 'group',
      userId: '300',
      groupId: '200',
      time: 1_234_000,
      sender: { userId: '300', nickname: 'Alice', card: 'A', role: 'admin' },
      message: [seg.at('400'), seg.audio('voice-id'), seg.forward('opaque-resid')],
    })
  })

  it('converts forward nodes in both directions and applies hooks to OneBot sends', async () => {
    const filter = definePlugin({
      defaultOnNewBots: true,
      name: 'send-filter',
      setup(ctx) {
        ctx.beforeSend(({ message }) => {
          if (plainText(message) === 'blocked') return false
          return [...message, seg.text('!')]
        })
      },
    })
    const { app, mock } = await setup({ token: 'test-token' }, [filter])
    const bot = app.bots.list()[0]
    if (!bot || !isOneBot(bot)) throw new Error('OneBot did not come online')
    const sent: string[] = []
    app.events.on('bot.message.sent', (event) => {
      sent.push(JSON.stringify(event.message))
    })
    const result = await bot.sendForward({ type: 'group', id: '200' }, [
      {
        userId: '300',
        nickname: 'Alice',
        message: [seg.text('hello'), seg.at('400'), seg.forward('resid-abc')],
      },
    ])
    expect((await mock.waitForCall('send_group_forward_msg')).params).toEqual({
      group_id: 200,
      messages: [
        {
          type: 'node',
          data: {
            user_id: 300,
            nickname: 'Alice',
            content: [
              { type: 'text', data: { text: 'hello' } },
              { type: 'at', data: { qq: 400 } },
              { type: 'forward', data: { id: 'resid-abc' } },
              { type: 'text', data: { text: '!' } },
            ],
          },
        },
      ],
    })
    await vi.waitFor(() => expect(sent).toContain(JSON.stringify([seg.forward(result.messageId)])))
    mock.onCall('get_forward_msg', () => ({
      messages: [
        {
          sender: { user_id: 300, nickname: 'Alice' },
          time: 1234,
          content: [
            { type: 'record', data: { file: 'voice-id' } },
            { type: 'at', data: { qq: 400 } },
          ],
        },
      ],
    }))
    expect(await bot.getForward('resid-abc')).toEqual([
      {
        userId: '300',
        nickname: 'Alice',
        time: 1_234_000,
        message: [seg.audio('voice-id'), seg.at('400')],
      },
    ])
    expect((await mock.waitForCall('get_forward_msg')).params).toEqual({ id: 'resid-abc' })
    await bot.onebot.sendPrivateMsg('300', 'direct')
    expect((await mock.waitForCall('send_private_msg')).params.message).toEqual([seg.text('direct!')])
    await bot.onebot.sendPrivateForwardMsg('300', [
      { type: 'node', data: { userId: '400', nickname: 'Bob', content: 'direct' } },
    ])
    expect((await mock.waitForCall('send_private_forward_msg')).params.messages).toEqual([
      {
        type: 'node',
        data: { user_id: 400, nickname: 'Bob', content: [seg.text('direct!')] },
      },
    ])
    const lookups = mock.calls.filter((call) => call.action === 'get_msg').length
    await bot.onebot.sendPrivateForwardMsg('300', [{ type: 'node', data: { id: '456' } }])
    expect(
      mock.calls.filter((call) => call.action === 'send_private_forward_msg').at(-1)?.params.messages,
    ).toEqual([{ type: 'node', data: { id: 456 } }])
    // Reference nodes point at existing platform messages: no lookup, no hooks.
    expect(mock.calls.filter((call) => call.action === 'get_msg')).toHaveLength(lookups)
    const count = mock.calls.filter((call) => call.action === 'send_group_forward_msg').length
    await expect(
      bot.sendForward({ type: 'group', id: '200' }, [
        { userId: '300', nickname: 'Alice', message: 'blocked' },
      ]),
    ).rejects.toMatchObject({ code: 'DELIVERY_BLOCKED', outcome: 'not_sent' })
    expect(mock.calls.filter((call) => call.action === 'send_group_forward_msg')).toHaveLength(count)
  })

  it('intercepts OneBot sends before hooks and honors replacement results on every send path', async () => {
    const order: string[] = []
    const filter = definePlugin({
      defaultOnNewBots: true,
      name: 'replacement',
      setup(ctx) {
        ctx.interceptApi(async (call, next) => {
          order.push(`api:${call.method}`)
          if (call.method === 'call' && call.args[0] === 'send_group_msg') {
            await call.bot.call('get_group_list')
          }
          return next()
        })
        ctx.beforeSend(() => {
          order.push('hook')
          return { deliver: async () => ({ messageId: 'replacement-id' }) }
        })
      },
    })
    const { app, mock } = await setup({ token: 'test-token' }, [filter])
    const bot = app.bots.list()[0]
    if (!bot || !isOneBot(bot)) throw new Error('OneBot did not come online')
    const sessionPromise = new Promise<Session>((resolve) => {
      app.events.on('message.group', resolve)
    })
    mock.emitGroupMessage({ groupId: '200', userId: '300', message: 'incoming' })
    const session = await sessionPromise
    const results = [
      await bot.sendGroup('200', 'original'),
      await bot.sendPrivate('300', 'original'),
      await bot.sendForward({ type: 'group', id: '200' }, [
        { userId: '300', nickname: 'A', message: 'node' },
      ]),
      await bot.onebot.sendGroupMsg('200', 'original'),
      await bot.onebot.sendPrivateMsg('300', 'original'),
      await bot.onebot.sendGroupForwardMsg('200', [
        { type: 'node', data: { userId: '300', nickname: 'A', content: 'node' } },
      ]),
      await bot.onebot.sendPrivateForwardMsg('300', [
        { type: 'node', data: { userId: '300', nickname: 'A', content: 'node' } },
      ]),
      await session.send('original'),
      await session.reply('original'),
    ]
    expect(results).toEqual(Array.from({ length: 9 }, () => ({ messageId: 'replacement-id' })))
    expect(order).toEqual([
      'api:sendGroup',
      'hook',
      'api:sendPrivate',
      'hook',
      'api:sendForward',
      'hook',
      'api:call',
      'hook',
      'api:call',
      'hook',
      'api:call',
      'hook',
      'api:call',
      'hook',
      'api:sendGroup',
      'hook',
      'api:sendGroup',
      'hook',
    ])
    expect(mock.calls.filter((call) => call.action.startsWith('send_'))).toEqual([])
    expect(mock.calls.filter((call) => call.action === 'get_group_list')).toHaveLength(1)
  })
})
