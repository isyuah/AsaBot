import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type {
  GroupInfo,
  GroupMemberInfo,
  OneBotApi,
  OneBotForwardNode,
  OneBotMessageInfo,
  OneBotVersionInfo,
  SendResult,
  UserInfo,
} from '../../core/bot.ts'
import type { Message, Segment, Sendable } from '../../core/message/index.ts'
import { normalizeSendable } from '../../core/message/index.ts'
import { incomingMessage } from './message.ts'
import type { OneBotMessage } from './types.ts'

type Request = (action: string, params?: Record<string, unknown>) => Promise<unknown>

export interface OneBotApiHooks {
  assertOnline?: () => void
  onMessageSent?: (input: {
    messageType: 'private' | 'group'
    userId?: string
    groupId?: string
    messageId: string
    message: Sendable
  }) => void
}

function idNumber(value: string): number {
  const number = Number(value)
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new Error(`OneBot IDs must be numeric, got ${value}`)
  }
  return number
}

async function normalizeMediaFile(value: string): Promise<string> {
  // seg.image() and friends turn local paths into file:// URLs. Only those are read and inlined, because
  // NapCat usually runs in a container and cannot see host paths. Any other value (http(s)://, base64://,
  // or a platform file name/id copied from a received segment) is passed through for NapCat to resolve.
  if (!/^file:\/\//i.test(value)) {
    return value
  }
  const path = fileURLToPath(value)
  try {
    const contents = await readFile(path)
    return `base64://${contents.toString('base64')}`
  } catch (error) {
    throw new Error(`Unable to read media file "${path}"`, { cause: error })
  }
}

async function normalizeSegment(segment: Segment): Promise<Segment> {
  const data: Record<string, unknown> = { ...segment.data }
  if (segment.type === 'at' && data.qq !== 'all') {
    data.qq = idNumber(String(data.qq))
  }
  // forward ids are opaque string resids in NapCat, so only reply/face ids are numeric.
  if (segment.type === 'face' || segment.type === 'reply') {
    data.id = idNumber(String(data.id))
  }
  if (
    segment.type === 'image' ||
    segment.type === 'record' ||
    segment.type === 'video' ||
    segment.type === 'file'
  ) {
    data.file = await normalizeMediaFile(String(data.file))
  }
  if (segment.type === 'image' && data.subType !== undefined) {
    data.sub_type = data.subType
    delete data.subType
  }
  return { type: segment.type, data } as Segment
}

export async function normalizeOutbound(content: Sendable): Promise<OneBotMessage> {
  const message: Message = normalizeSendable(content)
  return Promise.all(message.map((segment) => normalizeSegment(segment)))
}

async function normalizeForwardNodes(nodes: OneBotForwardNode[]): Promise<Record<string, unknown>[]> {
  return Promise.all(
    nodes.map(async (node) => {
      if ('id' in node.data) {
        return { type: 'node', data: { id: idNumber(node.data.id) } }
      }
      return {
        type: 'node',
        data: {
          user_id: idNumber(node.data.userId),
          nickname: node.data.nickname,
          content: await normalizeOutbound(node.data.content),
        },
      }
    }),
  )
}

function responseObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid OneBot ${label} response`)
  }
  return value as Record<string, unknown>
}

function responseList(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid OneBot ${label} response`)
  }
  return value
}

function responseId(value: unknown, label: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^-?\d+$/.test(String(value))) {
    throw new Error(`Invalid OneBot ${label} ID`)
  }
  return String(value)
}

function normalizeResponseIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeResponseIds)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === 'number' && (key === 'id' || /(?:_id|Id)$/.test(key))
        ? String(item)
        : normalizeResponseIds(item),
    ]),
  )
}

function messageResult(value: unknown): SendResult {
  const id =
    typeof value === 'number' || typeof value === 'string' ? value : responseObject(value, 'send').message_id
  return { messageId: responseId(id, 'message') }
}

function userInfo(value: unknown): UserInfo {
  const data = responseObject(normalizeResponseIds(value), 'user')
  if (typeof data.nickname !== 'string') throw new Error('Invalid OneBot user nickname')
  const { user_id: _userId, userId: _camelUserId, ...rest } = data
  return {
    ...rest,
    userId: responseId(data.user_id ?? data.userId, 'user'),
    nickname: data.nickname,
  }
}

