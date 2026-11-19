import type { Bot, ForwardNode, MessageThread, SendResult } from '../bot.ts'
import type { DispatchTrace } from '../dispatch/trace.ts'
import type { Message, Sendable } from '../message/index.ts'
import type { Target } from '../target.ts'

/** 对话等待的超时、范围、过滤、校验和重试设置。 */
export interface PromptOptions {
  timeout?: string | number
  scope?: 'user' | 'channel'
  filter?: (session: Session) => boolean
  validate?: (reply: Session) => true | string | Promise<true | string>
  retries?: number
}

/** 确认和选择对话的超时、范围与重试设置。 */
export type DialogueOptions = Pick<PromptOptions, 'timeout' | 'scope' | 'retries'>

/** 供 Session 使用的对话等待服务。 */
export interface SessionServices {
  prompt(
    session: Session,
    text?: Sendable,
    options?: PromptOptions,
    signal?: AbortSignal,
  ): Promise<Session | null>
}

/** 平台事件的公共标识、时间、原始数据和机器人。 */
export interface BaseEvent {
  /** 框架生成的事件唯一 ID。 */
  readonly id: string
  /** 事件来源平台。 */
  readonly platform: string
  /** 接收事件的机器人账号 ID。 */
  readonly selfId: string
  /** 事件时间，单位为 Unix 毫秒。 */
  readonly time: number
  /** 事件的大类。 */
  readonly kind: 'message' | 'notice' | 'request' | 'meta' | 'internal'
  /** 可按层级订阅的事件名称。 */
  readonly name: string
  /** 平台原始事件数据。 */
  readonly raw: unknown
  /** 接收事件的机器人。 */
  readonly bot: Bot
}

/** 一次消息事件及当前会话的回复、多轮对话能力。 */
export interface Session extends BaseEvent {
  /** 消息事件的固定类型。 */
  readonly kind: 'message'
  /** 消息来自私聊或群聊。 */
  readonly messageType: 'private' | 'group'
  /** 平台消息 ID。 */
  readonly messageId: string
  /** 发送者的平台用户 ID。 */
  readonly userId: string
  /** 群消息的群 ID；私聊中不存在。 */
  readonly groupId?: string
  /** 消息所属话题；群 ID 仍然指向所在群。 */
  readonly thread?: MessageThread
  /** 包含平台、机器人账号、会话类型和 ID 的目标字符串。 */
  readonly channelKey: string
  /** 可用于主动发送的当前会话目标。 */
  readonly target: Target
  /** 原始的中立消息段列表。 */
  readonly message: Message
  /** 消息中所有纯文本段拼接的结果。 */
  readonly text: string
  /** 发送者的 ID、昵称及可用的群名片和角色。 */
  readonly sender: {
    readonly userId: string
    readonly nickname: string
    readonly card?: string
    readonly role?: 'owner' | 'admin' | 'member'
  }
  /** 私聊、提及当前机器人或回复其最近发送的消息时为 true。 */
  readonly toMe: boolean
  /** 发送者是否为配置的超管。 */
  readonly isSuperuser: boolean
  readonly isBotAdmin: boolean
  /** 向当前会话发送内容；发送失败时 Promise 拒绝。 */
  send(content: Sendable): Promise<SendResult>
  /** 回复当前消息；默认引用原消息，at 为 true 时在群内提及发送者。 */
  reply(content: Sendable, options?: { quote?: boolean; at?: boolean }): Promise<SendResult>
  /** 发送提示并等待回复；超时、被新等待替换或校验重试用尽时返回 null，有校验时输入取消也返回 null。中止或发送失败时拒绝。 */
  prompt(text?: Sendable, options?: PromptOptions): Promise<Session | null>
  /** 等待是或否的回答；超时、取消或重试用尽时返回 null。 */
  confirm(text: Sendable, options?: DialogueOptions): Promise<boolean | null>
  /** 显示编号选项并返回选中的字符串；超时、取消或重试用尽时返回 null。 */
  choose(text: Sendable, choices: string[], options?: DialogueOptions): Promise<string | null>
  /** 显示带值的编号选项并返回选中的 value；超时、取消或重试用尽时返回 null。 */
  choose<T>(
    text: Sendable,
    choices: { label: string; value: T }[],
    options?: DialogueOptions,
  ): Promise<T | null>
  /** 向当前会话发送合并转发；平台不支持或发送失败时 Promise 拒绝。 */
  sendForward(nodes: ForwardNode[]): Promise<SendResult>
}

/** 带必需群 ID 的群消息 Session。 */
export interface GroupSession extends Session {
  readonly name: 'message.group'
  readonly messageType: 'group'
  readonly groupId: string
}

/** 没有群 ID 的私聊 Session。 */
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

/** 成员加入群的通知事件。 */
export interface MemberJoinEvent extends NoticeBaseEvent {
  readonly name: 'notice.member.join'
  readonly groupId: string
  readonly userId: string
  readonly joinType: 'approve' | 'invite' | string
}

/** 成员离开或被移出群的通知事件。 */
export interface MemberLeaveEvent extends NoticeBaseEvent {
  readonly name: 'notice.member.leave'
  readonly groupId: string
  readonly userId: string
  readonly reason: 'leave' | 'kick' | string
}

