import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  isWecomBot,
  isWecomCardAction,
  isWecomEnterChat,
  isWecomFeedback,
  isWecomSession,
  WecomAdapter,
  type WecomCardActionEvent,
  type WecomConfig,
  type WecomEnterChatEvent,
  type WecomFeedbackEvent,
  type WecomHandlers,
  type WecomSession,
  type WecomTransport,
  wecom,
  wecomDefinition,
  wecomSchema,
} from '@asabot/core/wecom'
import { WsCmd } from '@wecom/aibot-node-sdk'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type WebSocket, WebSocketServer } from 'ws'
import { stringify } from 'yaml'
import { SDKTransport } from '../src/adapters/wecom/transport.ts'
import { configSchema } from '../src/core/config/schema.ts'
import type { ConnectionConfig } from '../src/core/connections.ts'
import { createApp, definePlugin, isSegment, loadConfig, seg } from '../src/index.ts'
import type { HistoryService } from '../src/plugins/history.ts'

const adapterId = 'wecom-fixture'
const botName = '研发 助手'
const userId = 'opaque_user_Aa_01'
const groupId = 'wecom-chat'
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function connection(id: string, botId = id): ConnectionConfig {
  return { id, name: id, adapter: adapterId, enabled: true, config: { botId, botName, secret: randomUUID() } }
}

class MockTransport implements WecomTransport {
  callbacks?: WecomHandlers
  closed = false
  readonly send = vi.fn<WecomTransport['send']>(async () => undefined)
  readonly reply = vi.fn<WecomTransport['reply']>(async () => undefined)
  readonly upload = vi.fn<WecomTransport['upload']>(async () => 'media-fixture')

