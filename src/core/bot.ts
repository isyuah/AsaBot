import { DeliveryAttempt } from './delivery.ts'
import { UnsupportedError } from './errors.ts'
import type { Message, Sendable, TextStyle } from './message/index.ts'

/** 机器人原生支持的消息段、文本样式和 API 操作。 */
export interface BotCapabilities {
  segments: readonly string[]
  textStyles: readonly TextStyle[]
  actions: readonly string[]
}

export const botActions = [
  'sendPrivate',
  'sendGroup',
  'sendForward',
  'getForward',
  'deleteMessage',
  'getMessage',
  'getSelf',
  'getGroupList',
  'getGroupMember',
  'getGroupMembers',
  'muteMember',
  'kickMember',
  'setMemberCard',
  'getFriendList',
  'call',
] as const

/** 判断机器人是否原生支持指定消息段类型或 Bot 方法，包括平台段通配符。 */
export function supports(bot: Bot, feature: string): boolean {
  return bot.capabilities.actions.includes(feature) || supportsSegment(bot, feature)
}

export function supportsSegment(bot: Bot, feature: string): boolean {
  return bot.capabilities.segments.some(
    (segment) => segment === feature || (segment.endsWith(':*') && feature.startsWith(segment.slice(0, -1))),
  )
}

/** 从平台读取的消息及其发送者信息。 */
export interface MessageInfo {
  messageId: string
  messageType: 'private' | 'group'
  userId: string
  groupId?: string
  thread?: MessageThread
  time: number
  message: Message
  sender: { userId: string; nickname: string; card?: string; role?: 'owner' | 'admin' | 'member' }
}

/** 发送合并转发时使用的作者和消息内容。 */
export interface ForwardNode {
  userId: string
  nickname: string
  message: Sendable
}
/** 读取合并转发时得到的作者、时间和消息内容。 */
export interface ForwardMessage {
  userId: string
  nickname: string
  time?: number
  message: Message
}
/** 平台话题及其固定的根消息。 */
export interface MessageThread {
  id: string
  rootMessageId: string
}

/** 机器人发送消息使用的群聊、私聊或其中的话题。 */
export type MessageTarget = { type: 'group' | 'private'; id: string; thread?: MessageThread }
export type ThreadTarget = MessageTarget & { thread: MessageThread }

/** 发送成功后返回的平台消息 ID。 */
export interface SendResult {
  messageId: string
  thread?: MessageThread
}

/** 平台用户的 ID、昵称及可选扩展信息。 */
export interface UserInfo {
  userId: string
  nickname: string
  avatar?: string
  sex?: string
  age?: number
  [key: string]: unknown
}

/** 平台群组的 ID、名称及可选成员数量。 */
export interface GroupInfo {
  groupId: string
  groupName: string
  memberCount?: number
  maxMemberCount?: number
  [key: string]: unknown
}

/** 包含群角色和名片的群成员信息。 */
export interface GroupMemberInfo extends UserInfo {
  groupId: string
  card?: string
  role?: 'owner' | 'admin' | 'member'
  title?: string
}

/** 平台无关的机器人接口；操作失败时 Promise 拒绝，平台不支持的操作抛出 UnsupportedError。 */
export interface Bot {
  /** 平台标识。 */
  readonly platform: string
  /** 机器人在该平台上的账号 ID。 */
  readonly selfId: string
  /** 当前连接状态。 */
  readonly status: 'connecting' | 'online' | 'offline'
  /** 实例支持的原生消息段、样式和操作。 */
  readonly capabilities: BotCapabilities
  /** Display name of the bot account, known once it has logged in. */
  /** 登录后已知的机器人昵称。 */
  readonly nickname?: string
  /** 平台提供的当前机器人头像，不依赖用户头像查询能力。 */
  readonly avatar?: string
  /** 向用户发送私聊消息，返回消息 ID。 */
  sendPrivate(userId: string, content: Sendable): Promise<SendResult>
  /** 向群发送消息，返回消息 ID。 */
  sendGroup(groupId: string, content: Sendable): Promise<SendResult>
  /** 向群聊或私聊内的现有话题发送消息。 */
  sendThread?(target: ThreadTarget, content: Sendable): Promise<SendResult>
  /** 向指定私聊或群发送合并转发节点。 */
  sendForward(target: MessageTarget, nodes: ForwardNode[]): Promise<SendResult>
  /** 按转发 ID 获取合并转发的节点。 */
  getForward(id: string): Promise<ForwardMessage[]>
  /** 按消息 ID 撤回消息。 */
  deleteMessage(messageId: string): Promise<void>
  /** 按消息 ID 获取平台上的消息。 */
  getMessage(messageId: string): Promise<MessageInfo>
  /** 获取当前账号的信息。 */
  getSelf(): Promise<UserInfo>
  /** 获取当前账号加入的群列表。 */
  getGroupList(): Promise<GroupInfo[]>
  /** 获取指定群成员的信息。 */
  getGroupMember(groupId: string, userId: string): Promise<GroupMemberInfo>
  /** 获取指定群的成员列表。 */
  getGroupMembers(groupId: string): Promise<GroupMemberInfo[]>
  /** 禁言群成员；duration 的单位是毫秒，0 表示解除禁言。 */
  muteMember(groupId: string, userId: string, duration: number): Promise<void>
  /** 移出群成员；rejectRequest 可同时拒绝其后续加群请求。 */
  kickMember(groupId: string, userId: string, options?: { rejectRequest?: boolean }): Promise<void>
  /** 设置群成员名片；空字符串表示清除。 */
  setMemberCard(groupId: string, userId: string, card: string): Promise<void>
  /** 获取好友列表。 */
  getFriendList(): Promise<UserInfo[]>
  /** 透传平台 API；参数和返回值取决于平台，且不经过发送前钩子。 */
  call(action: string, params?: Record<string, unknown>): Promise<unknown>
  /** 获取用户头像地址；不可用时返回 undefined，部分平台不提供此方法。 */
  getAvatarUrl?(userId: string): string | undefined
}

/** 按完整会话目标发送，话题发送失败时不会回落到所在群聊或私聊。 */
export async function sendTo(bot: Bot, target: MessageTarget, content: Sendable): Promise<SendResult> {
  return new DeliveryAttempt(bot, target).request(async () => {
    if (target.thread) {
      if (!bot.sendThread || !bot.capabilities.actions.includes('sendThread'))
        throw new UnsupportedError(bot.platform, 'sendThread')
      return bot.sendThread({ ...target, thread: target.thread }, content)
    }
    return target.type === 'group' ? bot.sendGroup(target.id, content) : bot.sendPrivate(target.id, content)
  })
}

/** 按平台和账号 ID 管理机器人实例的注册表。 */
export class BotRegistry {
  private readonly entries = new Map<string, Bot>()

  register(bot: Bot): void {
    const key = `${bot.platform}:${bot.selfId}`
    const existing = this.entries.get(key)
    if (existing !== undefined && existing !== bot) {
      throw new Error(`Bot ${key} is already registered`)
    }
    this.entries.set(key, bot)
  }

  unregister(bot: Bot): void {
    const key = `${bot.platform}:${bot.selfId}`
    if (this.entries.get(key) === bot) {
      this.entries.delete(key)
    }
  }

  get(platform: string, selfId: string): Bot | undefined {
    return this.entries.get(`${platform}:${selfId}`)
  }

  list(): Bot[] {
    return [...this.entries.values()]
  }

  clear(): void {
    this.entries.clear()
  }
}
