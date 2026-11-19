import { createHmac, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AdapterHost } from '../../core/adapter.ts'
import {
  type Bot,
  type ForwardMessage,
  type ForwardNode,
  type GroupInfo,
  type GroupMemberInfo,
  type MessageTarget,
  type MessageThread,
  type SendResult,
  sendTo,
  type ThreadTarget,
  type UserInfo,
} from '../../core/bot.ts'
import { DeliveryAttempt, DeliveryError } from '../../core/delivery.ts'
import { dispatchContext } from '../../core/dispatch/trace.ts'
import { NotConnectedError, UnsupportedError } from '../../core/errors.ts'
import type { Session } from '../../core/event/index.ts'
import { isSegment, type Message, normalizeSendable, type Sendable, seg } from '../../core/message/index.ts'
import { messageTargetSchema, threadSchema } from '../../core/target.ts'
import { LruSet } from '../../core/utils/lru.ts'
import { redactText } from '../../core/utils/redact.ts'
import { constantTimeEqual } from '../../core/utils/security.ts'
import {
  chatMode,
  chatPath,
  chatRolesSchema,
  classifyFeishuSend,
  type FeishuApi,
  FeishuClient,
  feishuOperations,
  idSchema,
  messagePath,
} from './api.ts'
import { cardSchema, type FeishuElement, feishu } from './cards.ts'
import type { FeishuConfig } from './config.ts'
import {
  decodeMessageResource,
  type FeishuMessageInfo,
  messageResource,
  readMedia,
  threadFields,
  threadOf,
} from './message.ts'
import type { FeishuTransport, FeishuUploadKind } from './transport.ts'

export interface FeishuBot extends Bot {
  readonly feishu: FeishuApi
  sendThread(target: ThreadTarget, content: Sendable): Promise<SendResult>
  getMessage(messageId: string): Promise<FeishuMessageInfo>
}
export function isFeishu(bot: Bot): bot is FeishuBot {
  return bot.platform === 'feishu' && 'feishu' in bot
}

const sentSchema = threadFields
const forwardedSchema = sentSchema.extend({
  msg_type: z.string().optional(),
  invalid_message_id_list: z.array(idSchema).default([]),
})
const threadTargetSchema = messageTargetSchema.extend({ thread: threadSchema })
const threadSendResult = z.object({ messageId: idSchema, thread: threadSchema })
const segmentSchema = z.object({ type: z.string().min(1), data: z.record(z.string(), z.unknown()) })
const sendableSchema = z.union([z.string(), segmentSchema, z.array(segmentSchema)])
const forwardMessageArgs = z.tuple([idSchema, messageTargetSchema])
type Conversation =
  | { messageType: 'private'; groupId?: undefined; thread?: MessageThread }
  | { messageType: 'group'; groupId: string; thread?: MessageThread }
const memberSchema = z.object({ member_id: z.string(), name: z.string().default('') })
export const feishuCapabilities = {
  segments: [
    'text',
    'at',
    'reply',
    'image',
    'audio',
    'video',
    'file',
    'markdown',
    'button',
    'feishu:card',
    'feishu:sticker',
    'feishu:emoji',
    'feishu:share_chat',
    'feishu:share_user',
  ],
  textStyles: ['bold', 'italic', 'underline', 'strike', 'code'] as const,
  actions: [
    'sendPrivate',
    'sendGroup',
    'sendThread',
    'getSelf',
    'getGroupList',
    'getGroupMember',
    'getGroupMembers',
    'getMessage',
    'getForward',
    'kickMember',
    'deleteMessage',
    'call',
    'feishu.sendCard',
    'feishu.updateCard',
    'feishu.downloadResource',
    'feishu.replyInThread',
    'feishu.listMessages',
    'feishu.forwardMessage',
    'feishu.forwardThread',
    'feishu.mergeForward',
    'feishu.editMessage',
    'feishu.addReaction',
    'feishu.removeReaction',
    'feishu.listReactions',
    'feishu.pinMessage',
    'feishu.unpinMessage',
    'feishu.listPins',
    'feishu.listReadUsers',
    'feishu.getChat',
    'feishu.setChatMessageMode',
    'feishu.addChatMembers',
    'feishu.urgentApp',
  ],
}

