import type { Bot, SendResult } from '../bot.ts'
import type { Message, Sendable } from '../message/index.ts'

export interface PromptOptions {
  timeout?: string | number
  scope?: 'user' | 'channel'
  filter?: (session: Session) => boolean
}

export interface SessionServices {
  prompt(
    session: Session,
    text?: Sendable,
    options?: PromptOptions,
    signal?: AbortSignal,
  ): Promise<Session | null>
}

export interface BaseEvent {
  readonly id: string
  readonly platform: string
  readonly selfId: string
  readonly time: number
  readonly kind: 'message' | 'notice' | 'request' | 'meta' | 'internal'
  readonly name: string
  readonly raw: unknown
  readonly bot: Bot
}

export interface Session extends BaseEvent {
  readonly kind: 'message'
  readonly messageType: 'private' | 'group'
  readonly messageId: string
  readonly userId: string
  readonly groupId?: string
  readonly channelKey: string
  readonly message: Message
  readonly text: string
  readonly sender: {
    readonly userId: string
    readonly nickname: string
    readonly card?: string
    readonly role?: 'owner' | 'admin' | 'member'
  }
  readonly toMe: boolean
  readonly isSuperuser: boolean
  send(content: Sendable): Promise<SendResult>
  reply(content: Sendable, options?: { quote?: boolean; at?: boolean }): Promise<SendResult>
  prompt(text?: Sendable, options?: PromptOptions): Promise<Session | null>
}

export interface GroupSession extends Session {
  readonly name: 'message.group'
  readonly messageType: 'group'
  readonly groupId: string
}

export interface PrivateSession extends Session {
  readonly name: 'message.private'
  readonly messageType: 'private'
  readonly groupId?: undefined
}

export interface NoticeEvent extends BaseEvent {
  readonly kind: 'notice'
  readonly noticeType: string
  readonly subType?: string
  readonly userId?: string
  readonly groupId?: string
  readonly operatorId?: string
}

export interface GroupIncreaseEvent extends NoticeEvent {
  readonly name: 'notice.group_increase' | 'notice.group_increase.approve' | 'notice.group_increase.invite'
  readonly noticeType: 'group_increase'
  readonly subType: 'approve' | 'invite'
  readonly groupId: string
  readonly userId: string
  readonly operatorId: string
}

export interface GroupDecreaseEvent extends NoticeEvent {
  readonly name:
    | 'notice.group_decrease'
    | 'notice.group_decrease.leave'
    | 'notice.group_decrease.kick'
    | 'notice.group_decrease.kick_me'
  readonly noticeType: 'group_decrease'
  readonly subType: 'leave' | 'kick' | 'kick_me'
  readonly groupId: string
  readonly userId: string
  readonly operatorId: string
}

export interface GroupRecallEvent extends NoticeEvent {
  readonly name: 'notice.group_recall'
  readonly noticeType: 'group_recall'
  readonly groupId: string
  readonly userId: string
  readonly operatorId: string
  readonly messageId: string
}

export interface FriendRecallEvent extends NoticeEvent {
  readonly name: 'notice.friend_recall'
  readonly noticeType: 'friend_recall'
  readonly userId: string
  readonly messageId: string
}

export interface GroupBanEvent extends NoticeEvent {
  readonly name: 'notice.group_ban' | 'notice.group_ban.ban' | 'notice.group_ban.lift_ban'
  readonly noticeType: 'group_ban'
  readonly subType: 'ban' | 'lift_ban'
  readonly groupId: string
  readonly userId: string
  readonly operatorId: string
  readonly duration: number
}

export interface PokeEvent extends NoticeEvent {
  readonly name: 'notice.notify.poke'
  readonly noticeType: 'notify'
  readonly subType: 'poke'
  readonly groupId?: string
  readonly userId: string
  readonly targetId: string
}

export interface GroupAdminEvent extends NoticeEvent {
  readonly name: 'notice.group_admin' | 'notice.group_admin.set' | 'notice.group_admin.unset'
  readonly noticeType: 'group_admin'
  readonly subType: 'set' | 'unset'
  readonly groupId: string
  readonly userId: string
}

export type KnownNoticeEvent =
  | GroupIncreaseEvent
  | GroupDecreaseEvent
  | GroupRecallEvent
  | FriendRecallEvent
  | GroupBanEvent
  | PokeEvent
  | GroupAdminEvent

export interface RequestEvent extends BaseEvent {
  readonly kind: 'request'
  readonly requestType: 'friend' | 'group'
  readonly subType?: 'add' | 'invite'
  readonly userId: string
  readonly groupId?: string
  readonly comment: string
  readonly flag: string
  approve(remark?: string): Promise<void>
  reject(reason?: string): Promise<void>
}

export interface MetaEvent extends BaseEvent {
  readonly kind: 'meta'
  readonly metaEventType: string
  readonly status?: Record<string, unknown>
  readonly interval?: number
}

export interface BotOnlineEvent extends BaseEvent {
  readonly kind: 'internal'
  readonly name: 'bot.online'
  readonly status: 'online'
}

export interface BotOfflineEvent extends BaseEvent {
  readonly kind: 'internal'
  readonly name: 'bot.offline'
  readonly status: 'offline'
}

export interface MessageSentEvent extends BaseEvent {
  readonly kind: 'internal'
  readonly name: 'bot.message.sent'
  readonly messageId: string
  readonly messageType: 'private' | 'group'
  readonly userId?: string
  readonly groupId?: string
  readonly message: Message
}

export type AnyEvent =
  | Session
  | KnownNoticeEvent
  | NoticeEvent
  | RequestEvent
  | MetaEvent
  | BotOnlineEvent
  | BotOfflineEvent
  | MessageSentEvent

export interface EventMap {
  message: Session
  'message.private': PrivateSession
  'message.group': GroupSession
  notice: NoticeEvent
  'notice.notify': NoticeEvent
  'notice.notify.poke': PokeEvent
  'notice.group_increase': GroupIncreaseEvent
  'notice.group_increase.approve': GroupIncreaseEvent
  'notice.group_increase.invite': GroupIncreaseEvent
  'notice.group_decrease': GroupDecreaseEvent
  'notice.group_decrease.leave': GroupDecreaseEvent
  'notice.group_decrease.kick': GroupDecreaseEvent
  'notice.group_decrease.kick_me': GroupDecreaseEvent
  'notice.group_recall': GroupRecallEvent
  'notice.friend_recall': FriendRecallEvent
  'notice.group_ban': GroupBanEvent
  'notice.group_ban.ban': GroupBanEvent
  'notice.group_ban.lift_ban': GroupBanEvent
  'notice.group_admin': GroupAdminEvent
  'notice.group_admin.set': GroupAdminEvent
  'notice.group_admin.unset': GroupAdminEvent
  request: RequestEvent
  'request.friend': RequestEvent
  'request.group': RequestEvent
  'request.group.add': RequestEvent
  'request.group.invite': RequestEvent
  meta: MetaEvent
  'meta.lifecycle': MetaEvent
  'meta.heartbeat': MetaEvent
  // Things the bot itself does or undergoes. Kept out of the `message` namespace on purpose: a
  // `message` listener must only ever receive Sessions.
  bot: BotOnlineEvent | BotOfflineEvent | MessageSentEvent
  'bot.online': BotOnlineEvent
  'bot.offline': BotOfflineEvent
  'bot.message': MessageSentEvent
  'bot.message.sent': MessageSentEvent
}
