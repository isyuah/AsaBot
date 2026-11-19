import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Writable } from 'node:stream'
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
  type FeishuUploadKind,
  feishu,
  feishuSchema,
  isFeishu,
  isFeishuCardAction,
  isFeishuChatUpdated,
  isFeishuMessageRead,
  isFeishuReaction,
} from '../src/adapters/feishu/index.ts'
import { incomingMessage, readMedia } from '../src/adapters/feishu/message.ts'
import { createLogger, getRecentLogs } from '../src/core/logger.ts'
import { definePlugin, formatTarget, parseTarget, plainText, seg, type Target, z } from '../src/index.ts'
import { createTestApp } from '../src/testing/index.ts'

const account = { appId: 'cli_0123456789abcdef', appSecret: 'test-app-secret' }
class MockTransport implements FeishuTransport {
  handlers: FeishuEventHandlers = {}
  requests: { method: string; path: string; input?: FeishuRequest }[] = []
  uploads: FeishuUploadKind[] = []
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
    if (method === 'GET' && path === '/im/v1/messages/om_card')
      return { code: 0, data: { items: [messageResource('om_card')] } }
    return { code: 0, data: { message_id: `om_${this.requests.length}` } }
  }
  async upload(type: FeishuUploadKind): Promise<unknown> {
    this.uploads.push(type)
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

const topic = { id: 'omt_topic', rootMessageId: 'om_root' }
function topicMessage(text: string, mentions?: unknown[], thread = topic, group = true) {
  const event = message(text, { group, mentions, parent: thread.rootMessageId })
  return { ...event, message: { ...event.message, thread_id: thread.id, root_id: thread.rootMessageId } }
}

function messageResource(id: string, overrides: Record<string, unknown> = {}) {
  return {
    message_id: id,
    msg_type: 'text',
    create_time: '1760000000000',
    chat_id: 'oc_group',
    sender: { id: 'ou_user', sender_type: 'user' },
    body: { content: JSON.stringify({ text: '内容' }) },
    ...overrides,
  }
}

function commandValue(bot: FeishuBot, command: string): Record<string, unknown> {
  return z
    .object({ behaviors: z.tuple([z.object({ value: z.record(z.string(), z.unknown()) })]) })
    .parse(bot.feishu.commandButton('执行', command)).behaviors[0].value
}

describe('Feishu adapter', () => {
  it('routes commands, split messages, card commands and persisted tasks to the original thread', async () => {
    const t = await fixture({
      plugins: [
        definePlugin({
          name: 'topic-work',
          setup(ctx) {
            const task = ctx.task<Target>('notify', async (target) => {
              await ctx.send(target, '完工')
            })
            ctx.command('work').action(({ session }) => {
              expect(parseTarget(formatTarget(session.target))).toEqual(session.target)
              task.schedule(session.target, { delay: 0 })
              return '已收到'
            })
            ctx.command('long').action(() => '长'.repeat(1200))
            ctx.command('card-command').action(() => '卡片按钮已执行')
          },
        }),
      ],
    })
    const sends = () => t.transport.requests.filter(({ method }) => method === 'POST')
    const mention = [{ key: '@_user_1', id: { open_id: t.bot.selfId } }]
    const target = { type: 'group' as const, id: 'oc_group', thread: topic }
    try {
      await t.app.plugins.updateConfig('long-message', { splitInterval: 0 })
      await t.transport.receive('im.message.receive_v1', topicMessage('@_user_1 /work', mention))
      await t.app.whenIdle()
      await vi.waitFor(() =>
        expect(t.app.tasks.query({ plugin: 'topic-work' }).items[0]?.state).toBe('succeeded'),
      )
      expect(sends()).toHaveLength(2)

      await t.transport.receive('im.message.receive_v1', topicMessage('@_user_1 /long', mention))
      await t.app.whenIdle()
      expect(sends()).toHaveLength(4)
      const card = await t.bot.feishu.sendCard(
        target,
        feishu.message([t.bot.feishu.commandButton('执行', '/card-command')]),
      )
      const click = cardAction({ tag: 'button', value: commandValue(t.bot, '/card-command') })
      click.context.open_message_id = card.messageId
      await t.transport.receive('card.action.trigger', click)
      await t.app.whenIdle()
      expect(sends()).toHaveLength(6)
      expect(
        sends().every(
          ({ path, input }) =>
            path === '/im/v1/messages/om_root/reply' && input?.data?.reply_in_thread === true,
        ),
      ).toBe(true)

      t.app.plugins.setGroupEnabled('topic-work', `feishu:${t.bot.selfId}:group:oc_group`, false)
      await t.transport.receive('im.message.receive_v1', topicMessage('@_user_1 /work', mention))
      await t.app.whenIdle()
      expect(sends()).toHaveLength(6)
      expect(t.app.tasks.query({ plugin: 'topic-work' }).total).toBe(1)
    } finally {
      await t.dispose()
    }
  })

  it('isolates prompts by thread while preserving ordinary and private conversations', async () => {
    const answered: string[] = []
    const t = await fixture({
      plugins: [
        definePlugin({
          name: 'topic-prompt',
          setup(ctx) {
            ctx.command('ask').action(async ({ session }) => {
              const answer = await session.prompt('请回答')
              if (answer) answered.push(answer.text)
            })
            ctx.command('hello').action(() => '收到')
          },
        }),
      ],
    })
    const sends = () => t.transport.requests.filter(({ method }) => method === 'POST')
    try {
      await t.transport.receive('im.message.receive_v1', topicMessage('/ask'))
      await t.app.whenIdle()
      await t.transport.receive(
        'im.message.receive_v1',
        topicMessage('错误话题', undefined, { id: 'omt_other', rootMessageId: 'om_other' }),
      )
      await t.transport.receive('im.message.receive_v1', message('主聊天'))
      await t.app.whenIdle()
      expect(answered).toEqual([])
      await t.transport.receive('im.message.receive_v1', topicMessage('同一话题'))
      await t.app.whenIdle()
      expect(answered).toEqual(['同一话题'])
      expect(sends()[0]?.path).toBe('/im/v1/messages/om_root/reply')
      await t.transport.receive('im.message.receive_v1', topicMessage('/hello', undefined, topic, false))
      await t.transport.receive('im.message.receive_v1', message('/hello', { group: false }))
      await t.app.whenIdle()
      expect(
        sends()
          .slice(1)
          .map(({ path }) => path),
      ).toEqual(['/im/v1/messages/om_root/reply', '/im/v1/messages'])
    } finally {
      await t.dispose()
    }
  })

  it('resolves older cards to their thread and offers explicit thread creation and paginated history', async () => {
    const t = await fixture({
      plugins: [
        definePlugin({
          name: 'topic-card',
          setup(ctx) {
            ctx.command('answer').action(() => '收到')
          },
        }),
      ],
    })
    t.transport.override = (method, path, input) => {
      if (method === 'GET' && path === '/im/v1/messages/om_card')
        return {
          code: 0,
          data: {
            items: [messageResource('om_card', { thread_id: topic.id, root_id: topic.rootMessageId })],
          },
        }
      if (method === 'POST' && path === '/im/v1/messages/om_quote/reply')
        return { code: 0, data: { message_id: 'om_ack', thread_id: 'omt_new', root_id: 'om_new' } }
      if (method === 'POST' && path === '/im/v1/messages/om_new/reply')
        return { code: 0, data: { message_id: 'om_followup', thread_id: 'omt_new', root_id: 'om_new' } }
      if (method === 'GET' && path === '/im/v1/messages' && input?.params?.container_id === topic.id) {
        return {
          code: 0,
          data: input.params.page_token
            ? {
                items: [
                  messageResource('om_removed', {
                    thread_id: topic.id,
                    root_id: topic.rootMessageId,
                    deleted: true,
                    body: undefined,
                  }),
                ],
                has_more: false,
              }
            : {
                items: [
                  messageResource('om_post', {
                    thread_id: topic.id,
                    root_id: topic.rootMessageId,
                    parent_id: topic.rootMessageId,
                    body: { content: '{"text":"@_user_1 hi"}' },
                    mentions: [{ key: '@_user_1', id: 'ou_friend' }],
                  }),
                ],
                has_more: true,
                page_token: 'next',
              },
        }
      }
    }
    try {
      await t.transport.receive(
        'card.action.trigger',
        cardAction({ tag: 'button', value: commandValue(t.bot, '/answer') }),
      )
      await t.app.whenIdle()
      expect(t.transport.requests).toContainEqual(
        expect.objectContaining({ method: 'POST', path: '/im/v1/messages/om_root/reply' }),
      )
      const unknown = cardAction({ tag: 'button', value: commandValue(t.bot, '/answer') })
      unknown.context.open_message_id = 'om_unknown'
      expect(await t.transport.receive('card.action.trigger', unknown)).toMatchObject({
        toast: { type: 'warning' },
      })
      await t.app.whenIdle()
      expect(t.transport.requests.filter(({ method }) => method === 'POST')).toHaveLength(1)
      await t.app.plugins.updateConfig('long-message', { splitInterval: 0 })
      const group = { type: 'group', id: 'oc_group' } as const
      const created = await t.bot.feishu.replyInThread(group, 'om_quote', '长'.repeat(1200))
      expect(created).toEqual({
        messageId: 'om_followup',
        thread: { id: 'omt_new', rootMessageId: 'om_new' },
      })
      expect(t.transport.requests.filter(({ method }) => method === 'POST').slice(1)).toMatchObject([
        { path: '/im/v1/messages/om_quote/reply', input: { data: { reply_in_thread: true } } },
        { path: '/im/v1/messages/om_new/reply', input: { data: { reply_in_thread: true } } },
      ])
      await expect(
        t.bot.feishu.replyInThread({ ...group, thread: created.thread }, 'om_other', '忽略'),
      ).rejects.toThrow('thread root')
      const container = { type: 'thread', id: topic.id } as const
      const first = await t.bot.feishu.listMessages(container, { pageSize: 1, order: 'asc' })
      expect(first).toMatchObject({
        items: [{ thread: topic, message: [seg.reply('om_root'), seg.at('ou_friend'), seg.text(' hi')] }],
        pageToken: 'next',
      })
      const second = await t.bot.feishu.listMessages(container, {
        pageSize: 1,
        order: 'asc',
        pageToken: first.pageToken,
      })
      expect(second.items).toMatchObject([{ messageId: 'om_removed', deleted: true, message: [] }])
      expect(second.pageToken).toBeUndefined()
      expect(t.transport.requests).toContainEqual({
        method: 'GET',
        path: '/im/v1/messages',
        input: {
          params: {
            container_id_type: 'thread',
            container_id: topic.id,
            sort_type: 'ByCreateTimeAsc',
            page_size: 1,
            page_token: 'next',
          },
        },
      })
      await expect(t.bot.feishu.listMessages(container, { startTime: 1760000000000 })).rejects.toThrow(
        'time filters',
      )
    } finally {
      await t.dispose()
    }
  })

  it('keeps split media in a newly created topic and decodes Feishu audio and video', async () => {
    const t = await fixture()
    t.transport.override = (method, path) => {
      if (method === 'POST' && path === '/im/v1/messages')
        return { code: 0, data: { message_id: 'om_root', thread_id: topic.id } }
      if (method === 'POST' && path === '/im/v1/messages/om_root/reply')
        return {
          code: 0,
          data: { message_id: `om_${randomUUID()}`, thread_id: topic.id, root_id: topic.rootMessageId },
        }
    }
    try {
      const sent = await t.bot.sendGroup('oc_group', [
        seg.text('更新'),
        seg.audio(Buffer.from('voice')),
        seg.video(Buffer.from('video')),
        feishu.sticker('file_sticker'),
      ])
      expect(sent.thread).toEqual(topic)
      expect(t.transport.uploads).toEqual(['audio', 'video'])
      const sentRequests = t.transport.requests.filter(({ method }) => method === 'POST')
      expect(sentRequests.map(({ path, input }) => [path, input?.data?.msg_type])).toEqual([
        ['/im/v1/messages', 'text'],
        ['/im/v1/messages/om_root/reply', 'audio'],
        ['/im/v1/messages/om_root/reply', 'media'],
        ['/im/v1/messages/om_root/reply', 'sticker'],
      ])
      expect(incomingMessage('audio', '{"file_key":"file_voice","duration":2000}')).toEqual([
        seg.audio('file_voice'),
      ])
      expect(incomingMessage('media', '{"file_key":"file_video","image_key":"img_cover"}')).toEqual([
        seg.video('file_video'),
      ])
    } finally {
      await t.dispose()
    }
  })

  it('forwards existing messages to a thread and reads back the correct merged children', async () => {
    const t = await fixture()
    t.transport.override = (method, path) => {
      if (method === 'POST' && path === '/im/v1/messages/merge_forward')
        return {
          code: 0,
          data: {
            message_id: 'om_merged',
            thread_id: topic.id,
            root_id: topic.rootMessageId,
            invalid_message_id_list: ['om_missing'],
          },
        }
      if (method === 'GET' && path === '/im/v1/messages/om_merged')
        return {
          code: 0,
          data: {
            items: [
              messageResource('om_child', { upper_message_id: 'om_merged' }),
              messageResource('om_other', { upper_message_id: 'om_nested' }),
              messageResource('om_nested', {
                msg_type: 'merge_forward',
                body: { content: 'Merged and Forwarded Message' },
                upper_message_id: 'om_merged',
              }),
              messageResource('om_merged', {
                msg_type: 'merge_forward',
                body: { content: 'Merged and Forwarded Message' },
                thread_id: topic.id,
                root_id: topic.rootMessageId,
              }),
            ],
          },
        }
    }
    try {
      const destination = { type: 'group' as const, id: 'oc_group', thread: topic }
      const merged = await t.bot.feishu.mergeForward(['om_source', 'om_missing'], destination)
      expect(merged).toEqual({ messageId: 'om_merged', thread: topic, invalidMessageIds: ['om_missing'] })
      expect(await t.bot.getMessage(merged.messageId)).toMatchObject({
        thread: topic,
        message: [seg.forward('om_merged')],
      })
      expect((await t.bot.getForward(merged.messageId)).map((item) => item.message)).toEqual([
        [seg.text('内容')],
        [seg.forward('om_nested')],
      ])
      await t.bot.feishu.forwardMessage('om_source', destination)
      await t.bot.feishu.forwardThread(topic.id, { type: 'private', id: 'ou_friend' })
      const post = t.transport.requests.filter(({ method }) => method === 'POST')
      expect(post).toMatchObject([
        {
          path: '/im/v1/messages/merge_forward',
          input: {
            params: { receive_id_type: 'thread_id' },
            data: { receive_id: topic.id, message_id_list: ['om_source', 'om_missing'] },
          },
        },
        {
          path: '/im/v1/messages/om_source/forward',
          input: { params: { receive_id_type: 'thread_id' }, data: { receive_id: topic.id } },
        },
        {
          path: '/im/v1/threads/omt_topic/forward',
          input: { params: { receive_id_type: 'open_id' }, data: { receive_id: 'ou_friend' } },
        },
      ])
    } finally {
      await t.dispose()
    }
  })

  it('edits text and reports unavailable or pending recipients of group operations', async () => {
    const t = await fixture()
    t.transport.override = (method, path) => {
      if (method === 'POST' && path === '/im/v1/chats/oc_group/members')
        return {
          code: 0,
          data: {
            invalid_id_list: ['ou_invalid'],
            not_existed_id_list: ['ou_missing'],
            pending_approval_id_list: ['ou_pending'],
          },
        }
      if (method === 'DELETE' && path === '/im/v1/chats/oc_group/members')
        return { code: 0, data: { invalid_id_list: ['ou_invalid'] } }
      if (method === 'PATCH' && path === '/im/v1/messages/om_target/urgent_app')
        return { code: 0, data: { invalid_user_id_list: ['ou_invalid'] } }
    }
    try {
      const api = t.bot.feishu
      await api.editMessage('om_target', '已处理')
      await api.setChatMessageMode('oc_group', 'thread')
      expect(
        await api.addChatMembers('oc_group', ['ou_user', 'ou_invalid', 'ou_missing', 'ou_pending']),
      ).toEqual({
        invalidIds: ['ou_invalid'],
        missingIds: ['ou_missing'],
        pendingApprovalIds: ['ou_pending'],
      })
      expect(await api.urgentApp('om_target', ['ou_user', 'ou_invalid'])).toEqual({
        invalidUserIds: ['ou_invalid'],
      })
      await expect(t.bot.kickMember('oc_group', 'ou_invalid')).rejects.toThrow('could not remove')
      expect(t.transport.requests.slice(1)).toEqual([
        {
          method: 'PUT',
          path: '/im/v1/messages/om_target',
          input: { data: { msg_type: 'text', content: '{"text":"已处理"}' } },
        },
        { method: 'PUT', path: '/im/v1/chats/oc_group', input: { data: { group_message_type: 'thread' } } },
        {
          method: 'POST',
          path: '/im/v1/chats/oc_group/members',
          input: {
            params: { member_id_type: 'open_id', succeed_type: 1 },
            data: { id_list: ['ou_user', 'ou_invalid', 'ou_missing', 'ou_pending'] },
          },
        },
        {
          method: 'PATCH',
          path: '/im/v1/messages/om_target/urgent_app',
          input: { params: { user_id_type: 'open_id' }, data: { user_id_list: ['ou_user', 'ou_invalid'] } },
        },
        {
          method: 'DELETE',
          path: '/im/v1/chats/oc_group/members',
          input: { params: { member_id_type: 'open_id' }, data: { id_list: ['ou_invalid'] } },
        },
      ])
    } finally {
      await t.dispose()
    }
  })

  it('keeps reaction IDs and pagination for reactions, pinned messages and readers', async () => {
    const t = await fixture()
    const reaction = {
      reaction_id: 'reaction/id',
      action_time: '1760000000000',
      operator: { operator_type: 'app', operator_id: 'cli_bot' },
      reaction_type: { emoji_type: 'THUMBSUP' },
    }
    t.transport.override = (method, path, input) => {
      if (path === '/im/v1/messages/om_target/reactions') {
        if (method === 'POST') return { code: 0, data: reaction }
        if (input?.params?.page_token === 'next') return { code: 0, data: { items: [], has_more: false } }
        return { code: 0, data: { items: [reaction], has_more: true, page_token: 'next' } }
      }
      if (method === 'GET' && path === '/im/v1/pins')
        return {
          code: 0,
          data: {
            items: [
              {
                message_id: 'om_target',
                chat_id: 'oc_group',
                operator_id: 'ou_user',
                create_time: '1760000000000',
              },
            ],
            has_more: false,
          },
        }
      if (path === '/im/v1/messages/om_target/read_users')
        return {
          code: 0,
          data: { items: [{ user_id: 'ou_user', timestamp: '1760000000000' }], has_more: false },
        }
    }
    try {
      const api = t.bot.feishu
      const reactionId = await api.addReaction('om_target', 'THUMBSUP')
      const first = await api.listReactions('om_target', { emoji: 'THUMBSUP', pageSize: 1 })
      expect(first).toEqual({
        items: [
          { reactionId, emoji: 'THUMBSUP', operatorId: 'cli_bot', operatorType: 'app', time: 1760000000000 },
        ],
        pageToken: 'next',
      })
      expect(await api.listReactions('om_target', { pageToken: first.pageToken })).toEqual({ items: [] })
      await api.removeReaction('om_target', reactionId)
      await api.pinMessage('om_target')
      expect(await api.listPins('oc_group')).toEqual({
        items: [{ messageId: 'om_target', chatId: 'oc_group', operatorId: 'ou_user', time: 1760000000000 }],
      })
      await api.unpinMessage('om_target')
      expect(await api.listReadUsers('om_target', { pageSize: 100 })).toEqual({
        items: [{ userId: 'ou_user', time: 1760000000000 }],
      })
      expect(t.transport.requests.slice(1)).toMatchObject([
        {
          method: 'POST',
          path: '/im/v1/messages/om_target/reactions',
          input: { data: { reaction_type: { emoji_type: 'THUMBSUP' } } },
        },
        {
          method: 'GET',
          path: '/im/v1/messages/om_target/reactions',
          input: { params: { user_id_type: 'open_id', reaction_type: 'THUMBSUP', page_size: 1 } },
        },
        {
          method: 'GET',
          path: '/im/v1/messages/om_target/reactions',
          input: { params: { page_token: 'next' } },
        },
        { method: 'DELETE', path: '/im/v1/messages/om_target/reactions/reaction%2Fid' },
        { method: 'POST', path: '/im/v1/pins', input: { data: { message_id: 'om_target' } } },
        { method: 'GET', path: '/im/v1/pins', input: { params: { chat_id: 'oc_group' } } },
        { method: 'DELETE', path: '/im/v1/pins/om_target' },
        {
          method: 'GET',
          path: '/im/v1/messages/om_target/read_users',
          input: { params: { page_size: 100 } },
        },
      ])
    } finally {
      await t.dispose()
    }
  })

  it('respects group policy for reactions and refreshes roles after a group change', async () => {
    const observed: unknown[] = []
    const t = await fixture({
      plugins: [
        definePlugin({
          name: 'feishu-events',
          setup(ctx) {
            ctx.on('notice', (event) => {
              if (isFeishuReaction(event) || isFeishuChatUpdated(event) || isFeishuMessageRead(event))
                observed.push(event)
            })
            ctx.command('role').action(({ session }) => session.sender.role)
          },
        }),
      ],
    })
    let newOwner = false
    t.transport.override = (method, path) => {
      if (method === 'GET' && path === '/im/v1/chats/oc_group')
        return { code: 0, data: { chat_mode: 'group', owner_id: newOwner ? 'ou_other' : 'ou_user' } }
    }
    try {
      const incoming = topicMessage('/role')
      await t.transport.receive('im.message.receive_v1', incoming)
      await t.app.whenIdle()
      const reaction = {
        event_id: randomUUID(),
        message_id: incoming.message.message_id,
        reaction_type: { emoji_type: 'THUMBSUP' },
        operator_type: 'user',
        user_id: { open_id: 'ou_user' },
        action_time: '1760000000000',
      }
      await t.transport.receive('im.message.reaction.created_v1', reaction)
      await t.transport.receive('im.message.reaction.created_v1', reaction)
      await t.app.whenIdle()
      expect(observed).toMatchObject([
        {
          name: 'notice.feishu.reaction.added',
          groupId: 'oc_group',
          thread: topic,
          emoji: 'THUMBSUP',
          userId: 'ou_user',
        },
      ])

      newOwner = true
      await t.transport.receive('im.chat.updated_v1', {
        event_id: randomUUID(),
        chat_id: 'oc_group',
        after_change: { group_message_type: 'thread' },
      })
      await t.transport.receive('im.message.receive_v1', topicMessage('/role'))
      await t.app.whenIdle()
      expect(observed.at(-1)).toMatchObject({
        name: 'notice.feishu.chat.updated',
        after: { group_message_type: 'thread' },
      })
      expect(
        t.transport.requests
          .filter(({ method }) => method === 'POST')
          .map(({ input }) => input?.data?.content),
      ).toEqual(['{"text":"owner"}', '{"text":"member"}'])

      t.app.plugins.setGroupEnabled('feishu-events', `feishu:${t.bot.selfId}:group:oc_group`, false)
      await t.transport.receive('im.message.reaction.deleted_v1', { ...reaction, event_id: randomUUID() })
      await t.app.whenIdle()
      expect(observed).toHaveLength(2)
      const read = {
        event_id: randomUUID(),
        reader: { reader_id: { open_id: 'ou_user' }, read_time: '1760000000000' },
        message_id_list: ['om_a', 'om_b'],
      }
      await t.transport.receive('im.message.message_read_v1', read)
      await t.transport.receive('im.message.message_read_v1', read)
      await t.app.whenIdle()
      expect(observed.slice(2)).toMatchObject([
        {
          name: 'notice.feishu.message.read',
          userId: 'ou_user',
          time: 1760000000000,
          messageIds: ['om_a', 'om_b'],
        },
      ])
    } finally {
      await t.dispose()
    }
  })

  it('reports the canonical user identity without admin permission and reflects saved bot admins', async () => {
    const t = await fixture()
    const replies: string[] = []
    t.app.events.on('bot.message.sent', (event) => replies.push(plainText(event.message)))
    const receive = async () => {
      await t.transport.receive('im.message.receive_v1', {
        ...message('/whoami', { group: false }),
        sender: {
          sender_id: { open_id: 'ou_user', user_id: 'employee-123' },
          sender_type: 'user',
        },
      })
      await t.app.whenIdle()
    }
    try {
      t.app.policies.setAdmins(t.bot, ['employee-123'])
      await receive()
      expect(replies.at(-1)).toContain('用户 ID：ou_user')
      expect(replies.at(-1)).toContain('机器人管理员：否')
      t.app.policies.setAdmins(t.bot, ['ou_user'])
      await receive()
      expect(replies.at(-1)).toContain('机器人管理员：是')
      expect(replies.at(-1)).toContain('框架管理员：否')
    } finally {
      await t.dispose()
    }
  })

  it('records lifecycle and deduplicated message identities at info level with redacted previews', async () => {
    const t = await fixture()
    let output = ''
    const log = createLogger({
      pretty: false,
      destination: new Writable({
        write(chunk, _encoding, callback) {
          output += chunk.toString()
          callback()
        },
      }),
    })
    const info = vi.spyOn(t.app.logger, 'info').mockImplementation(log.info.bind(log))
    const warn = vi.spyOn(t.app.logger, 'warn').mockImplementation(log.warn.bind(log))
    try {
      t.transport.lifecycle.reconnecting()
      t.transport.lifecycle.ready()
      const incoming = message(`token=private-value ${account.appSecret} ${'😀'.repeat(220)}`, {
        group: false,
      })
      await t.transport.receive('im.message.receive_v1', incoming)
      await t.transport.receive('im.message.receive_v1', incoming)
      await t.app.whenIdle()
      const received = getRecentLogs().filter(
        (record) => record.eventId === incoming.event_id && record.msg === 'Feishu message received',
      )
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({
        level: 30,
        platform: 'feishu',
        selfId: t.bot.selfId,
        userId: 'ou_user',
        messageId: incoming.message.message_id,
        isBotAdmin: false,
      })
      expect([...String(received[0]?.preview)]).toHaveLength(200)
      const sent = await t.bot.sendPrivate('ou_user', 'test')
      expect(getRecentLogs()).toContainEqual(
        expect.objectContaining({
          level: 30,
          msg: 'Feishu message sent',
          platform: 'feishu',
          selfId: t.bot.selfId,
          userId: 'ou_user',
          messageId: sent.messageId,
        }),
      )
      await t.adapter.stop()
      expect(output).toContain('Reconnecting Feishu long connection')
      expect(output).toContain('Feishu bot online')
      expect(output).toContain('Feishu bot offline (stopping)')
      expect(output).toContain('[Redacted]')
      expect(output).not.toContain(account.appSecret)
      expect(output).not.toContain('private-value')
    } finally {
      info.mockRestore()
      warn.mockRestore()
      await t.dispose()
    }
  })

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
      t.app.plugins.setGroupEnabled('buttons', 'feishu:ou_bot_cli_0123456789abcdef:group:oc_group', false)
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
      expect(calls.map((r) => r.input?.data?.msg_type)).toEqual(['post', 'file', 'text'])
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
      t.app.plugins.setGroupEnabled('events', 'feishu:ou_bot_cli_0123456789abcdef:group:oc_group', false)
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
