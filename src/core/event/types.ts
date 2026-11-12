import type { Bot, ForwardNode, SendResult } from '../bot.ts'
import type { Message, Sendable } from '../message/index.ts'
import type { Target } from '../target.ts'

export interface PromptOptions {
  timeout?: string | number
  scope?: 'user' | 'channel'
  filter?: (session: Session) => boolean
  validate?: (reply: Session) => true | string | Promise<true | string>
  retries?: number
}

export type DialogueOptions = Pick<PromptOptions, 'timeout' | 'scope' | 'retries'>

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
  readonly target: Target
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
  confirm(text: Sendable, options?: DialogueOptions): Promise<boolean | null>
  choose(text: Sendable, choices: string[], options?: DialogueOptions): Promise<string | null>
  choose<T>(
    text: Sendable,
    choices: { label: string; value: T }[],
    options?: DialogueOptions,
  ): Promise<T | null>
  sendForward(nodes: ForwardNode[]): Promise<SendResult>
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

interface NoticeBaseEvent extends BaseEvent {
  readonly kind: 'notice'
  readonly userId?: string
  readonly groupId?: string
  readonly operatorId?: string
}

export interface MemberJoinEvent extends NoticeBaseEvent {
  readonly name: 'notice.member.join'
  readonly groupId: string
  readonly userId: string
  readonly joinType: 'approve' | 'invite' | string
}

export interface MemberLeaveEvent extends NoticeBaseEvent {
  readonly name: 'notice.member.leave'
  readonly groupId: string
  readonly userId: string
  readonly reason: 'leave' | 'kick' | string
}

export interface MemberMuteEvent extends NoticeBaseEvent {
  readonly name: 'notice.member.mute'
  readonly groupId: string
  readonly userId: string
  readonly duration: number
}

export interface MemberUnmuteEvent extends NoticeBaseEvent {
  readonly name: 'notice.member.unmute'
  readonly groupId: string
  readonly userId: string
}

export interface MemberRoleEvent extends NoticeBaseEvent {
  readonly name: 'notice.member.role'
  readonly groupId: string
  readonly userId: string
  readonly role: 'admin' | 'member'
}

export interface MessageRecallEvent extends NoticeBaseEvent {
  readonly name: 'notice.message.recall'
  readonly userId: string
  readonly messageId: string
}

export interface PokeEvent extends NoticeBaseEvent {
  readonly name: 'notice.poke'
  readonly userId: string
  readonly targetId: string
}

export interface PlatformNoticeEvent extends NoticeBaseEvent {
  readonly name: `notice.${string}.${string}`
  readonly platformType: string
  readonly subType?: string
}

export type MemberNoticeEvent =
  | MemberJoinEvent
  | MemberLeaveEvent
  | MemberMuteEvent
  | MemberUnmuteEvent
  | MemberRoleEvent

export type KnownNoticeEvent = MemberNoticeEvent | MessageRecallEvent | PokeEvent
export type NoticeEvent = KnownNoticeEvent | PlatformNoticeEvent

interface RequestBaseEvent extends BaseEvent {
  readonly kind: 'request'
  readonly userId: string
  readonly comment: string
  approve(remark?: string): Promise<void>
  reject(reason?: string): Promise<void>
}

export interface FriendRequestEvent extends RequestBaseEvent {
  readonly name: 'request.friend'
}

/** Group requests always identify their group, so per-group toggles and group access control apply to them. */
interface GroupRequestBaseEvent extends RequestBaseEvent {
  readonly groupId: string
}

export interface GroupJoinRequestEvent extends GroupRequestBaseEvent {
  readonly name: 'request.group.join'
}

export interface GroupInviteRequestEvent extends GroupRequestBaseEvent {
  readonly name: 'request.group.invite'
}

export type GroupRequestEvent = GroupJoinRequestEvent | GroupInviteRequestEvent
export type RequestEvent = FriendRequestEvent | GroupRequestEvent

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
  | NoticeEvent
  | RequestEvent
  | MetaEvent
  | BotOnlineEvent
  | BotOfflineEvent
  | MessageSentEvent

export interface KnownEventMap {
  message: Session
  'message.private': PrivateSession
  'message.group': GroupSession
  notice: NoticeEvent
  'notice.member': MemberNoticeEvent
  'notice.member.join': MemberJoinEvent
  'notice.member.leave': MemberLeaveEvent
  'notice.member.mute': MemberMuteEvent
  'notice.member.unmute': MemberUnmuteEvent
  'notice.member.role': MemberRoleEvent
  'notice.message': MessageRecallEvent
  'notice.message.recall': MessageRecallEvent
  'notice.poke': PokeEvent
  request: RequestEvent
  'request.friend': FriendRequestEvent
  'request.group': GroupRequestEvent
  'request.group.join': GroupJoinRequestEvent
  'request.group.invite': GroupInviteRequestEvent
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

export interface EventMap extends KnownEventMap {
  [name: `notice.${string}`]: NoticeEvent
}