export class FeishuBotImpl implements FeishuBot {
  readonly platform = 'feishu'
  readonly capabilities = feishuCapabilities
  status: Bot['status'] = 'connecting'
  readonly selfId: string
  readonly nickname: string
  readonly avatar?: string
  readonly feishu: FeishuApi
  readonly sentMessageIds = new LruSet<string>(1000)
  readonly shutdown = new AbortController()
  private readonly host: AdapterHost
  private readonly client: FeishuClient
  private readonly config: FeishuConfig
  private readonly buttonSecret: string
  private readonly roles = new Map<
    string,
    { expires: number; value: Promise<z.output<typeof chatRolesSchema> | undefined> }
  >()
  private readonly conversations = new Map<string, Conversation>()

  constructor(
    host: AdapterHost,
    transport: FeishuTransport,
    self: UserInfo,
    config: FeishuConfig,
    buttonSecret: string,
  ) {
    this.host = host
    this.client = new FeishuClient(host, this, transport, config)
    this.selfId = self.userId
    this.nickname = self.nickname
    this.avatar = self.avatar
    this.config = config
    this.buttonSecret = buttonSecret
    this.feishu = {
      sendCard: (target, card) => sendTo(this, target, feishu.card(card)),
      ...feishuOperations(
        this.client,
        async (chatId) => (await this.resolveChannel(chatId)).messageType,
        (chatId) => this.invalidateChat(chatId),
      ),
      replyInThread: async (target, messageId, content) =>
        threadSendResult.parse(
          await this.client.invokeSend(
            target,
            'replyInThread',
            [target, messageId, content],
            async (args) => {
              const [destination, root, message] = z
                .tuple([messageTargetSchema, idSchema, sendableSchema])
                .parse(args)
              if (destination.thread) {
                if (destination.thread.rootMessageId !== root)
                  throw new DeliveryError(
                    { ...destination, platform: this.platform, selfId: this.selfId },
                    { code: 'CONVERSATION_UNAVAILABLE', message: '指定的消息不是目标话题的根消息' },
                  )
                return this.send(destination, message)
              }
              return this.send(destination, message, root)
            },
          ),
        ),
      forwardMessage: (messageId, target) =>
        this.client.invokeSend(target, 'forwardMessage', [messageId, target], async (args) => {
          const [id, destination] = forwardMessageArgs.parse(args)
          return (await this.forward(`${messagePath(id)}/forward`, destination, false)).sent
        }),
      forwardThread: (threadId, target) =>
        this.client.invokeSend(target, 'forwardThread', [threadId, target], async (args) => {
          const [id, destination] = forwardMessageArgs.parse(args)
          return (await this.forward(`/im/v1/threads/${encodeURIComponent(id)}/forward`, destination, true))
            .sent
        }),
      mergeForward: (messageIds, target) =>
        this.client.invokeSend(target, 'mergeForward', [messageIds, target], async (args) => {
          const [ids, destination] = z
            .tuple([z.array(idSchema).min(1).max(100), messageTargetSchema])
            .parse(args)
          const { sent, invalidMessageIds } = await this.forward(
            '/im/v1/messages/merge_forward',
            destination,
            true,
            { message_id_list: ids },
          )
          return { ...sent, invalidMessageIds }
        }),
      commandButton: (label, command) => this.commandButton(label, command),
      updateCard: (messageId, card) =>
        this.client.invoke('updateCard', [messageId, card], async (args) => {
          const [id, value] = z.tuple([idSchema, cardSchema]).parse(args)
          await this.client.raw('PATCH', messagePath(id), { data: { content: JSON.stringify(value) } })
        }),
      downloadResource: async (messageId, key, type) =>
        z.instanceof(Buffer).parse(
          await this.client.invoke('downloadResource', [messageId, key, type], (args) => {
            const [id, fileKey, kind] = z.tuple([idSchema, idSchema, z.enum(['image', 'file'])]).parse(args)
            return this.client.download(id, fileKey, kind)
          }),
        ),
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
        await this.client.data('GET', chatPath(chatId), z.object({ chat_mode: chatMode }), {
          params: { user_id_type: 'open_id' },
        })
      ).chat_mode
    return mode === 'p2p' ? { messageType: 'private' } : { messageType: 'group', groupId: chatId }
  }