  start(callbacks: WecomHandlers): void {
    this.callbacks = callbacks
  }
  close(): void {
    this.closed = true
  }
  get events(): WecomHandlers {
    if (!this.callbacks) throw new Error('Transport not started')
    return this.callbacks
  }
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'asabot-wecom-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}

async function fixture(
  options: {
    connections?: ConnectionConfig[]
    transport?: (config: WecomConfig) => WecomTransport
    plugin?: ReturnType<typeof definePlugin>
    split?: boolean
  } = {},
) {
  const first = connection('primary', 'bot-primary')
  const transports: MockTransport[] = []
  const logs: string[] = []
  const app = createApp(
    configSchema.parse({
      dataDir: await directory(),
      pluginLoader: { dirs: [], hotReload: false },
      connections: options.connections ?? [first],
      ...(options.split && {
        plugins: { 'long-message': { config: { threshold: 5, chunkSize: 4, splitInterval: 0 } } },
      }),
    }),
    {
      logger: pino({ level: 'debug' }, { write: (line) => logs.push(line) }),
      adapters: [
        {
          source: 'test',
          definition: {
            ...wecomDefinition,
            id: adapterId,
            create(config, host) {
              return new WecomAdapter(wecomSchema.parse(config), host, {
                createTransport:
                  options.transport ??
                  (() => {
                    const transport = new MockTransport()
                    transports.push(transport)
                    return transport
                  }),
              })
            },
          },
        },
      ],
    },
  )
  const sessions: WecomSession[] = []
  app.events.on('message', (session) => {
    if (isWecomSession(session)) sessions.push(session)
  })
  if (options.plugin) app.plugins.register(options.plugin)
  cleanup.push(() => app.stop())
  await app.start()
  const pickTransport = (index = 0) => required(transports[index])
  const bot = (id = 'bot-primary') => {
    const item = required(app.getBot('wecom', id))
    if (!isWecomBot(item)) throw new Error('Unexpected bot type')
    return item
  }
  return { app, sessions, bot, first, pickTransport, logs }
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error('Missing test value')
  return value
}

function message(botId: string, reqId: string, content: Record<string, unknown>, group = false) {
  return {
    cmd: WsCmd.CALLBACK,
    headers: { req_id: reqId },
    body: {
      aibotid: botId,
      msgid: `msg-${reqId}`,
      from: { userid: userId },
      chattype: group ? 'group' : 'single',
      ...(group && { chatid: groupId }),
      ...content,
    },
  }
}

function text(body: string) {
  return { msgtype: 'text', text: { content: body } }
}

function event(reqId: string, data: Record<string, unknown>, group = false) {
  const frame = message('bot-primary', reqId, { msgtype: 'event', event: data }, group)
  return { ...frame, cmd: WsCmd.EVENT_CALLBACK }
}

describe('WeCom built-in adapter', () => {
  it('masks secrets and rejects a duplicate BotID before saving connections', async () => {
    const configPath = join(await directory(), 'config.yaml')
    const password = randomUUID()
    const literal = randomUUID()
    const envSecret = randomUUID()
    const variable = 'ASABOT_TEST_WECOM_SECRET'
    const reference = `\${${variable}}`
    vi.stubEnv(variable, envSecret)
    const primary = {
      ...connection('first'),
      adapter: 'wecom',
      enabled: false,
      config: { botId: 'bot-a', secret: literal },
    }
    const secondary = {
      ...primary,
      id: 'second',
      config: { botId: 'bot-b', secret: reference },
    }
    await writeFile(
      configPath,
      stringify({
        dataDir: await directory(),
        pluginLoader: { dirs: [], hotReload: false },
        connections: [primary, secondary],
        server: { port: 0, panelPassword: password },
      }),
    )
    const config = await loadConfig(configPath)
    expect(() => createApp({ ...config, connections: [primary, { ...primary, id: 'duplicate' }] })).toThrow(
      /已绑定/,
    )
    const app = createApp(config, { configPath, logger: pino({ level: 'silent' }) })
    cleanup.push(() => app.stop())
    await app.start()
    const url = `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
    const login = await fetch(`${url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    expect(login.ok).toBe(true)
    const cookie = required(login.headers.get('set-cookie')?.split(';')[0])
    const catalog = await (await fetch(`${url}/adapters`, { headers: { cookie } })).json()
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'wecom',
          source: 'builtin',
          connectionTypes: ['long-connection'],
          configSchema: expect.objectContaining({
            properties: expect.objectContaining({ secret: expect.objectContaining({ writeOnly: true }) }),
          }),
        }),
      ]),
    )
    const response = await (await fetch(`${url}/connections`, { headers: { cookie } })).text()
    expect(JSON.parse(response)).toMatchObject([
      { id: 'first', config: { secret: '********' } },
      { id: 'second', config: { secret: reference } },
    ])
    expect(response).not.toContain(literal)
    expect(response).not.toContain(envSecret)
    const previous = await readFile(configPath, 'utf8')
    const update = await fetch(`${url}/connections/second`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: secondary.name,
        adapter: 'wecom',
        enabled: false,
        config: { botId: 'bot-a', secret: '********' },
      }),
    })
    expect(update.status).toBe(400)
    expect(await update.text()).toContain('已绑定')
    expect(await readFile(configPath, 'utf8')).toBe(previous)
  })

  it('maps private and addressed group commands, deduplicating within each bot', async () => {
    const primary = connection('primary', 'bot-primary')
    const secondary = {
      ...connection('secondary', 'bot-secondary'),
      config: { botId: 'bot-secondary', secret: randomUUID() },
    }
    const { app, sessions, pickTransport } = await fixture({ connections: [primary, secondary] })
    const primaryTransport = pickTransport()
    const secondaryTransport = pickTransport(1)
    const inbound = message('bot-primary', 'whoami', text('/whoami'))
    primaryTransport.events.message(inbound)
    await app.whenIdle()
    expect(sessions).toHaveLength(0)
    primaryTransport.events.ready()
    secondaryTransport.events.ready()
    app.policies.setAdmins({ platform: 'wecom', selfId: 'bot-primary' }, [userId])
    primaryTransport.events.message(inbound)
    primaryTransport.events.message({ ...inbound, headers: { req_id: 'redelivered' } })
    secondaryTransport.events.message({ ...inbound, body: { ...inbound.body, aibotid: 'bot-secondary' } })
    primaryTransport.events.message(message('bot-primary', 'help', text(`@${botName}\u2005/help`), true))
    primaryTransport.events.message(message('bot-primary', 'prefix', text(`@${botName}组 /help`), true))
    secondaryTransport.events.message(message('bot-secondary', 'no-name', text(`@${botName} /help`), true))
    primaryTransport.events.message(message('bot-secondary', 'other-bot', text('different account')))
    primaryTransport.events.message(
      message('bot-primary', 'channel', { ...text('接收频道'), compat_info: { source: 'channel' } }),
    )
    await app.whenIdle()
    expect(sessions).toHaveLength(5)
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: 'msg-whoami', userId, selfId: 'bot-primary', isBotAdmin: true }),
        expect.objectContaining({
          messageId: 'msg-whoami',
          userId,
          selfId: 'bot-secondary',
          isBotAdmin: false,
        }),
        expect.objectContaining({ messageId: 'msg-help', groupId, text: '/help', toMe: true }),
        expect.objectContaining({ messageId: 'msg-prefix', text: `@${botName}组 /help` }),
        expect.objectContaining({ messageId: 'msg-no-name', text: `@${botName} /help` }),
      ]),
    )
    expect(primaryTransport.send.mock.calls).toEqual(
      expect.arrayContaining([
        [
          { type: 'private', id: userId },
          expect.objectContaining({
            markdown: { content: expect.stringContaining('机器人管理员：是  \n框架管理员：否') },
          }),
        ],
        [{ type: 'group', id: groupId }, expect.objectContaining({ msgtype: 'markdown' })],
      ]),
    )
    await app.send(required(sessions.find((item) => item.selfId === 'bot-secondary')).target, 'reminder')
    expect(secondaryTransport.send).toHaveBeenLastCalledWith(
      { type: 'private', id: userId },
      { msgtype: 'markdown', markdown: { content: 'reminder' } },
    )
  })

  it('keeps split replies on the original callback, without falling back when reply fails or expires', async () => {
    const apiCalls: string[] = []
    const plugin = definePlugin({
      name: 'wecom-hooks',
      defaultOnNewBots: true,
      setup(ctx) {
        ctx.interceptApi(async ({ method }, next) => {
          apiCalls.push(method)
          return next()
        })
        ctx.beforeSend(({ message: [first] }) =>
          first && isSegment(first, 'text') && first.data.text === 'replace'
            ? [seg.text('abcdefghijkl')]
            : undefined,
        )
      },
    })
    const { app, sessions, pickTransport } = await fixture({ plugin, split: true })
    const transport = pickTransport()
    transport.events.ready()
    transport.events.message(message('bot-primary', 'callback', text('hello'), true))
    await app.whenIdle()
    const session = required(sessions[0])
    const sent = await session.reply('replace')
    expect(sent.messageId).toMatch(/^wecom-local:/)
    expect(transport.reply.mock.calls.map(([reqId, body]) => [reqId, body])).toEqual(
      ['abcd', 'efgh', 'ijkl'].map((content) => ['callback', { msgtype: 'markdown', markdown: { content } }]),
    )
    expect(transport.send).not.toHaveBeenCalled()
    transport.reply.mockRejectedValueOnce(new Error('platform rejected'))
    await expect(session.reply('test')).rejects.toMatchObject({
      code: 'DELIVERY_UNCONFIRMED',
      outcome: 'unknown',
      target: { platform: 'wecom', type: 'group', id: groupId },
    })
    expect(transport.send).not.toHaveBeenCalled()
    await session.reply('push', { quote: false })
    await session.send('send')
    expect(transport.send.mock.calls).toEqual(
      ['push', 'send'].map((content) => [
        { type: 'group', id: groupId },
        { msgtype: 'markdown', markdown: { content } },
      ]),
    )
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60_000)
    await expect(session.reply('late')).rejects.toMatchObject({
      code: 'CONVERSATION_UNAVAILABLE',
      outcome: 'not_sent',
    })
    expect(transport.reply).toHaveBeenCalledTimes(4)
    expect(apiCalls).toEqual(expect.arrayContaining(['wecom.reply', 'sendGroup']))
  })

  it('rebuilds a connection on credentials or BotID changes and ignores stale callbacks', async () => {
    const { app, sessions, first, pickTransport } = await fixture()
    const original = pickTransport()
    original.events.ready()
    original.events.message(message('bot-primary', 'before', text('hello')))
    await app.whenIdle()
    const originalSession = required(sessions[0])
    const rotated = { ...first, config: { botId: 'bot-primary', secret: randomUUID() } }
    await app.connections.apply([rotated])
    expect(original.closed).toBe(true)
    original.events.ready()
    original.events.message(message('bot-primary', 'late', text('hello')))
    expect(app.connections.list()).toMatchObject([{ state: 'connecting' }])
    const next = pickTransport(1)
    next.events.failed('认证失败')
    expect(app.connections.list()).toMatchObject([{ state: 'error', lastError: '认证失败' }])
    await app.connections.apply([{ ...rotated, config: { botId: 'replacement', secret: randomUUID() } }])
    const replacement = pickTransport(2)
    replacement.events.ready()
    expect(app.getBot('wecom', 'bot-primary')).toBeUndefined()
    expect(app.connections.list()).toMatchObject([
      { state: 'online', bots: [{ selfId: 'replacement' }], lastError: undefined },
    ])
    await expect(originalSession.reply('old')).rejects.toMatchObject({
      code: 'NO_BOT_ONLINE',
      outcome: 'not_sent',
    })
    await app.connections.apply([
      { ...rotated, enabled: false, config: { botId: 'replacement', secret: randomUUID() } },
    ])
    replacement.events.message(message('replacement', 'stopped', text('hello')))
    await app.whenIdle()
    expect(sessions).toHaveLength(1)
    expect(app.connections.list()).toMatchObject([{ state: 'disabled' }])
  })

  it('handles streams, one-shot events, and feedback while recording only successful final frames', async () => {
    const methods: string[] = []
    const plugin = definePlugin({
      name: 'wecom-native',
      defaultOnNewBots: true,
      setup(ctx) {
        ctx.interceptApi(async ({ method }, next) => {
          methods.push(method)
          return next()
        })
      },
    })
    const { app, sessions, pickTransport } = await fixture({ plugin })
    const welcomes: WecomEnterChatEvent[] = []
    const cards: WecomCardActionEvent[] = []
    const feedback: WecomFeedbackEvent[] = []
    app.events.on('notice', (notice) => {
      if (isWecomEnterChat(notice)) welcomes.push(notice)
      if (isWecomCardAction(notice)) cards.push(notice)
      if (isWecomFeedback(notice)) feedback.push(notice)
    })
    const transport = pickTransport()
    transport.events.ready()
    transport.events.message(message('bot-primary', 'stream', text('hello')))
    transport.events.event(event('welcome', { eventtype: 'enter_chat' }))
    transport.events.event(event('expired', { eventtype: 'enter_chat' }))
    transport.events.event(
      event(
        'card',
        {
          eventtype: 'template_card_event',
          template_card_event: {
            card_type: 'vote_interaction',
            event_key: 'submit',
            task_id: 'original-task',
            selected_items: { selected_item: [{ question_key: 'vote', option_ids: { option_id: ['yes'] } }] },
          },
        },
        true,
      ),
    )
    transport.events.event(
      event('feedback', {
        eventtype: 'feedback_event',
        feedback_event: {
          id: 'feedback-id',
          type: 2,
          content: '请补充',
          inaccurate_reason_list: [2, 4],
        },
      }),
    )
    await app.whenIdle()
    const session = required(sessions[0])
    const history = app.plugins.inject('history') as HistoryService
    const stream = session.wecom.createStream({ feedbackId: 'feedback-id' })
    await stream.update('working')
    await app.whenIdle()
    expect(history.query().filter((entry) => entry.direction === 'out')).toEqual([])
    await stream.finish('finished')
    await expect(stream.update('again')).rejects.toThrow('已结束')
    await app.whenIdle()
    expect(
      history
        .query()
        .filter((entry) => entry.direction === 'out')
        .map((entry) => entry.message),
    ).toEqual([[seg.markdown('finished')]])
    expect(transport.reply.mock.calls.slice(0, 2)).toMatchObject([
      [
        'stream',
        {
          msgtype: 'stream',
          stream: { id: stream.id, content: 'working', finish: false, feedback: { id: 'feedback-id' } },
        },
        undefined,
      ],
      [
        'stream',
        { msgtype: 'stream', stream: { id: stream.id, content: 'finished', finish: true } },
        undefined,
      ],
    ])
    expect(transport.reply.mock.calls[1]?.[1]).not.toHaveProperty('stream.feedback')
    await required(welcomes[0]).replyWelcome('欢迎')
    await expect(required(welcomes[0]).replyWelcome('再次欢迎')).rejects.toThrow('已回复')
    const card = required(cards[0])
    expect(card).toMatchObject({
      groupId,
      eventKey: 'submit',
      selectedItems: [{ questionKey: 'vote', optionIds: ['yes'] }],
    })
    await card.updateCard({ card_type: 'vote_interaction', task_id: 'not-the-original' }, [userId])
    expect(transport.reply.mock.calls.slice(2)).toEqual([
      ['welcome', { msgtype: 'text', text: { content: '欢迎' } }, WsCmd.RESPONSE_WELCOME],
      [
        'card',
        {
          response_type: 'update_template_card',
          template_card: { card_type: 'vote_interaction', task_id: 'original-task' },
          userids: [userId],
        },
        WsCmd.RESPONSE_UPDATE,
      ],
    ])
    expect(feedback).toMatchObject([
      { feedbackId: 'feedback-id', feedbackType: 2, content: '请补充', inaccurateReasons: [2, 4] },
    ])
    expect(methods).toEqual(
      expect.arrayContaining([
        'wecom.replyWelcome',
        'wecom.updateCard',
        'wecom.stream.update',
        'wecom.stream.finish',
      ]),
    )
    const slow = session.wecom.createStream()
    await slow.update('first')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000)
    await expect(slow.finish('too late')).rejects.toThrow('超过 10 分钟')
    await expect(required(welcomes[1]).replyWelcome('late')).rejects.toThrow('回调回复已超时')
  })

  it('downloads encrypted attachments without exposing secrets or allowing access outside the bot and lifetime', async () => {
    const { app, sessions, bot, pickTransport, logs } = await fixture({
      connections: [connection('primary', 'bot-primary'), connection('secondary', 'another-bot')],
    })
    const transport = pickTransport()
    transport.events.ready()
    const payload = Buffer.from('private attachment')
    const key = randomBytes(32)
    const aeskey = key.toString('base64').replace(/=$/, '')
    const padding = 32 - (payload.length % 32)
    const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)).setAutoPadding(false)
    const encrypted = Buffer.concat([
      cipher.update(Buffer.concat([payload, Buffer.alloc(padding, padding)])),
      cipher.final(),
    ])
    const signature = randomUUID()
    const url = `https://media.example.com/content?sig=${signature}`
    const download = vi.fn(async (address: URL, options: RequestInit) => {
      expect(options.redirect).toBe('error')
      if (address.pathname === '/oversize')
        return new Response(Uint8Array.from(encrypted), {
          headers: { 'content-length': String(30 * 1024 * 1024) },
        })
      if (address.pathname === '/redirect')
        return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } })
      return new Response(Uint8Array.from(encrypted))
    })
    vi.stubGlobal('fetch', download)
    transport.events.message(
      message(
        'bot-primary',
        'mixed',
        {
          msgtype: 'mixed',
          mixed: { msg_item: [text(`@${botName} caption`), { msgtype: 'image', image: { url, aeskey } }] },
          quote: { msgtype: 'file', file: { url, aeskey, filename: 'quoted.txt' } },
          response_url: url,
        },
        true,
      ),
    )
    for (const kind of ['file', 'video'] as const)
      transport.events.message(message('bot-primary', kind, { msgtype: kind, [kind]: { url, aeskey } }))
    transport.events.message(
      message('bot-primary', 'voice', { msgtype: 'voice', voice: { content: '语音转写' } }),
    )
    for (const [id, address] of [
      ['local', 'https://127.0.0.1/'],
      ['oversize', 'https://media.example.com/oversize'],
      ['redirect', 'https://media.example.com/redirect'],
    ] as const)
      transport.events.message(
        message('bot-primary', id, { msgtype: 'file', file: { url: address, aeskey } }),
      )
    await app.whenIdle()
    const mixed = required(sessions.find((session) => session.messageId === 'msg-mixed'))
    expect(mixed).toMatchObject({
      text: 'caption',
      raw: undefined,
      message: [
        {
          type: 'reply',
          data: {
            message: [
              { type: 'file', data: { name: 'quoted.txt', file: expect.stringMatching(/^wecom-media:/) } },
            ],
          },
        },
        { type: 'at', data: { id: 'bot-primary' } },
        seg.text('caption'),
        { type: 'image' },
      ],
    })
    expect(sessions.find((session) => session.messageId === 'msg-voice')?.text).toBe('语音转写')
    expect(sessions.find((session) => session.messageId === 'msg-video')?.message[0]?.type).toBe('video')
    const handle = required(mixed.message.find((part) => isSegment(part, 'image'))).data.file
    await expect(bot().wecom.downloadMedia(handle)).resolves.toEqual(payload)
    await expect(bot('another-bot').wecom.downloadMedia(handle)).rejects.toThrow('不属于此机器人')
    const handleFor = (id: string) =>
      required(
        required(sessions.find((item) => item.messageId === `msg-${id}`)).message.find((part) =>
          isSegment(part, 'file'),
        ),
      ).data.file
    await expect(bot().wecom.downloadMedia(handleFor('local'))).rejects.toThrow('下载或解密失败')
    expect(download).toHaveBeenCalledTimes(1)
    await expect(bot().wecom.downloadMedia(handleFor('oversize'))).rejects.toThrow('下载或解密失败')
    await expect(bot().wecom.downloadMedia(handleFor('redirect'))).rejects.toThrow('下载或解密失败')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000)
    await expect(bot().wecom.downloadMedia(handle)).rejects.toThrow('已过期')
    const history = app.plugins.inject('history') as HistoryService
    const displayed = JSON.stringify({ sessions, logs, history: history.query() })
    expect(displayed).not.toContain(signature)
    expect(displayed).not.toContain(aeskey)
    expect(displayed).not.toContain(url)
  })
})