function groupInfo(value: unknown): GroupInfo {
  const data = responseObject(normalizeResponseIds(value), 'group')
  const name = data.group_name ?? data.groupName
  if (typeof name !== 'string') throw new Error('Invalid OneBot group name')
  const { group_id: _groupId, groupId: _camelGroupId, ...rest } = data
  return {
    ...rest,
    groupId: responseId(data.group_id ?? data.groupId, 'group'),
    groupName: name,
    ...(typeof data.member_count === 'number' ? { memberCount: data.member_count } : {}),
    ...(typeof data.max_member_count === 'number' ? { maxMemberCount: data.max_member_count } : {}),
  }
}

function memberInfo(value: unknown): GroupMemberInfo {
  const data = responseObject(normalizeResponseIds(value), 'group member')
  if (typeof data.nickname !== 'string') throw new Error('Invalid OneBot group member nickname')
  const { user_id: _userId, userId: _camelUserId, group_id: _groupId, groupId: _camelGroupId, ...rest } = data
  const role =
    data.role === 'owner' || data.role === 'admin' || data.role === 'member' ? data.role : undefined
  return {
    ...rest,
    userId: responseId(data.user_id ?? data.userId, 'user'),
    nickname: data.nickname,
    groupId: responseId(data.group_id ?? data.groupId, 'group'),
    ...(role === undefined ? {} : { role }),
  }
}

export class OneBotApiImpl implements OneBotApi {
  private readonly request: Request
  private readonly hooks: OneBotApiHooks

  constructor(request: Request, hooks: OneBotApiHooks = {}) {
    this.request = request
    this.hooks = hooks
  }

  async sendPrivateMsg(userId: string, content: Sendable): Promise<SendResult> {
    this.hooks.assertOnline?.()
    const result = messageResult(
      await this.request('send_private_msg', {
        user_id: idNumber(userId),
        message: await normalizeOutbound(content),
      }),
    )
    this.hooks.onMessageSent?.({
      messageType: 'private',
      userId,
      messageId: result.messageId,
      message: content,
    })
    return result
  }

  async sendGroupMsg(groupId: string, content: Sendable): Promise<SendResult> {
    this.hooks.assertOnline?.()
    const result = messageResult(
      await this.request('send_group_msg', {
        group_id: idNumber(groupId),
        message: await normalizeOutbound(content),
      }),
    )
    this.hooks.onMessageSent?.({
      messageType: 'group',
      groupId,
      messageId: result.messageId,
      message: content,
    })
    return result
  }

  async deleteMsg(messageId: string): Promise<void> {
    await this.request('delete_msg', { message_id: idNumber(messageId) })
  }

  async getMsg(messageId: string): Promise<OneBotMessageInfo> {
    const data = responseObject(await this.request('get_msg', { message_id: idNumber(messageId) }), 'message')
    if (typeof data.time !== 'number' || !Number.isFinite(data.time)) {
      throw new Error('Invalid OneBot message time')
    }
    return {
      messageId: responseId(data.message_id, 'message'),
      ...(data.real_id === undefined ? {} : { realId: responseId(data.real_id, 'message') }),
      ...(data.group_id === undefined ? {} : { groupId: responseId(data.group_id, 'group') }),
      time: data.time * 1_000,
      sender: userInfo(data.sender),
      message: incomingMessage(data.message),
    }
  }

  async getLoginInfo(): Promise<UserInfo> {
    return userInfo(await this.request('get_login_info'))
  }

  async getVersionInfo(): Promise<OneBotVersionInfo> {
    const data = responseObject(await this.request('get_version_info'), 'version')
    if (
      typeof data.app_name !== 'string' ||
      typeof data.app_version !== 'string' ||
      typeof data.protocol_version !== 'string'
    ) {
      throw new Error('Invalid OneBot version information')
    }
    return {
      appName: data.app_name,
      appVersion: data.app_version,
      protocolVersion: data.protocol_version,
    }
  }

  async getStrangerInfo(userId: string, noCache = false): Promise<UserInfo> {
    return userInfo(await this.request('get_stranger_info', { user_id: idNumber(userId), no_cache: noCache }))
  }

