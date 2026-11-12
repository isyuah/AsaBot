import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { App } from '../core/app.ts'
import type { Bot, GroupInfo, GroupMemberInfo, SendResult, UserInfo } from '../core/bot.ts'
import { createSession } from '../core/event/index.ts'
import type { Message, Sendable } from '../core/message/index.ts'
import { normalizeSendable, plainText, seg } from '../core/message/index.ts'
import type { playgroundSchema } from './schemas.ts'

interface Reply {
  message: Message
  text: string
}

class PlaygroundBot implements Bot {
  readonly platform = 'playground'
  readonly selfId = 'playground'
  readonly status = 'online'
  replies: Reply[] | undefined
  private readonly app: App
  private nextId = 0

  constructor(app: App) {
    this.app = app
  }

  async sendPrivate(userId: string, content: Sendable): Promise<SendResult> {
    return this.send('private', userId, content)
  }

  async sendGroup(groupId: string, content: Sendable): Promise<SendResult> {
    return this.send('group', groupId, content)
  }

  async deleteMessage(_messageId: string): Promise<void> {
    throw new Error('调试台不支持该操作')
  }
  async getSelf(): Promise<UserInfo> {
    throw new Error('调试台不支持该操作')
  }
  async getGroupList(): Promise<GroupInfo[]> {
    throw new Error('调试台不支持该操作')
  }
  async getGroupMember(_groupId: string, _userId: string): Promise<GroupMemberInfo> {
    throw new Error('调试台不支持该操作')
  }
  async getFriendList(): Promise<UserInfo[]> {
    throw new Error('调试台不支持该操作')
  }
  async call(_action: string, _params?: Record<string, unknown>): Promise<unknown> {
    throw new Error('调试台不支持该操作')
  }

  private send(type: 'private' | 'group', target: string, content: Sendable): SendResult {
    const message = normalizeSendable(content)
    this.replies?.push({ message, text: plainText(message) })
    const messageId = String(++this.nextId)
    this.app.emit({
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
}

export class Playground {
  private readonly app: App
  private readonly bot: PlaygroundBot
  private queue: Promise<void> = Promise.resolve()

  constructor(app: App) {
    this.app = app
    this.bot = new PlaygroundBot(app)
  }

  run(input: z.output<typeof playgroundSchema>): Promise<{ replies: Reply[] }> {
    const work = this.queue.then(async () => {
      const replies: Reply[] = []
      this.bot.replies = replies
      try {
        const message = input.message ?? [seg.text(input.text ?? '')]
        const id = randomUUID()
        const session = createSession(
          {
            id,
            platform: 'playground',
            selfId: 'playground',
            time: Date.now(),
            raw: undefined,
            bot: this.bot,
            messageId: id,
            userId: input.user.id,
            message,
            sender: {
              userId: input.user.id,
              nickname: input.user.nickname ?? input.user.id,
              role: input.user.role,
            },
            isSuperuser: input.user.superuser ?? false,
            ...(input.group == null
              ? { messageType: 'private' as const }
              : { messageType: 'group' as const, groupId: input.group }),
          },
          this.app.sessionServices,
        )
        void this.app.dispatcher.dispatch(session).catch(() => {
          this.app.logger.error('Playground dispatch failed')
        })
        await this.app.whenIdle()
        return { replies }
      } finally {
        this.bot.replies = undefined
      }
    })
    this.queue = work.then(
      () => {},
      () => {},
    )
    return work
  }
}