interface WireFrame {
  cmd: string
  headers: { req_id: string }
  body: Record<string, unknown>
}

async function socketFixture(mode: 'hold' | 'reject' | 'accept' = 'hold', subscribeTimeout = 5_000) {
  const sockets: WebSocket[] = []
  const frames: WireFrame[] = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const auth = { mode }
  const rejection = randomUUID()
  const pushFailure = { next: false }
  const send = (socket: WebSocket, payload: object) => socket.send(JSON.stringify(payload))
  const ack = (socket: WebSocket, frame: WireFrame, body?: object, errcode = 0) =>
    send(socket, { headers: frame.headers, errcode, errmsg: errcode ? rejection : 'ok', body })
  cleanup.push(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  server.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (raw) => {
      const frame: WireFrame = JSON.parse(raw.toString())
      frames.push(frame)
      switch (frame.cmd) {
        case WsCmd.SUBSCRIBE:
          if (auth.mode !== 'hold') ack(socket, frame, undefined, auth.mode === 'reject' ? 40001 : 0)
          return
        case WsCmd.UPLOAD_MEDIA_INIT:
          ack(socket, frame, { upload_id: 'upload-id' })
          return
        case WsCmd.UPLOAD_MEDIA_FINISH:
          ack(socket, frame, { media_id: 'media-id' })
          return
        case WsCmd.SEND_MSG:
          if (pushFailure.next) {
            pushFailure.next = false
            ack(socket, frame, undefined, 60001)
            return
          }
      }
      ack(socket, frame)
    })
  })
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing TCP address')
  const testing = await fixture({
    transport: (config) =>
      new SDKTransport(config, {
        wsUrl: `ws://127.0.0.1:${address.port}`,
        reconnectInterval: 20,
        subscribeTimeout,
      }),
  })
  return { ...testing, auth, ack, send, sockets, frames, rejection, pushFailure }
}

