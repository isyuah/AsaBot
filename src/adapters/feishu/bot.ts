import { createHmac, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AdapterHost } from '../../core/adapter.ts'
import type {
  Bot,
  ForwardMessage,
  ForwardNode,
  GroupInfo,
  GroupMemberInfo,
  MessageInfo,
  MessageTarget,
  SendResult,
  UserInfo,
} from '../../core/bot.ts'
import { dispatchContext } from '../../core/dispatch/trace.ts'
import { NotConnectedError, UnsupportedError } from '../../core/errors.ts'
import type { Session } from '../../core/event/index.ts'
import { isSegment, type Message, normalizeSendable, type Sendable } from '../../core/message/index.ts'
import { LruSet } from '../../core/utils/lru.ts'
import { redactText } from '../../core/utils/redact.ts'
import { constantTimeEqual } from '../../core/utils/security.ts'
import { cardSchema, type FeishuCard, type FeishuElement, feishu } from './cards.ts'
import type { FeishuConfig } from './config.ts'
import { incomingMessage, readMedia } from './message.ts'
import type { FeishuRequest, FeishuTransport } from './transport.ts'

export interface FeishuApi {
  sendCard(target: MessageTarget, card: FeishuCard): Promise<SendResult>
  updateCard(messageId: string, card: FeishuCard): Promise<void>
  commandButton(label: string, command: string): FeishuElement
  downloadResource(messageId: string, key: string, type: 'image' | 'file'): Promise<Buffer>
}
export interface FeishuBot extends Bot {
  readonly feishu: FeishuApi
}
export function isFeishu(bot: Bot): bot is FeishuBot {
  return bot.platform === 'feishu' && 'feishu' in bot
}

const envelope = z.object({ code: z.number(), msg: z.string().optional() }).passthrough()
const sentSchema = z.object({ message_id: z.string().min(1) })
const memberSchema = z.object({ member_id: z.string(), name: z.string().default('') })
const chatSchema = z.object({
  chat_mode: z.enum(['group', 'p2p', 'topic']).optional(),
  owner_id: z.string().optional(),
  user_manager_id_list: z.array(z.string()).default([]),
})

export class FeishuBotImpl implements FeishuBot {
  readonly platform = 'feishu'
  readonly capabilities = {
    segments: ['text', 'at', 'reply', 'image', 'file', 'markdown', 'button', 'feishu:card'],
    textStyles: ['bold', 'italic', 'underline', 'strike', 'code'] as const,
    actions: [
      'sendPrivate',
      'sendGroup',
      'getSelf',
      'getGroupList',
      'getGroupMember',
      'getGroupMembers',
      'getMessage',
      'deleteMessage',
      'call',
    ],
  }
  status: Bot['status'] = 'connecting'
  readonly selfId: string
  readonly nickname: string
  readonly avatar?: string
  readonly feishu: FeishuApi
  readonly sentMessageIds = new LruSet<string>(1000)
  readonly shutdown = new AbortController()
  private readonly host: AdapterHost
  private readonly transport: FeishuTransport
  private readonly config: FeishuConfig
  private readonly buttonSecret: string
  private readonly roles = new Map<
    string,
    { expires: number; value: Promise<z.output<typeof chatSchema> | undefined> }
  >()

  constructor(
    host: AdapterHost,
    transport: FeishuTransport,
    self: UserInfo,
    config: FeishuConfig,
    buttonSecret: string,
  ) {
    this.host = host
    this.transport = transport
    this.selfId = self.userId
    this.nickname = self.nickname
    this.avatar = self.avatar
    this.config = config
    this.buttonSecret = buttonSecret
    this.feishu = {
      sendCard: (target, card) =>
        target.type === 'group'
          ? this.sendGroup(target.id, feishu.card(card))
          : this.sendPrivate(target.id, feishu.card(card)),
      commandButton: (label, command) => this.commandButton(label, command),
      updateCard: async (messageId, card) => {
        await this.host.invokeApi(
          { bot: this, method: 'feishu.updateCard', args: [messageId, card] },
          async (args) => {
            const [id, value] = z.tuple([z.string().min(1), cardSchema]).parse(args)
            this.assertOnline()
            await this.raw('PATCH', `/im/v1/messages/${encodeURIComponent(id)}`, {
              data: { content: JSON.stringify(value) },
            })
          },
        )
      },
      downloadResource: async (messageId, key, type) => {
        const result = await this.host.invokeApi(
          { bot: this, method: 'feishu.downloadResource', args: [messageId, key, type] },
          async (args) => {
            const [id, fileKey, kind] = z
              .tuple([z.string(), z.string(), z.enum(['image', 'file'])])
              .parse(args)
            this.assertOnline()
            return this.safe(() => this.transport.download(id, fileKey, kind))
          },
        )
        return z.instanceof(Buffer).parse(result)
      },
    }
  }