  rememberConversation(messageId: string, target: MessageTarget, thread = target.thread): void {
    this.cacheConversation(
      messageId,
      target.type === 'group'
        ? { messageType: 'group', groupId: target.id, thread }
        : { messageType: 'private', thread },
    )
  }

  private cacheConversation(messageId: string, conversation: Conversation): void {
    this.conversations.delete(messageId)
    this.conversations.set(messageId, conversation)
    if (this.conversations.size > 1000) {
      const oldest = this.conversations.keys().next()
      if (!oldest.done) this.conversations.delete(oldest.value)
    }
  }

  knownConversation(messageId: string): Conversation | undefined {
    return this.conversations.get(messageId)
  }

  async resolveConversation(messageId: string): Promise<Conversation> {
    const known = this.conversations.get(messageId)
    if (known) return known
    const message = await this.getMessageResource(messageId)
    const conversation = { ...(await this.resolveChannel(message.chat_id)), thread: threadOf(message) }
    this.cacheConversation(messageId, conversation)
    return conversation
  }

  private assertOnline(): void {
    if (this.status !== 'online') throw new NotConnectedError()
  }

  async resolveSender(userId: string, groupId?: string): Promise<Session['sender']> {
    const sender = { userId, nickname: userId }
    if (!groupId) return sender
    let cached = this.roles.get(groupId)
    if (!cached || cached.expires < Date.now()) {
      const value = this.client
        .data('GET', chatPath(groupId), chatRolesSchema, {
          params: { user_id_type: 'open_id' },
        })
        .catch((error: unknown) => {
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

  invalidateChat(chatId: string): void {
    this.roles.delete(chatId)
  }

  sendPrivate(userId: string, content: Sendable): Promise<SendResult> {
    return this.send({ type: 'private', id: userId }, content)
  }
  sendGroup(groupId: string, content: Sendable): Promise<SendResult> {
    return this.send({ type: 'group', id: groupId }, content)
  }
  sendThread(target: ThreadTarget, content: Sendable): Promise<SendResult> {
    return new DeliveryAttempt(this, target).run(() => this.send(threadTargetSchema.parse(target), content))
  }

  private async media(type: FeishuUploadKind, source: string, name = 'file'): Promise<string> {
    const bytes = await readMedia(
      source,
      Math.min(this.config.mediaMaxBytes, type === 'image' ? 10 * 1024 * 1024 : 30 * 1024 * 1024),
      this.config.apiTimeout,
      this.shutdown.signal,
    )
    if (bytes === undefined) return source
    return this.client.upload(type, bytes, name)
  }

  private send(target: MessageTarget, content: Sendable, openThreadAt?: string): Promise<SendResult> {
    const attempt = new DeliveryAttempt(this, target)
    return attempt.run(() => this.deliver(attempt, target, content, openThreadAt))
  }

  private async deliver(
    attempt: DeliveryAttempt,
    target: MessageTarget,
    content: Sendable,
    openThreadAt?: string,
  ): Promise<SendResult> {
    this.assertOnline()
    const prepared = await this.host.prepareOutgoing({
      bot: this,
      target,
      message: normalizeSendable(content),
      ...(openThreadAt
        ? { sendFirst: (part: Sendable) => this.feishu.replyInThread(target, openThreadAt, part) }
        : {}),
    })
    if (!Array.isArray(prepared)) return prepared.sent
    let replyId: string | undefined
    let thread = target.thread
    let post: Record<string, unknown>[] = []
    let original: Message = []
    let last: SendResult | undefined
    const deliver = async (type: string, body: Record<string, unknown>, message: Message) => {
      this.assertOnline()
      const reference = thread?.rootMessageId ?? openThreadAt ?? replyId
      const request = new DeliveryAttempt(this, { ...target, thread })
      const response = await request.request(
        () =>
          this.client.data(
            'POST',
            reference ? `${messagePath(reference)}/reply` : '/im/v1/messages',
            sentSchema,
            {
              ...(reference
                ? {}
                : { params: { receive_id_type: target.type === 'group' ? 'chat_id' : 'open_id' } }),
              data: {
                ...(reference ? {} : { receive_id: target.id }),
                ...(reference && (thread || openThreadAt) ? { reply_in_thread: true } : {}),
                msg_type: type,
                content: JSON.stringify(body),
                uuid: randomUUID(),
              },
            },
          ),
        classifyFeishuSend,
      )
      const deliveredThread = this.sentThread(response, thread, openThreadAt)
      thread = deliveredThread
      last = attempt.confirm(this.recordSent(target, response, message, deliveredThread))
      if (openThreadAt && !thread)
        throw new DeliveryError(attempt.target, {
          code: 'DELIVERY_UNCONFIRMED',
          message: '消息已发送，但飞书没有返回新话题的 ID',
        })
    }
    const flush = async () => {
      const text = post.length === 1 ? post[0] : undefined
      if (text?.tag === 'text' && !text.style) await deliver('text', { text: text.text }, original)
      else if (post.length) await deliver('post', { zh_cn: { title: '', content: [post] } }, original)
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
      } else if (isSegment(segment, 'audio') || isSegment(segment, 'video')) {
        await flush()
        const type = segment.type
        await deliver(
          type === 'audio' ? 'audio' : 'media',
          {
            file_key: await this.media(
              type,
              segment.data.file,
              type === 'audio' ? 'audio.opus' : 'video.mp4',
            ),
          },
          [segment],
        )
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
      } else if (segment.type === 'feishu:emoji') {
        post.push({ tag: 'emotion', emoji_type: z.string().min(1).parse(segment.data.emoji_type) })
        original.push(segment)
      } else if (segment.type === 'feishu:sticker') {
        await flush()
        await deliver('sticker', z.object({ file_key: z.string().min(1) }).parse(segment.data), [segment])
      } else if (segment.type === 'feishu:share_chat') {
        await flush()
        await deliver('share_chat', z.object({ chat_id: z.string().min(1) }).parse(segment.data), [segment])
      } else if (segment.type === 'feishu:share_user') {
        await flush()
        await deliver('share_user', z.object({ user_id: z.string().min(1) }).parse(segment.data), [segment])
      } else throw new UnsupportedError('feishu', segment.type)
    }
    await flush()
    if (!last) throw new UnsupportedError('feishu', '空消息')
    return last
  }

  private sentThread(
    response: z.output<typeof sentSchema>,
    known?: MessageThread,
    root?: string,
  ): MessageThread | undefined {
    return (
      threadOf({
        ...response,
        root_id: response.root_id || response.parent_id || known?.rootMessageId || root,
      }) ?? known
    )
  }

  private recordSent(
    target: MessageTarget,
    response: z.output<typeof sentSchema>,
    message: Message,
    thread: MessageThread | undefined,
  ): SendResult {
    const messageId = response.message_id
    this.sentMessageIds.add(messageId)
    this.rememberConversation(messageId, { ...target, thread })
    const context = dispatchContext.getStore()
    const fields = {
      platform: this.platform,
      selfId: this.selfId,
      messageId,
      messageType: target.type,
      ...(target.type === 'group' ? { groupId: target.id } : { userId: target.id }),
      ...(context?.active.value ? { eventId: context.eventId } : {}),
    }
    this.host.logger.info({ ...fields, ...(thread ? { threadId: thread.id } : {}) }, 'Feishu message sent')
    this.host.emit({
      ...fields,
      id: randomUUID(),
      time: Date.now(),
      kind: 'internal',
      name: 'bot.message.sent',
      raw: response,
      bot: this,
      ...(thread ? { thread } : {}),
      message,
    })
    return { messageId, ...(thread ? { thread } : {}) }
  }

  private async forward(
    path: string,
    target: MessageTarget,
    merged: boolean,
    data: Record<string, unknown> = {},
  ) {
    const response = await new DeliveryAttempt(this, target).request(
      () =>
        this.client.data('POST', path, forwardedSchema, {
          params: {
            receive_id_type: target.thread ? 'thread_id' : target.type === 'group' ? 'chat_id' : 'open_id',
          },
          data: { ...data, receive_id: target.thread?.id ?? target.id, uuid: randomUUID() },
        }),
      classifyFeishuSend,
    )
    const message =
      merged || response.msg_type === 'merge_forward'
        ? seg.forward(response.message_id)
        : seg.text('[转发消息]')
    const sent = this.recordSent(target, response, [message], this.sentThread(response, target.thread))
    return { sent, invalidMessageIds: response.invalid_message_id_list }
  }

  async getSelf(): Promise<UserInfo> {
    return { userId: this.selfId, nickname: this.nickname, avatar: this.avatar }
  }
  async deleteMessage(messageId: string): Promise<void> {
    this.assertOnline()
    await this.client.raw('DELETE', messagePath(messageId))
  }

  async getGroupList(): Promise<GroupInfo[]> {
    this.assertOnline()
    return (
      await this.client.allPages(
        '/im/v1/chats',
        z.object({ chat_id: z.string(), name: z.string().default('') }),
        {
          user_id_type: 'open_id',
        },
      )
    ).map((chat) => ({ groupId: chat.chat_id, groupName: chat.name }))
  }

  async getGroupMembers(groupId: string): Promise<GroupMemberInfo[]> {
    this.assertOnline()
    const path = chatPath(groupId)
    const [members, chat] = await Promise.all([
      this.client.allPages(`${path}/members`, memberSchema, { member_id_type: 'open_id' }),
      this.client.data('GET', path, chatRolesSchema, { params: { user_id_type: 'open_id' } }),
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

  async getMessage(messageId: string): Promise<FeishuMessageInfo> {
    this.assertOnline()
    const message = await this.getMessageResource(messageId)
    const channel = await this.resolveChannel(message.chat_id)
    return decodeMessageResource(message, channel.messageType)
  }

  async getMessageResource(messageId: string): Promise<z.output<typeof messageResource>> {
    const items = await this.getMessageResources(messageId)
    const message = items.find((item) => item.message_id === messageId)
    if (!message) throw new Error('Feishu message not found')
    return message
  }

  private async getMessageResources(messageId: string): Promise<z.output<typeof messageResource>[]> {
    const { items } = await this.client.data(
      'GET',
      messagePath(messageId),
      z.object({ items: z.array(messageResource) }),
      { params: { user_id_type: 'open_id' } },
    )
    return items
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
    return this.client.raw(method, path, input)
  }

  async sendForward(_target: MessageTarget, _nodes: ForwardNode[]): Promise<SendResult> {
    throw new UnsupportedError('feishu', 'sendForward')
  }
  async getForward(id: string): Promise<ForwardMessage[]> {
    this.assertOnline()
    const items = await this.getMessageResources(id)
    const root = items.find((item) => item.message_id === id && item.msg_type === 'merge_forward')
    if (!root || root.deleted) throw new Error('Feishu merged message is unavailable')
    const channel = await this.resolveChannel(root.chat_id)
    return items
      .filter((item) => item.upper_message_id === id && !item.deleted)
      .map((item) => {
        const { userId, sender, time, message } = decodeMessageResource(item, channel.messageType)
        return { userId, nickname: sender.nickname, time, message }
      })
  }
  async muteMember(_group: string, _user: string, _duration: number): Promise<void> {
    throw new UnsupportedError('feishu', 'muteMember')
  }
  async kickMember(groupId: string, userId: string, options?: { rejectRequest?: boolean }): Promise<void> {
    this.assertOnline()
    if (options?.rejectRequest) throw new UnsupportedError('feishu', 'kickMember.rejectRequest')
    const result = await this.client.data(
      'DELETE',
      `${chatPath(groupId)}/members`,
      z.object({ invalid_id_list: z.array(z.string()).default([]) }),
      {
        params: { member_id_type: 'open_id' },
        data: { id_list: [userId] },
      },
    )
    if (result.invalid_id_list.length) throw new Error('Feishu could not remove the requested member')
  }
  async setMemberCard(_group: string, _user: string, _card: string): Promise<void> {
    throw new UnsupportedError('feishu', 'setMemberCard')
  }
  async getFriendList(): Promise<UserInfo[]> {
    throw new UnsupportedError('feishu', 'getFriendList')
  }
}
