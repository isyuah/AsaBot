import type { Bot, ForwardMessage, GroupInfo, GroupMemberInfo, SendResult, UserInfo } from '../../core/bot.ts'
import type { Message, Sendable } from '../../core/message/index.ts'

/** OneBot 消息查询返回的消息及发送者信息。 */
export interface OneBotMessageInfo {
  messageId: string
  messageType: 'private' | 'group'
  userId: string
  realId?: string
  time: number
  sender: UserInfo
  message: Message
  groupId?: string
}

/** OneBot 实现及协议的版本信息。 */
export interface OneBotVersionInfo {
  appName: string
  appVersion: string
  protocolVersion: string
}

/** OneBot 合并转发中的消息引用或自定义节点。 */
export type OneBotForwardNode =
  | { type: 'node'; data: { id: string } }
  | { type: 'node'; data: { userId: string; nickname: string; content: Sendable } }

/** OneBot 11 平台专属 API；请求失败时 Promise 拒绝。 */
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
  getForwardMsg(id: string): Promise<ForwardMessage[]>
  groupPoke(groupId: string, userId: string): Promise<void>
  friendPoke(userId: string): Promise<void>
}

/** 附带 OneBot 专属 API 的机器人。 */
export interface OneBotBot extends Bot {
  readonly onebot: OneBotApi
}

/** 判断机器人是否提供 OneBot 专属 API，并收窄其类型。 */
export function isOneBot(bot: Bot): bot is OneBotBot {
  const api = (bot as Partial<OneBotBot>).onebot
  return bot.platform === 'onebot11' && api !== null && typeof api === 'object'
}