  private signature(command: string): string {
    return createHmac('sha256', this.buttonSecret)
      .update(JSON.stringify([this.selfId, command]))
      .digest('base64url')
  }

  private commandButton(label: string, command: string): FeishuElement {
    z.string().min(1).max(2000).parse(command)
    return feishu.button(label, {
      value: { __asabot_command: { command, signature: this.signature(command) } },
    })
  }

  commandFrom(value: Record<string, unknown>): string | undefined {
    const result = z
      .object({ command: z.string().min(1).max(2000), signature: z.string() })
      .safeParse(value.__asabot_command)
    if (!result.success || !constantTimeEqual(result.data.signature, this.signature(result.data.command)))
      return undefined
    return result.data.command
  }

  async resolveChannel(
    chatId: string,
  ): Promise<{ messageType: 'private' } | { messageType: 'group'; groupId: string }> {
    const cached = this.roles.get(chatId)
    const chat = cached && cached.expires > Date.now() ? await cached.value : undefined
    const mode =
      chat?.chat_mode ??
      (
        await this.data(
          'GET',
          `/im/v1/chats/${encodeURIComponent(chatId)}`,
          z.object({ chat_mode: z.enum(['group', 'p2p', 'topic']) }),
          { params: { user_id_type: 'open_id' } },
        )
      ).chat_mode
    return mode === 'p2p' ? { messageType: 'private' } : { messageType: 'group', groupId: chatId }
  }