describe('official WeCom SDK transport', () => {
  it('authenticates, encodes replies and pushes, uploads chunks, retries drops and stops after takeover', async () => {
    const { app, sessions, first, bot, auth, ack, send, sockets, frames, logs, rejection, pushFailure } =
      await socketFixture()
    const ready = () => expect(app.connections.list()).toMatchObject([{ state: 'online' }])
    await vi.waitFor(() => expect(frames[0]?.cmd).toBe(WsCmd.SUBSCRIBE))
    const subscribe = required(frames[0])
    const socket = required(sockets[0])
    const credential = wecomSchema.parse(first.config)
    expect(subscribe.body).toEqual({ bot_id: credential.botId, secret: credential.secret })
    expect(bot().status).toBe('connecting')
    send(socket, message('bot-primary', 'before-auth', text('hello')))
    ack(socket, subscribe)
    await vi.waitFor(ready)
    send(socket, message('bot-primary', 'wire-reply', text('hello')))
    await vi.waitFor(() => expect(sessions.map((session) => session.messageId)).toEqual(['msg-wire-reply']))
    const session = required(sessions[0])
    const markdown = '**answer**\n\n- first\n- second'
    await session.reply(seg.markdown(markdown))
    await session.reply(seg.text('first\r\n*second*\r\n\r\nthird\nfourth'))
    await session.reply('push\nnext line', { quote: false })
    expect(frames.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cmd: WsCmd.RESPONSE,
          headers: { req_id: 'wire-reply' },
          body: { msgtype: 'markdown', markdown: { content: markdown } },
        }),
        expect.objectContaining({
          cmd: WsCmd.RESPONSE,
          headers: { req_id: 'wire-reply' },
          body: { msgtype: 'markdown', markdown: { content: 'first  \n\\*second\\*\n\nthird  \nfourth' } },
        }),
        expect.objectContaining({
          cmd: WsCmd.SEND_MSG,
          body: {
            chatid: userId,
            chat_type: 1,
            msgtype: 'markdown',
            markdown: { content: 'push  \nnext line' },
          },
        }),
      ]),
    )
    await bot().sendGroup(
      groupId,
      wecom.card({ card_type: 'button_interaction', button_list: [{ text: '选项', key: 'pick' }] }),
    )
    const bytes = Buffer.alloc(512 * 1024 + 25, 42)
    await bot().sendPrivate(userId, seg.file(bytes, { name: 'report.bin' }))
    expect(frames.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cmd: WsCmd.SEND_MSG,
          body: expect.objectContaining({
            chatid: groupId,
            chat_type: 2,
            template_card: expect.objectContaining({ task_id: expect.any(String) }),
          }),
        }),
        expect.objectContaining({
          cmd: WsCmd.UPLOAD_MEDIA_INIT,
          body: {
            type: 'file',
            filename: 'report.bin',
            total_chunks: 2,
            total_size: bytes.length,
            md5: createHash('md5').update(bytes).digest('hex'),
          },
        }),
        expect.objectContaining({ cmd: WsCmd.UPLOAD_MEDIA_FINISH, body: { upload_id: 'upload-id' } }),
        expect.objectContaining({
          cmd: WsCmd.SEND_MSG,
          body: { chatid: userId, chat_type: 1, msgtype: 'file', file: { media_id: 'media-id' } },
        }),
      ]),
    )
    const chunks = frames
      .filter((frame) => frame.cmd === WsCmd.UPLOAD_MEDIA_CHUNK)
      .sort((left, right) => Number(left.body.chunk_index) - Number(right.body.chunk_index))
    expect(
      Buffer.concat(chunks.map((frame) => Buffer.from(String(frame.body.base64_data), 'base64'))),
    ).toEqual(bytes)
    await expect(
      bot().sendPrivate(userId, seg.image(Buffer.from('unsupported image'))),
    ).rejects.toMatchObject({ code: 'DELIVERY_PREPARATION_FAILED', outcome: 'not_sent' })
    pushFailure.next = true
    await expect(session.send('rejected')).rejects.toMatchObject({
      code: 'DELIVERY_REJECTED',
      outcome: 'not_sent',
      platformCode: 60001,
    })
    auth.mode = 'accept'
    socket.terminate()
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    await vi.waitFor(ready)
    const current = required(sockets[1])
    const closed = once(current, 'close')
    send(current, {
      cmd: WsCmd.EVENT_CALLBACK,
      headers: { req_id: 'takeover' },
      body: { msgtype: 'event', event: { eventtype: 'disconnected_event' } },
    })
    await closed
    expect(app.connections.list()).toMatchObject([
      { state: 'error', lastError: expect.stringContaining('另一实例') },
    ])
    await sleep(60)
    expect(sockets).toHaveLength(2)
    expect(logs.join('')).not.toContain(rejection)
    expect(logs.join('')).not.toContain(credential.secret)
  })

  it.each([
    ['reject', '认证失败'],
    ['hold', '订阅超时'],
  ] as const)('stops retries on %s and permits a manual reconnect', async (mode, reason) => {
    const { app, auth, sockets } = await socketFixture(mode, 250)
    await vi.waitFor(() =>
      expect(app.connections.list()).toMatchObject([
        { state: 'error', lastError: expect.stringContaining(reason), nextRetryAt: undefined },
      ]),
    )
    await sleep(60)
    expect(sockets).toHaveLength(1)
    auth.mode = 'accept'
    await app.connections.reconnect('primary')
    await vi.waitFor(() => expect(app.connections.list()).toMatchObject([{ state: 'online' }]))
    expect(sockets).toHaveLength(2)
  })
})
