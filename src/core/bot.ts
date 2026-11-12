import type { Message, Sendable } from './message/index.ts'

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

export interface OneBotMessageInfo {
  messageId: string
  realId?: string
  time: number
  sender: UserInfo
  message: Message
  groupId?: string
}

export interface OneBotVersionInfo {
  appName: string
  appVersion: string
  protocolVersion: string
}

export type OneBotForwardNode =
  | { type: 'node'; data: { id: string } }
  | { type: 'node'; data: { userId: string; nickname: string; content: Sendable } }

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

export interface OneBotApi {
  sendPrivateMsg(userId: string, content: Sendable): Promise<SendResult>
  sendGroupMsg(groupId: string, content: Sendable): Promise<SendResult>
  deleteMsg(messageId: string): Promise<void>
  getMsg(messageId: string): Promise<OneBotMessageInfo>
  getLoginInfo(): Promise<UserInfo>
  getVersionInfo(): Promise<OneBotVersionInfo>
  getStrangerInfo(userId: string, noCache?: boolean): Promise<UserInfo>
  getFriendList(): Promise<UserInfo[]>
  getGroupInfo(groupId: string, noCache?: boolean): Promise<GroupInfo>
  getGroupList(): Promise<GroupInfo[]>
  getGroupMemberInfo(groupId: string, userId: string, noCache?: boolean): Promise<GroupMemberInfo>
  getGroupMemberList(groupId: string): Promise<GroupMemberInfo[]>
  setGroupBan(groupId: string, userId: string, duration?: number): Promise<void>
  setGroupWholeBan(groupId: string, enable: boolean): Promise<void>
  setGroupKick(groupId: string, userId: string, rejectAddRequest?: boolean): Promise<void>
  setGroupCard(groupId: string, userId: string, card: string): Promise<void>
  setGroupAdmin(groupId: string, userId: string, enable: boolean): Promise<void>
  setGroupSpecialTitle(
    groupId: string,
    userId: string,
    specialTitle: string,
    duration?: number,
  ): Promise<void>
  setFriendAddRequest(flag: string, approve: boolean, remark?: string): Promise<void>
  setGroupAddRequest(
    flag: string,
    subType: 'add' | 'invite',
    approve: boolean,
    reason?: string,
  ): Promise<void>
  sendGroupForwardMsg(groupId: string, messages: OneBotForwardNode[]): Promise<SendResult>
  sendPrivateForwardMsg(userId: string, messages: OneBotForwardNode[]): Promise<SendResult>
  groupPoke(groupId: string, userId: string): Promise<void>
  friendPoke(userId: string): Promise<void>
}

export interface OneBotBot extends Bot {
  readonly onebot: OneBotApi
}

export function isOneBot(bot: Bot): bot is OneBotBot {
  const api = (bot as Partial<OneBotBot>).onebot
  return bot.platform === 'onebot11' && api !== null && typeof api === 'object'
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
