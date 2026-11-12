import { randomUUID } from 'node:crypto'
import type { Adapter, AdapterHost } from '../../core/adapter.ts'
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
import { UnsupportedError } from '../../core/errors.ts'
import type { BaseEvent, NoticeEvent } from '../../core/event/index.ts'
import { createSession } from '../../core/event/index.ts'
import type { Message, Sendable } from '../../core/message/index.ts'
import { normalizeSendable, seg } from '../../core/message/index.ts'
import { LruSet } from '../../core/utils/lru.ts'

export interface VirtualSend {
  type: 'private' | 'group'
  target: string
  message: Message
  messageId: string
}

export interface VirtualMessageOptions {
  user: string
  nickname?: string
  group?: string | null
  role?: 'owner' | 'admin' | 'member'
  superuser?: boolean
}

type VirtualNoticeInput<T extends NoticeEvent = NoticeEvent> = T extends NoticeEvent
  ? Omit<T, keyof BaseEvent> & Pick<T, 'name'>
  : never

export class VirtualBot implements Bot {
  readonly platform = 'virtual'
  readonly selfId: string
  readonly nickname = 'VirtualBot'
  status: Bot['status'] = 'online'
  readonly sends: VirtualSend[] = []
  readonly actions: { action: string; params: Record<string, unknown> }[] = []
  readonly sentMessageIds = new LruSet<string>(1000)
  private readonly messages = new Map<string, MessageInfo>()
  private readonly forwards = new Map<string, ForwardMessage[]>()
  private readonly host: AdapterHost

  constructor(host: AdapterHost, selfId: string) {
    this.host = host
    this.selfId = selfId
  }

  async sendPrivate(userId: string, content: Sendable): Promise<SendResult> {
    return this.send('private', userId, content)
  }

  async sendGroup(groupId: string, content: Sendable): Promise<SendResult> {
    return this.send('group', groupId, content)
  }

  private async send(type: 'private' | 'group', target: string, content: Sendable): Promise<SendResult> {
    const message = await this.host.prepareOutgoing({
      bot: this,
      target: { type, id: target },
      message: normalizeSendable(content),
    })
    return this.record(type, target, message)
  }

  private record(type: 'private' | 'group', target: string, message: Message): SendResult {
    const messageId = String(this.sends.length + 1)
    this.sends.push({ type, target, message, messageId })
    this.messages.set(messageId, {
      messageId,
      messageType: type,
      userId: this.selfId,
      ...(type === 'group' ? { groupId: target } : {}),
      time: Date.now(),
      message,
      sender: { userId: this.selfId, nickname: this.nickname },
    })
    this.sentMessageIds.add(messageId)
    this.host.emit({
      id: randomUUID(),
      platform: this.platform,
      selfId: this.selfId,
      time: Date.now(),
      kind: 'internal',
      name: 'bot.message.sent',
      raw: undefined,
      bot: this,
      messageId,
      messageType: type,
      ...(type === 'group' ? { groupId: target } : { userId: target }),
      message,
    })
    return { messageId }
  }

  rememberMessage(message: MessageInfo): void {
    this.messages.set(message.messageId, message)
  }

  async getMessage(messageId: string): Promise<MessageInfo> {
    const message = this.messages.get(messageId)
    if (!message) throw new Error(`Message ${messageId} not found`)
    return message
  }

  async sendForward(target: MessageTarget, nodes: ForwardNode[]): Promise<SendResult> {
    const messages: ForwardMessage[] = []
    for (const node of nodes) {
      const message = await this.host.prepareOutgoing({
        bot: this,
        target,
        message: normalizeSendable(node.message),
      })
      messages.push({ userId: node.userId, nickname: node.nickname, message })
    }
    const result = this.record(target.type, target.id, [seg.forward(String(this.sends.length + 1))])
    this.forwards.set(result.messageId, messages)
    return result
  }

  async getForward(id: string): Promise<ForwardMessage[]> {
    const messages = this.forwards.get(id)
    if (!messages) throw new Error(`Forward ${id} not found`)
    return messages
  }

