import type { Message, Sendable, TextStyle } from './message/index.ts'

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

export function supports(bot: Bot, feature: string): boolean {
  return bot.capabilities.actions.includes(feature) || supportsSegment(bot, feature)
}

export function supportsSegment(bot: Bot, feature: string): boolean {
  return bot.capabilities.segments.some(
    (segment) => segment === feature || (segment.endsWith(':*') && feature.startsWith(segment.slice(0, -1))),
  )
}

export interface MessageInfo {
  messageId: string
  messageType: 'private' | 'group'
  userId: string
  groupId?: string
  time: number
  message: Message
  sender: { userId: string; nickname: string; card?: string; role?: 'owner' | 'admin' | 'member' }
}

export interface ForwardNode {
  userId: string
  nickname: string
  message: Sendable
}
export interface ForwardMessage {
  userId: string
  nickname: string
  time?: number
  message: Message
}
export type MessageTarget = { type: 'group' | 'private'; id: string }

export interface SendResult {
  messageId: string
}

export interface UserInfo {
  userId: string
  nickname: string
  sex?: string
  age?: number
  [key: string]: unknown
}

export interface GroupInfo {
  groupId: string
  groupName: string
  memberCount?: number
  maxMemberCount?: number
  [key: string]: unknown
}

export interface GroupMemberInfo extends UserInfo {
  groupId: string
  card?: string
  role?: 'owner' | 'admin' | 'member'
  title?: string
}

export interface Bot {
  readonly platform: string
  readonly selfId: string
  readonly status: 'connecting' | 'online' | 'offline'
  readonly capabilities: BotCapabilities
  /** Display name of the bot account, known once it has logged in. */
  readonly nickname?: string
  sendPrivate(userId: string, content: Sendable): Promise<SendResult>
  sendGroup(groupId: string, content: Sendable): Promise<SendResult>
  sendForward(target: MessageTarget, nodes: ForwardNode[]): Promise<SendResult>
  getForward(id: string): Promise<ForwardMessage[]>
  deleteMessage(messageId: string): Promise<void>
  getMessage(messageId: string): Promise<MessageInfo>
  getSelf(): Promise<UserInfo>
  getGroupList(): Promise<GroupInfo[]>
  getGroupMember(groupId: string, userId: string): Promise<GroupMemberInfo>
  getGroupMembers(groupId: string): Promise<GroupMemberInfo[]>
  muteMember(groupId: string, userId: string, duration: number): Promise<void>
  kickMember(groupId: string, userId: string, options?: { rejectRequest?: boolean }): Promise<void>
  setMemberCard(groupId: string, userId: string, card: string): Promise<void>
  getFriendList(): Promise<UserInfo[]>
  call(action: string, params?: Record<string, unknown>): Promise<unknown>
  getAvatarUrl?(userId: string): string | undefined
}

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