  async getFriendList(): Promise<UserInfo[]> {
    const values = responseList(await this.request('get_friend_list'), 'friend list')
    return values.map(userInfo)
  }

  async getGroupInfo(groupId: string, noCache = false): Promise<GroupInfo> {
    return groupInfo(await this.request('get_group_info', { group_id: idNumber(groupId), no_cache: noCache }))
  }

  async getGroupList(): Promise<GroupInfo[]> {
    const values = responseList(await this.request('get_group_list'), 'group list')
    return values.map(groupInfo)
  }

  async getGroupMemberInfo(groupId: string, userId: string, noCache = false): Promise<GroupMemberInfo> {
    return memberInfo(
      await this.request('get_group_member_info', {
        group_id: idNumber(groupId),
        user_id: idNumber(userId),
        no_cache: noCache,
      }),
    )
  }

  async getGroupMemberList(groupId: string): Promise<GroupMemberInfo[]> {
    const values = responseList(
      await this.request('get_group_member_list', { group_id: idNumber(groupId) }),
      'group member list',
    )
    return values.map(memberInfo)
  }

  async setGroupBan(groupId: string, userId: string, duration = 30 * 60): Promise<void> {
    await this.request('set_group_ban', { group_id: idNumber(groupId), user_id: idNumber(userId), duration })
  }

  async setGroupWholeBan(groupId: string, enable: boolean): Promise<void> {
    await this.request('set_group_whole_ban', { group_id: idNumber(groupId), enable })
  }

  async setGroupKick(groupId: string, userId: string, rejectAddRequest = false): Promise<void> {
    await this.request('set_group_kick', {
      group_id: idNumber(groupId),
      user_id: idNumber(userId),
      reject_add_request: rejectAddRequest,
    })
  }

  async setGroupCard(groupId: string, userId: string, card: string): Promise<void> {
    await this.request('set_group_card', { group_id: idNumber(groupId), user_id: idNumber(userId), card })
  }

  async setGroupAdmin(groupId: string, userId: string, enable: boolean): Promise<void> {
    await this.request('set_group_admin', { group_id: idNumber(groupId), user_id: idNumber(userId), enable })
  }

  async setGroupSpecialTitle(
    groupId: string,
    userId: string,
    specialTitle: string,
    duration = -1,
  ): Promise<void> {
    await this.request('set_group_special_title', {
      group_id: idNumber(groupId),
      user_id: idNumber(userId),
      special_title: specialTitle,
      duration,
    })
  }

  async setFriendAddRequest(flag: string, approve: boolean, remark = ''): Promise<void> {
    await this.request('set_friend_add_request', { flag, approve, remark })
  }

  async setGroupAddRequest(
    flag: string,
    subType: 'add' | 'invite',
    approve: boolean,
    reason = '',
  ): Promise<void> {
    await this.request('set_group_add_request', { flag, sub_type: subType, approve, reason })
  }

  async sendGroupForwardMsg(groupId: string, messages: OneBotForwardNode[]): Promise<SendResult> {
    this.hooks.assertOnline?.()
    const result = messageResult(
      await this.request('send_group_forward_msg', {
        group_id: idNumber(groupId),
        messages: await normalizeForwardNodes(messages),
      }),
    )
    this.hooks.onMessageSent?.({
      messageType: 'group',
      groupId,
      messageId: result.messageId,
      message: messages,
    })
    return result
  }

  async sendPrivateForwardMsg(userId: string, messages: OneBotForwardNode[]): Promise<SendResult> {
    this.hooks.assertOnline?.()
    const result = messageResult(
      await this.request('send_private_forward_msg', {
        user_id: idNumber(userId),
        messages: await normalizeForwardNodes(messages),
      }),
    )
    this.hooks.onMessageSent?.({
      messageType: 'private',
      userId,
      messageId: result.messageId,
      message: messages,
    })
    return result
  }

  async groupPoke(groupId: string, userId: string): Promise<void> {
    await this.request('group_poke', { group_id: idNumber(groupId), user_id: idNumber(userId) })
  }

  async friendPoke(userId: string): Promise<void> {
    await this.request('friend_poke', { user_id: idNumber(userId) })
  }
}
