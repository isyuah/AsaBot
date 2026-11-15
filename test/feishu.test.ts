import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { EventDispatcher } from '@larksuiteoapi/node-sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  FeishuAdapter,
  type FeishuBot,
  type FeishuCardActionEvent,
  type FeishuEventHandlers,
  type FeishuLifecycle,
  type FeishuRequest,
  type FeishuTransport,
  feishu,
  feishuSchema,
  isFeishu,
  isFeishuCardAction,
} from '../src/adapters/feishu/index.ts'
import { incomingMessage, readMedia } from '../src/adapters/feishu/message.ts'
import { definePlugin, seg, z } from '../src/index.ts'
import { createTestApp } from '../src/testing/index.ts'

const account = { appId: 'cli_0123456789abcdef', appSecret: 'test-app-secret' }
class MockTransport implements FeishuTransport {
  handlers: FeishuEventHandlers = {}
  requests: { method: string; path: string; input?: FeishuRequest }[] = []
  closed = false
  lifecycle: FeishuLifecycle
  self: string
  override?: (method: string, path: string, input?: FeishuRequest) => unknown
  constructor(lifecycle: FeishuLifecycle, self: string) {
    this.lifecycle = lifecycle
    this.self = self
  }
  async request(method: string, path: string, input?: FeishuRequest): Promise<unknown> {
    this.requests.push({ method, path, input })
    const overridden = this.override?.(method, path, input)
    if (overridden !== undefined) return overridden
    if (path === '/bot/v3/info/')
      return {
        code: 0,
        bot: { open_id: this.self, app_name: 'Test bot', avatar_url: 'https://example.com/bot.png' },
      }
    if (path === '/im/v1/chats')
      return { code: 0, data: { items: [{ chat_id: 'oc_group', name: 'Test group' }], has_more: false } }
    if (path.endsWith('/members'))
      return { code: 0, data: { items: [{ member_id: 'ou_user', name: 'User' }], has_more: false } }
    if (path.startsWith('/im/v1/chats/'))
      return { code: 0, data: { owner_id: 'ou_user', chat_mode: 'group' } }
    return { code: 0, data: { message_id: `om_${this.requests.length}` } }
  }
  async upload(type: 'image' | 'file'): Promise<unknown> {
    return { code: 0, data: { [type === 'image' ? 'image_key' : 'file_key']: `${type}_uploaded` } }
  }
  async download(): Promise<Buffer> {
    return Buffer.from('resource')
  }
  async start(handlers: FeishuEventHandlers): Promise<void> {
    this.handlers = handlers
    this.lifecycle.ready()
  }
  close(): void {
    this.closed = true
  }
  async receive(type: string, raw: unknown): Promise<unknown> {
    const handler = this.handlers[type]
    if (!handler) throw new Error(`No handler for ${type}`)
    return handler(raw)
  }
}

async function fixture(plugins: Parameters<typeof createTestApp>[0] = {}, config = {}) {
  const t = await createTestApp(plugins)
  const transports: MockTransport[] = []
  const adapter = new FeishuAdapter(feishuSchema.parse({ accounts: [account], ...config }), t.app, {
    createTransport: (entry, lifecycle) => {
      const transport = new MockTransport(lifecycle, `ou_bot_${entry.appId}`)
      transports.push(transport)
      return transport
    },
  })
  t.app.useAdapter(adapter)
  await vi.waitFor(() =>
    expect(t.app.bots.list().filter((b) => b.platform === 'feishu' && b.status === 'online')).toHaveLength(1),
  )
  const bot = t.app.bots.list().find(isFeishu)
  if (!bot) throw new Error('Feishu bot missing')
  return { ...t, adapter, transports, transport: transports[0] as MockTransport, bot }
}

function message(
  text: string,
  options: { id?: string; group?: boolean; parent?: string; mentions?: unknown[] } = {},
) {
  return {
    event_id: options.id ?? randomUUID(),
    create_time: String(Date.now()),
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: `om_${randomUUID()}`,
      chat_id: 'oc_group',
      chat_type: options.group === false ? 'p2p' : 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
      parent_id: options.parent,
      mentions: options.mentions,
    },
  }
}

function cardAction(action: Record<string, unknown>) {
  return {
    event_id: randomUUID(),
    host: 'im_message',
    operator: { open_id: 'ou_user' },
    context: { open_message_id: 'om_card', open_chat_id: 'oc_group' },
    action,
  }
}

function commandValue(bot: FeishuBot, command: string): Record<string, unknown> {
  return z
    .object({ behaviors: z.tuple([z.object({ value: z.record(z.string(), z.unknown()) })]) })
    .parse(bot.feishu.commandButton('执行', command)).behaviors[0].value
}

