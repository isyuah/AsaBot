import { randomUUID } from 'node:crypto'
import type { Adapter, AdapterHost } from '../../core/adapter.ts'
import type { Bot, GroupInfo, GroupMemberInfo, SendResult, UserInfo } from '../../core/bot.ts'
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
  readonly sentMessageIds = new LruSet<string>(1000)
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

  private send(type: 'private' | 'group', target: string, content: Sendable): SendResult {
    const message = normalizeSendable(content)
    const messageId = String(this.sends.length + 1)
    this.sends.push({ type, target, message, messageId })
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

  async deleteMessage(_messageId: string): Promise<void> {
    throw new Error('虚拟适配器不支持该操作')
  }
  async getSelf(): Promise<UserInfo> {
    throw new Error('虚拟适配器不支持该操作')
  }
  async getGroupList(): Promise<GroupInfo[]> {
    throw new Error('虚拟适配器不支持该操作')
  }
  async getGroupMember(_groupId: string, _userId: string): Promise<GroupMemberInfo> {
    throw new Error('虚拟适配器不支持该操作')
  }
  async getFriendList(): Promise<UserInfo[]> {
    throw new Error('虚拟适配器不支持该操作')
  }
  async call(_action: string, _params?: Record<string, unknown>): Promise<unknown> {
    throw new Error('虚拟适配器不支持该操作')
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