  async getGroupMembers(groupId: string): Promise<GroupMemberInfo[]> {
    this.actions.push({ action: 'getGroupMembers', params: { groupId } })
    return []
  }
  async muteMember(groupId: string, userId: string, duration: number): Promise<void> {
    this.actions.push({ action: 'muteMember', params: { groupId, userId, duration } })
  }
  async kickMember(groupId: string, userId: string, options?: { rejectRequest?: boolean }): Promise<void> {
    this.actions.push({
      action: 'kickMember',
      params: { groupId, userId, ...(options === undefined ? {} : { options }) },
    })
  }
  async setMemberCard(groupId: string, userId: string, card: string): Promise<void> {
    this.actions.push({ action: 'setMemberCard', params: { groupId, userId, card } })
  }

  async deleteMessage(_messageId: string): Promise<void> {
    throw new UnsupportedError(this.platform, 'deleteMessage')
  }
  async getSelf(): Promise<UserInfo> {
    throw new UnsupportedError(this.platform, 'getSelf')
  }
  async getGroupList(): Promise<GroupInfo[]> {
    throw new UnsupportedError(this.platform, 'getGroupList')
  }
  async getGroupMember(_groupId: string, _userId: string): Promise<GroupMemberInfo> {
    throw new UnsupportedError(this.platform, 'getGroupMember')
  }
  async getFriendList(): Promise<UserInfo[]> {
    throw new UnsupportedError(this.platform, 'getFriendList')
  }
  async call(_action: string, _params?: Record<string, unknown>): Promise<unknown> {
    throw new UnsupportedError(this.platform, 'call')
  }
}

export class VirtualAdapter implements Adapter {
  readonly platform = 'virtual'
  readonly bot: VirtualBot
  private readonly host: AdapterHost
  private queue: Promise<void> = Promise.resolve()

  constructor(host: AdapterHost, options: { selfId?: string } = {}) {
    this.host = host
    this.bot = new VirtualBot(host, options.selfId ?? '10000')
  }

  async start(): Promise<void> {
    this.bot.status = 'online'
    this.host.registerBot(this.bot)
    this.host.setBotInfo(this.bot, { connection: '虚拟' })
    this.host.emit({
      id: randomUUID(),
      platform: this.platform,
      selfId: this.bot.selfId,
      time: Date.now(),
      kind: 'internal',
      name: 'bot.online',
      raw: undefined,
      bot: this.bot,
      status: 'online',
    })
  }

  async stop(): Promise<void> {
    this.bot.status = 'offline'
    this.host.unregisterBot(this.bot)
  }

  async reconfigure(_config: unknown): Promise<void> {}

  receive(content: string | Message, options: VirtualMessageOptions): Promise<VirtualSend[]> {
    const work = this.queue.then(async () => {
      const start = this.bot.sends.length
      const id = randomUUID()
      const session = createSession(
        {
          id,
          platform: this.platform,
          selfId: this.bot.selfId,
          time: Date.now(),
          raw: undefined,
          bot: this.bot,
          messageId: id,
          userId: options.user,
          message: typeof content === 'string' ? [seg.text(content)] : content,
          sender: { userId: options.user, nickname: options.nickname ?? options.user, role: options.role },
          isSuperuser: options.superuser ?? this.host.isSuperuser(options.user),
          sentMessageIds: this.bot.sentMessageIds,
          ...(options.group == null
            ? { messageType: 'private' as const }
            : { messageType: 'group' as const, groupId: options.group }),
        },
        this.host.sessionServices,
      )
      this.bot.rememberMessage({
        messageId: session.messageId,
        messageType: session.messageType,
        userId: session.userId,
        ...(session.groupId === undefined ? {} : { groupId: session.groupId }),
        time: session.time,
        message: session.message,
        sender: session.sender,
      })
      this.host.emit(session)
      await this.host.whenIdle()
      return this.bot.sends.slice(start)
    })
    this.queue = work.then(
      () => undefined,
      (error: unknown) => {
        this.host.logger.debug({ err: error }, 'Virtual dispatch failed')
      },
    )
    return work
  }

  async emitNotice(input: VirtualNoticeInput): Promise<void> {
    this.host.emit({
      ...input,
      id: randomUUID(),
      platform: this.platform,
      selfId: this.bot.selfId,
      time: Date.now(),
      raw: undefined,
      bot: this.bot,
      kind: 'notice',
    })
    await this.host.whenIdle()
  }
}
