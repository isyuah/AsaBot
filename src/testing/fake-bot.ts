import type { Bot, GroupInfo, GroupMemberInfo, SendResult, UserInfo } from '../core/bot.ts'
import type { Message, Sendable } from '../core/message/index.ts'
import { normalizeSendable } from '../core/message/index.ts'

export interface FakeSend {
  type: 'group' | 'private'
  target: string
  message: Message
}

export class FakeBot implements Bot {
  readonly platform = 'fake'
  readonly selfId = '10000'
  readonly status = 'online'
  readonly sends: FakeSend[] = []

  async sendPrivate(userId: string, content: Sendable): Promise<SendResult> {
    this.sends.push({ type: 'private', target: userId, message: normalizeSendable(content) })
    return { messageId: String(this.sends.length) }
  }

  async sendGroup(groupId: string, content: Sendable): Promise<SendResult> {
    this.sends.push({ type: 'group', target: groupId, message: normalizeSendable(content) })
    return { messageId: String(this.sends.length) }
  }

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