/** 群成员被禁言的通知事件，duration 单位为毫秒。 */
export interface MemberMuteEvent extends NoticeBaseEvent {
  readonly name: 'notice.member.mute'
  readonly groupId: string
  readonly userId: string
  readonly duration: number
}

/** 群成员解除禁言的通知事件。 */
export interface MemberUnmuteEvent extends NoticeBaseEvent {
  readonly name: 'notice.member.unmute'
  readonly groupId: string
  readonly userId: string
}

/** 群成员管理员角色变化的通知事件。 */
export interface MemberRoleEvent extends NoticeBaseEvent {
  readonly name: 'notice.member.role'
  readonly groupId: string
  readonly userId: string
  readonly role: 'admin' | 'member'
}

/** 消息被撤回的通知事件。 */
export interface MessageRecallEvent extends NoticeBaseEvent {
  readonly name: 'notice.message.recall'
  readonly userId: string
  readonly messageId: string
}

/** 平台戳一戳或类似互动的通知事件。 */
export interface PokeEvent extends NoticeBaseEvent {
  readonly name: 'notice.poke'
  readonly userId: string
  readonly targetId: string
}

/** 未映射为通用通知的平台专属通知事件。 */
export interface PlatformNoticeEvent extends NoticeBaseEvent {
  readonly name: `notice.${string}.${string}`
  readonly platformType: string
  readonly subType?: string
}

/** 群成员加入、离开、禁言或角色变化的通知联合类型。 */
export type MemberNoticeEvent =
  | MemberJoinEvent
  | MemberLeaveEvent
  | MemberMuteEvent
  | MemberUnmuteEvent
  | MemberRoleEvent

/** 框架已映射的通用通知事件联合类型。 */
export type KnownNoticeEvent = MemberNoticeEvent | MessageRecallEvent | PokeEvent
/** 通用通知和平台专属通知的联合类型。 */
export type NoticeEvent = KnownNoticeEvent | PlatformNoticeEvent

interface RequestBaseEvent extends BaseEvent {
  readonly kind: 'request'
  readonly userId: string
  readonly comment: string
  approve(remark?: string): Promise<void>
  reject(reason?: string): Promise<void>
}

/** 好友申请事件，可批准或拒绝。 */
export interface FriendRequestEvent extends RequestBaseEvent {
  readonly name: 'request.friend'
}

/** Group requests always identify their group, so per-group toggles and group access control apply to them. */
interface GroupRequestBaseEvent extends RequestBaseEvent {
  readonly groupId: string
}

/** 用户申请加入群的事件，可批准或拒绝。 */
export interface GroupJoinRequestEvent extends GroupRequestBaseEvent {
  readonly name: 'request.group.join'
}

/** 邀请机器人加入群的请求事件，可批准或拒绝。 */
export interface GroupInviteRequestEvent extends GroupRequestBaseEvent {
  readonly name: 'request.group.invite'
}

/** 入群申请或入群邀请的联合类型。 */
export type GroupRequestEvent = GroupJoinRequestEvent | GroupInviteRequestEvent
/** 好友或群请求事件的联合类型。 */
export type RequestEvent = FriendRequestEvent | GroupRequestEvent

/** 适配器派发的生命周期或心跳元事件。 */
export interface MetaEvent extends BaseEvent {
  readonly kind: 'meta'
  readonly metaEventType: string
  readonly status?: Record<string, unknown>
  readonly interval?: number
}

/** 机器人上线时派发的内部事件。 */
export interface BotOnlineEvent extends BaseEvent {
  readonly kind: 'internal'
  readonly name: 'bot.online'
  readonly status: 'online'
}

/** 机器人离线时派发的内部事件。 */
export interface BotOfflineEvent extends BaseEvent {
  readonly kind: 'internal'
  readonly name: 'bot.offline'
  readonly status: 'offline'
}

/** 机器人发送消息后派发的内部事件。 */
export interface MessageSentEvent extends BaseEvent {
  readonly kind: 'internal'
  readonly name: 'bot.message.sent'
  readonly eventId?: string
  readonly messageId: string
  readonly messageType: 'private' | 'group'
  readonly userId?: string
  readonly groupId?: string
  readonly thread?: MessageThread
  readonly message: Message
}

/** 一次事件处理结束后的分发追踪事件。 */
export interface DispatchTraceEvent extends BaseEvent {
  readonly kind: 'internal'
  readonly name: 'dispatch.trace'
  readonly trace: DispatchTrace
}

/** 框架支持的消息、通知、请求、元事件和机器人内部事件。 */
export type AnyEvent =
  | Session
  | NoticeEvent
  | RequestEvent
  | MetaEvent
  | BotOnlineEvent
  | BotOfflineEvent
  | MessageSentEvent
  | DispatchTraceEvent

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
  'dispatch.trace': DispatchTraceEvent
}

/** 事件名称与其处理器参数类型的映射。 */
export interface EventMap extends KnownEventMap {
  [name: `notice.${string}`]: NoticeEvent
}
