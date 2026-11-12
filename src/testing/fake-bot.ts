import type {
  Bot,
  ForwardMessage,
  ForwardNode,
  GroupInfo,
  GroupMemberInfo,
  MessageInfo,
  MessageTarget,
  SendResult,
  UserInfo,
} from '../core/bot.ts'
import { botActions } from '../core/bot.ts'
import { UnsupportedError } from '../core/errors.ts'
import type { Message, Sendable } from '../core/message/index.ts'
import { normalizeSendable } from '../core/message/index.ts'

/** FakeBot 记录的一次发送目标及消息。 */
export interface FakeSend {
  type: 'group' | 'private'
  target: string
  message: Message
}

/** 用于轻量测试的机器人，记录发送内容并模拟部分 API。 */
export class FakeBot implements Bot {
  readonly platform = 'fake'
  readonly selfId = '10000'
  readonly status = 'online'
  readonly capabilities = { segments: ['text'], textStyles: [], actions: botActions }
  readonly sends: FakeSend[] = []

  async sendPrivate(userId: string, content: Sendable): Promise<SendResult> {
    this.sends.push({ type: 'private', target: userId, message: normalizeSendable(content) })
    return { messageId: String(this.sends.length) }
  }

  async sendGroup(groupId: string, content: Sendable): Promise<SendResult> {
    this.sends.push({ type: 'group', target: groupId, message: normalizeSendable(content) })
    return { messageId: String(this.sends.length) }
  }

  async sendForward(_target: MessageTarget, _nodes: ForwardNode[]): Promise<SendResult> {
    throw new UnsupportedError(this.platform, 'sendForward')
  }
  async getForward(_id: string): Promise<ForwardMessage[]> {
    throw new UnsupportedError(this.platform, 'getForward')
  }
  async getMessage(_id: string): Promise<MessageInfo> {
    throw new UnsupportedError(this.platform, 'getMessage')
  }
  async getGroupMembers(_groupId: string): Promise<GroupMemberInfo[]> {
    return []
  }
  async muteMember(_groupId: string, _userId: string, _duration: number): Promise<void> {}
  async kickMember(
    _groupId: string,
    _userId: string,
    _options?: { rejectRequest?: boolean },
  ): Promise<void> {}
  async setMemberCard(_groupId: string, _userId: string, _card: string): Promise<void> {}

  async deleteMessage(_messageId: string): Promise<void> {}
  async getSelf(): Promise<UserInfo> {
    return { userId: this.selfId, nickname: 'FakeBot' }
  }
  async getGroupList(): Promise<GroupInfo[]> {
    return []
  }
  async getGroupMember(groupId: string, userId: string): Promise<GroupMemberInfo> {
    return { groupId, userId, nickname: userId }
  }
  async getFriendList(): Promise<UserInfo[]> {
    return []
  }
  async call(_action: string, _params?: Record<string, unknown>): Promise<unknown> {
    return {}
  }
}
