import type { Sendable } from './message/index.ts'

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
  /** Display name of the bot account, known once it has logged in. */
  readonly nickname?: string
  sendPrivate(userId: string, content: Sendable): Promise<SendResult>
  sendGroup(groupId: string, content: Sendable): Promise<SendResult>
  deleteMessage(messageId: string): Promise<void>
  getSelf(): Promise<UserInfo>
  getGroupList(): Promise<GroupInfo[]>
  getGroupMember(groupId: string, userId: string): Promise<GroupMemberInfo>
  getFriendList(): Promise<UserInfo[]>
  call(action: string, params?: Record<string, unknown>): Promise<unknown>
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
