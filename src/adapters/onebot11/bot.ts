import type { Bot, GroupInfo, GroupMemberInfo, SendResult, UserInfo } from '../../core/bot.ts'
import type { Message, Sendable } from '../../core/message/index.ts'

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