describe('Feishu adapter', () => {
  it('keeps the bot avatar returned with its identity', async () => {
    const t = await fixture()
    try {
      expect(t.bot.avatar).toBe('https://example.com/bot.png')
      expect(await t.bot.getSelf()).toMatchObject({ avatar: t.bot.avatar })
    } finally {
      await t.dispose()
    }
  })
  it('sends native cards and markdown and updates cards through the API', async () => {
    const t = await fixture()
    try {
      const card = feishu.message(
        [
          feishu.form('request', [
            feishu.input('reason', { required: true }),
            feishu.select('priority', [{ label: '高', value: 'high' }]),
            feishu.submit('提交', 'submit'),
          ]),
        ],
        '申请',
      )
      const result = await t.bot.feishu.sendCard({ type: 'group', id: 'oc_group' }, card)
      await t.bot.feishu.updateCard(result.messageId, feishu.message([feishu.markdown('已完成')]))
      await t.bot.sendPrivate('ou_user', [
        seg.markdown('**原生 Markdown**'),
        seg.button('执行', { command: '/who' }),
      ])
      const requests = t.transport.requests.filter((r) => ['POST', 'PATCH'].includes(r.method))
      expect(requests.map((r) => r.input?.data?.msg_type)).toEqual([
        'interactive',
        undefined,
        'interactive',
        'interactive',
      ])
      expect(JSON.parse(String(requests[0]?.input?.data?.content))).toEqual(card)
      expect(requests[1]?.path).toBe(`/im/v1/messages/${result.messageId}`)
      expect(JSON.stringify(requests)).not.toContain(account.appSecret)
    } finally {
      await t.dispose()
    }
  })

  it('normalizes SDK card callbacks, keeps full form data and responds only once', async () => {
    const events: FeishuCardActionEvent[] = []
    const acceptances: boolean[] = []
    const t = await fixture({
      plugins: [
        definePlugin({
          name: 'forms',
          setup(ctx) {
            ctx.on('notice.feishu.card.action', (event) => {
              if (!isFeishuCardAction(event)) return
              events.push(event)
              acceptances.push(
                event.respond({
                  toast: { type: 'success', content: '已提交' },
                  card: { type: 'raw', data: feishu.message([feishu.markdown('处理中')]) },
                }),
              )
              acceptances.push(event.respond({}))
            })
          },
        }),
      ],
    })
    try {
      const raw = cardAction({
        tag: 'button',
        name: 'submit',
        value: { action: 'create' },
        form_value: { reason: '完整内容', people: ['ou_a', 'ou_b'], nested: { checked: true } },
      })
      const { event_id, ...event } = raw
      const dispatcher = new EventDispatcher({ loggerLevel: 0 }).register(t.transport.handlers)
      const response = await dispatcher.invoke(
        { schema: '2.0', header: { event_id, event_type: 'card.action.trigger' }, event },
        { needCheck: false },
      )
      expect(response).toMatchObject({ toast: { type: 'success' }, card: { type: 'raw' } })
      expect(await t.transport.receive('card.action.trigger', raw)).toEqual(response)
      expect(events).toHaveLength(1)
      expect(acceptances).toEqual([true, false])
      expect(events[0]).toMatchObject({
        userId: 'ou_user',
        groupId: 'oc_group',
        sender: { role: 'owner' },
        action: { formValue: { reason: '完整内容', people: ['ou_a', 'ou_b'], nested: { checked: true } } },
      })
    } finally {
      await t.dispose()
    }
  })

  it('routes signed buttons as the clicking user and keeps forms out of commands', async () => {
    const executed: string[] = []
    const t = await fixture({
      plugins: [
        definePlugin({
          name: 'buttons',
          setup(ctx) {
            ctx.on('notice.feishu.card.action', (event) => {
              if (isFeishuCardAction(event)) event.respond({})
            })
            ctx.command('who').action(({ session }) => {
              executed.push(session.userId)
              return undefined
            })
            ctx
              .command('secure')
              .permission('superuser')
              .action(() => {
                executed.push('privileged')
              })
          },
        }),
      ],
    })
    try {
      await t.transport.receive(
        'card.action.trigger',
        cardAction({ tag: 'button', value: commandValue(t.bot, '/who') }),
      )
      await t.app.whenIdle()
      expect(executed).toEqual(['ou_user'])
      await t.transport.receive(
        'card.action.trigger',
        cardAction({ tag: 'button', value: commandValue(t.bot, '/secure') }),
      )
      await t.transport.receive(
        'card.action.trigger',
        cardAction({ tag: 'button', value: commandValue(t.bot, '/who'), form_value: { reason: '/who' } }),
      )
      await t.transport.receive(
        'card.action.trigger',
        cardAction({ tag: 'button', value: { __asabot_command: { command: '/who', signature: 'forged' } } }),
      )
      await t.app.whenIdle()
      expect(executed).toEqual(['ou_user'])
      t.app.plugins.setGroupEnabled('buttons', 'feishu:oc_group', false)
      await t.transport.receive(
        'card.action.trigger',
        cardAction({ tag: 'button', value: commandValue(t.bot, '/who') }),
      )
      await t.app.whenIdle()
      expect(executed).toEqual(['ou_user'])
    } finally {
      await t.dispose()
    }
  })

  it('returns the callback deadline while business work continues and rejects late responses', async () => {
    let event: FeishuCardActionEvent | undefined
    const t = await fixture({
      plugins: [
        definePlugin({
          name: 'slow-form',
          setup(ctx) {
            ctx.on('notice.feishu.card.action', (value) => {
              if (isFeishuCardAction(value)) event = value
            })
          },
        }),
      ],
    })
    try {
      const response = t.transport.receive(
        'card.action.trigger',
        cardAction({ tag: 'input', name: 'reason', input_value: '输入内容' }),
      )
      await vi.waitFor(() => expect(event?.action.inputValue).toBe('输入内容'))
      expect(await response).toEqual({})
      expect(event?.respond({ toast: { type: 'success', content: '太晚' } })).toBe(false)
      await t.bot.feishu.updateCard('om_card', feishu.message([feishu.markdown('后台任务完成')]))
      expect(t.transport.requests.at(-1)?.method).toBe('PATCH')
    } finally {
      await t.dispose()
    }
  })
  it('receives, deduplicates and dispatches commands with quoting and mention identity', async () => {
    const received: unknown[] = []
    const t = await fixture({
      plugins: [
        definePlugin({
          name: 'commands',
          setup(ctx) {
            ctx.command('echo <text:rest>').action(({ args }) => args.text)
            ctx.on('message', (event) => {
              received.push(event)
            })
          },
        }),
      ],
    })
    try {
      const incoming = message('/echo hello')
      await t.transport.receive('im.message.receive_v1', incoming)
      await t.transport.receive('im.message.receive_v1', incoming)
      await t.app.whenIdle()
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({
        platform: 'feishu',
        userId: 'ou_user',
        groupId: 'oc_group',
        isSuperuser: false,
      })
      expect(t.transport.requests.filter((r) => r.method === 'POST')).toHaveLength(1)
      const quoted = message('@_user_1 /echo mentioned', {
        mentions: [{ key: '@_user_1', id: { open_id: t.bot.selfId }, name: 'bot' }],
      })
      await t.transport.receive('im.message.receive_v1', quoted)
      await t.app.whenIdle()
      expect(received[1]).toMatchObject({
        toMe: true,
        message: [seg.at(t.bot.selfId), seg.text(' /echo mentioned')],
      })
    } finally {
      await t.dispose()
    }
  })

  it('sends mixed messages in order, uploads media and records each emitted message', async () => {
    const t = await fixture()
    const sent: unknown[] = []
    t.app.events.on('bot.message.sent', (event) => {
      if (event.platform === 'feishu') sent.push(event)
    })
    try {
      const result = await t.bot.sendGroup('oc_group', [
        seg.reply('om_parent'),
        seg.text('first'),
        seg.at('ou_user'),
        seg.image(Buffer.from('image')),
        seg.file(Buffer.from('file'), { name: 'example.txt' }),
        seg.text('last'),
      ])
      await t.app.whenIdle()
      const calls = t.transport.requests.filter((r) => r.method === 'POST')
      expect(calls.map((r) => r.input?.data?.msg_type)).toEqual(['post', 'file', 'post'])
      expect(calls.every((r) => r.path.endsWith('/om_parent/reply'))).toBe(true)
      expect(JSON.parse(String(calls[0]?.input?.data?.content)).zh_cn.content[0]).toEqual([
        { tag: 'text', text: 'first' },
        { tag: 'at', user_id: 'ou_user' },
        { tag: 'img', image_key: 'image_uploaded' },
      ])
      expect(sent).toHaveLength(3)
      expect(sent[2]).toMatchObject(result)
      expect((await t.bot.getGroupList())[0]).toMatchObject({ groupId: 'oc_group' })
      expect(await t.bot.getGroupMember('oc_group', 'ou_user')).toMatchObject({ role: 'owner' })
      await expect(t.bot.getFriendList()).rejects.toThrow('不支持')
      t.transport.override = () => {
        throw new Error(`appSecret=${account.appSecret}`)
      }
      await expect(t.bot.sendPrivate('ou_user', 'test')).rejects.toThrow('appSecret=[Redacted]')
    } finally {
      await t.dispose()
    }
  })

  it('tracks SDK connection state, replaces accounts and fences stale callbacks', async () => {
    const t = await fixture()
    try {
      t.transport.lifecycle.reconnecting()
      expect(t.bot.status).toBe('connecting')
      await expect(t.bot.sendGroup('oc_group', 'hello')).rejects.toThrow('online')
      t.transport.lifecycle.ready()
      expect(t.bot.status).toBe('online')
      const other = { appId: 'cli_fedcba9876543210', appSecret: 'another-secret' }
      await t.adapter.reconfigure(feishuSchema.parse({ accounts: [account, other] }))
      expect(t.app.bots.list().filter(isFeishu)).toHaveLength(2)
      expect(t.transports).toHaveLength(2)
      await t.adapter.reconfigure(feishuSchema.parse({ accounts: [other] }))
      expect(t.transport.closed).toBe(true)
      t.transport.lifecycle.ready()
      expect(t.bot.status).toBe('offline')
      expect(t.app.bots.list().filter(isFeishu)).toHaveLength(1)
      await t.adapter.stop()
      expect(t.app.bots.list().filter(isFeishu)).toHaveLength(0)
    } finally {
      await t.dispose()
    }
  })

  it('maps membership and recall events and applies ACL and per-group plugin rules', async () => {
    const notices: unknown[] = []
    const messages: unknown[] = []
    const t = await fixture({
      plugins: [
        definePlugin({
          name: 'events',
          setup(ctx) {
            ctx.on('notice', (e) => {
              notices.push(e)
            })
            ctx.on('message', (e) => {
              messages.push(e)
            })
          },
        }),
      ],
    })
    try {
      const raw = message('hello')
      await t.transport.receive('im.message.receive_v1', raw)
      const base = { event_id: randomUUID(), chat_id: 'oc_group' }
      await t.transport.receive('im.chat.member.user.added_v1', {
        ...base,
        users: [{ user_id: { open_id: 'ou_new' } }],
      })
      await t.transport.receive('im.message.recalled_v1', {
        ...base,
        event_id: randomUUID(),
        message_id: raw.message.message_id,
      })
      await t.app.whenIdle()
      expect(notices).toContainEqual(
        expect.objectContaining({ name: 'notice.member.join', userId: 'ou_new', groupId: 'oc_group' }),
      )
      expect(notices).toContainEqual(
        expect.objectContaining({ name: 'notice.message.recall', userId: 'ou_user' }),
      )
      t.app.storage.access.add('block', 'user', 'feishu:ou_user')
      await t.transport.receive('im.message.receive_v1', message('blocked'))
      await t.app.whenIdle()
      expect(messages).toHaveLength(1)
      t.app.storage.access.remove('block', 'user', 'feishu:ou_user')
      t.app.plugins.setGroupEnabled('events', 'feishu:oc_group', false)
      await t.transport.receive('im.message.receive_v1', message('disabled'))
      await t.app.whenIdle()
      expect(messages).toHaveLength(1)
    } finally {
      await t.dispose()
    }
  })

  it('decodes rich text and media and rejects malformed payloads', async () => {
    expect(
      incomingMessage(
        'post',
        JSON.stringify({
          title: 'Title',
          content: [
            [
              { tag: 'text', text: 'Hello', style: ['bold'] },
              { tag: 'at', user_id: 'ou_user' },
            ],
            [{ tag: 'img', image_key: 'img_key' }],
          ],
        }),
        [],
        'om_parent',
      ),
    ).toEqual([
      seg.reply('om_parent'),
      seg.text('Title\n'),
      seg.text('Hello', ['bold']),
      seg.at('ou_user'),
      seg.text('\n'),
      seg.image('img_key'),
    ])
    expect(incomingMessage('file', '{"file_key":"file_key","file_name":"a.txt"}')).toEqual([
      seg.file('file_key', { name: 'a.txt' }),
    ])
    expect(() => incomingMessage('text', '{}')).toThrow()
    await expect(readMedia('base64://YWJj', 2, 100, new AbortController().signal)).rejects.toThrow('exceeds')
    expect(await readMedia('image_key', 100, 100, new AbortController().signal)).toBeUndefined()
  })

  it('enforces download size and body timeout on external media', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200)
      res.write('abc')
      if (req.url !== '/slow') res.end('def')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test address')
    try {
      const url = `http://127.0.0.1:${address.port}`
      await expect(readMedia(url, 4, 1000, new AbortController().signal)).rejects.toThrow('exceeds')
      await expect(readMedia(`${url}/slow`, 100, 30, new AbortController().signal)).rejects.toThrow()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