  async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      throw new Error(redactText(error instanceof Error ? error.message : String(error), this.config))
    }
  }

  async raw(method: string, path: string, input?: FeishuRequest): Promise<z.output<typeof envelope>> {
    return this.safe(async () => {
      const result = envelope.parse(await this.transport.request(method, path, input))
      if (result.code !== 0) throw new Error(`Feishu API ${result.code}: ${result.msg ?? 'request failed'}`)
      return result
    })
  }

  async data<T>(method: string, path: string, schema: z.ZodType<T>, input?: FeishuRequest): Promise<T> {
    const result = await this.raw(method, path, input)
    return schema.parse(result.data)
  }

  private assertOnline(): void {
    if (this.status !== 'online') throw new NotConnectedError()
  }

  async resolveSender(userId: string, groupId?: string): Promise<Session['sender']> {
    const sender = { userId, nickname: userId }
    if (!groupId) return sender
    let cached = this.roles.get(groupId)
    if (!cached || cached.expires < Date.now()) {
      const value = this.data('GET', `/im/v1/chats/${encodeURIComponent(groupId)}`, chatSchema, {
        params: { user_id_type: 'open_id' },
      }).catch((error: unknown) => {
        this.host.logger.warn(
          {
            platform: 'feishu',
            groupId,
            reason: redactText(error instanceof Error ? error.message : String(error), this.config),
          },
          'Cannot resolve Feishu group roles',
        )
        return undefined
      })
      cached = { expires: Date.now() + 30_000, value }
      this.roles.delete(groupId)
      this.roles.set(groupId, cached)
      while (this.roles.size > 500) this.roles.delete(this.roles.keys().next().value as string)
    }
    const chat = await cached.value
    if (!chat) return sender
    return {
      ...sender,
      role:
        userId === chat.owner_id ? 'owner' : chat.user_manager_id_list.includes(userId) ? 'admin' : 'member',
    }
  }

  sendPrivate(userId: string, content: Sendable): Promise<SendResult> {
    return this.send({ type: 'private', id: userId }, content)
  }
  sendGroup(groupId: string, content: Sendable): Promise<SendResult> {
    return this.send({ type: 'group', id: groupId }, content)
  }

  private async media(type: 'image' | 'file', source: string, name = 'file'): Promise<string> {
    const bytes = await readMedia(
      source,
      Math.min(this.config.mediaMaxBytes, type === 'image' ? 10 * 1024 * 1024 : 30 * 1024 * 1024),
      this.config.apiTimeout,
      this.shutdown.signal,
    )
    if (bytes === undefined) return source
    const result = envelope.parse(await this.safe(() => this.transport.upload(type, bytes, name)))
    if (result.code !== 0)
      throw new Error(`Feishu upload ${result.code}: ${redactText(result.msg ?? 'failed', this.config)}`)
    const field = type === 'image' ? 'image_key' : 'file_key'
    return z.object({ [field]: z.string() }).parse(result.data)[field] as string
  }

  private async send(target: MessageTarget, content: Sendable): Promise<SendResult> {
    this.assertOnline()
    const prepared = await this.host.prepareOutgoing({
      bot: this,
      target,
      message: normalizeSendable(content),
    })
    if (!Array.isArray(prepared)) return prepared.sent
    let replyId: string | undefined
    let post: Record<string, unknown>[] = []
    let original: Message = []
    let last: SendResult | undefined
    const deliver = async (type: string, body: Record<string, unknown>, message: Message) => {
      this.assertOnline()
      const response = await this.data(
        'POST',
        replyId ? `/im/v1/messages/${encodeURIComponent(replyId)}/reply` : '/im/v1/messages',
        sentSchema,
        {
          ...(replyId
            ? {}
            : { params: { receive_id_type: target.type === 'group' ? 'chat_id' : 'open_id' } }),
          data: {
            ...(replyId ? {} : { receive_id: target.id }),
            msg_type: type,
            content: JSON.stringify(body),
            uuid: randomUUID(),
          },
        },
      )
      last = { messageId: response.message_id }
      this.sentMessageIds.add(last.messageId)
      const context = dispatchContext.getStore()
      this.host.emit({
        id: randomUUID(),
        platform: this.platform,
        selfId: this.selfId,
        time: Date.now(),
        kind: 'internal',
        name: 'bot.message.sent',
        raw: response,
        bot: this,
        messageId: last.messageId,
        messageType: target.type,
        ...(target.type === 'group' ? { groupId: target.id } : { userId: target.id }),
        message,
        ...(context?.eventId ? { eventId: context.eventId } : {}),
      })
    }
    const flush = async () => {
      if (post.length) await deliver('post', { zh_cn: { title: '', content: [post] } }, original)
      post = []
      original = []
    }
    for (const segment of prepared) {
      if (isSegment(segment, 'reply')) {
        await flush()
        replyId = segment.data.id
        continue
      }
      if (isSegment(segment, 'text')) {
        post.push({
          tag: 'text',
          text: segment.data.text,
          ...(segment.data.style ? { style: segment.data.style } : {}),
        })
        original.push(segment)
      } else if (isSegment(segment, 'at')) {
        post.push({ tag: 'at', user_id: segment.data.id })
        original.push(segment)
      } else if (isSegment(segment, 'image')) {
        post.push({ tag: 'img', image_key: await this.media('image', segment.data.file) })
        original.push(segment)
      } else if (isSegment(segment, 'file')) {
        await flush()
        await deliver('file', { file_key: await this.media('file', segment.data.file, segment.data.name) }, [
          segment,
        ])
      } else if (isSegment(segment, 'markdown')) {
        await flush()
        await deliver('interactive', feishu.message([feishu.markdown(segment.data.content)]), [segment])
      } else if (isSegment(segment, 'button')) {
        await flush()
        const button =
          segment.data.kind === 'link'
            ? feishu.button(segment.data.label, { link: segment.data.value })
            : this.commandButton(segment.data.label, segment.data.value)
        await deliver('interactive', feishu.message([button]), [segment])
      } else if (segment.type === 'feishu:card') {
        await flush()
        await deliver('interactive', cardSchema.parse(segment.data.card), [segment])
      } else throw new UnsupportedError('feishu', segment.type)
    }
    await flush()
    if (!last) throw new UnsupportedError('feishu', '空消息')
    return last
  }

  async getSelf(): Promise<UserInfo> {
    return { userId: this.selfId, nickname: this.nickname, avatar: this.avatar }
  }
  async deleteMessage(messageId: string): Promise<void> {
    this.assertOnline()
    await this.raw('DELETE', `/im/v1/messages/${encodeURIComponent(messageId)}`)
  }

  private async pages<T>(
    path: string,
    schema: z.ZodType<T>,
    params: Record<string, string | number>,
  ): Promise<T[]> {
    const pageSchema = z.object({
      items: z.array(schema).default([]),
      has_more: z.boolean().default(false),
      page_token: z.string().optional(),
    })
    const result: T[] = []
    let token: string | undefined
    const seen = new Set<string>()
    do {
      const page = await this.data('GET', path, pageSchema, {
        params: { ...params, page_size: 100, ...(token ? { page_token: token } : {}) },
      })
      result.push(...page.items)
      if (!page.has_more) return result
      if (!page.page_token || seen.has(page.page_token))
        throw new Error('Feishu returned an invalid pagination token')
      token = page.page_token
      seen.add(token)
    } while (token)
    return result
  }

  async getGroupList(): Promise<GroupInfo[]> {
    this.assertOnline()
    return (
      await this.pages('/im/v1/chats', z.object({ chat_id: z.string(), name: z.string().default('') }), {
        user_id_type: 'open_id',
      })
    ).map((chat) => ({ groupId: chat.chat_id, groupName: chat.name }))
  }

  async getGroupMembers(groupId: string): Promise<GroupMemberInfo[]> {
    this.assertOnline()
    const path = `/im/v1/chats/${encodeURIComponent(groupId)}`
    const [members, chat] = await Promise.all([
      this.pages(`${path}/members`, memberSchema, { member_id_type: 'open_id' }),
      this.data('GET', path, chatSchema, { params: { user_id_type: 'open_id' } }),
    ])
    return members.map((member) => ({
      groupId,
      userId: member.member_id,
      nickname: member.name,
      role:
        member.member_id === chat.owner_id
          ? 'owner'
          : chat.user_manager_id_list.includes(member.member_id)
            ? 'admin'
            : 'member',
    }))
  }

  async getGroupMember(groupId: string, userId: string): Promise<GroupMemberInfo> {
    const member = (await this.getGroupMembers(groupId)).find((m) => m.userId === userId)
    if (!member) throw new Error('Feishu group member not found')
    return member
  }

  async getMessage(messageId: string): Promise<MessageInfo> {
    this.assertOnline()
    const item = z.object({
      message_id: z.string(),
      msg_type: z.string(),
      create_time: z.string(),
      chat_id: z.string(),
      sender: z.object({ id: z.string(), sender_type: z.string() }),
      body: z.object({ content: z.string() }),
    })
    const result = await this.data(
      'GET',
      `/im/v1/messages/${encodeURIComponent(messageId)}`,
      z.object({ items: z.array(item).min(1) }),
      { params: { user_id_type: 'open_id' } },
    )
    const message = result.items[0] as z.output<typeof item>
    const chat = await this.data(
      'GET',
      `/im/v1/chats/${encodeURIComponent(message.chat_id)}`,
      z.object({ chat_mode: z.enum(['group', 'p2p', 'topic']) }),
      { params: { user_id_type: 'open_id' } },
    )
    return {
      messageId: message.message_id,
      messageType: chat.chat_mode === 'p2p' ? 'private' : 'group',
      userId: message.sender.id,
      ...(chat.chat_mode === 'p2p' ? {} : { groupId: message.chat_id }),
      time: Number(message.create_time),
      message: incomingMessage(message.msg_type, message.body.content),
      sender: { userId: message.sender.id, nickname: message.sender.id },
    }
  }

  async call(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.assertOnline()
    const [method, path, extra] = action.split(' ')
    if (
      !method ||
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
      !path?.startsWith('/') ||
      path.includes('..') ||
      extra
    )
      throw new TypeError('Expected METHOD /open-api-path')
    const input = z
      .object({
        data: z.record(z.string(), z.unknown()).optional(),
        params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      })
      .strict()
      .parse(params)
    return this.raw(method, path, input)
  }

  async sendForward(_target: MessageTarget, _nodes: ForwardNode[]): Promise<SendResult> {
    throw new UnsupportedError('feishu', 'sendForward')
  }
  async getForward(_id: string): Promise<ForwardMessage[]> {
    throw new UnsupportedError('feishu', 'getForward')
  }
  async muteMember(_group: string, _user: string, _duration: number): Promise<void> {
    throw new UnsupportedError('feishu', 'muteMember')
  }
  async kickMember(_group: string, _user: string): Promise<void> {
    throw new UnsupportedError('feishu', 'kickMember')
  }
  async setMemberCard(_group: string, _user: string, _card: string): Promise<void> {
    throw new UnsupportedError('feishu', 'setMemberCard')
  }
  async getFriendList(): Promise<UserInfo[]> {
    throw new UnsupportedError('feishu', 'getFriendList')
  }
}
