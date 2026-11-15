import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { Logger } from 'pino'
import WebSocket, { type RawData, WebSocketServer } from 'ws'
import type { Adapter, AdapterHost, BotInfo, PreparedOutgoing } from '../../core/adapter.ts'
import type {
  ForwardMessage,
  ForwardNode,
  GroupInfo,
  GroupMemberInfo,
  MessageInfo,
  MessageTarget,
  SendResult,
  UserInfo,
} from '../../core/bot.ts'
import { botActions } from '../../core/bot.ts'
import { ApiTimeoutError, NotConnectedError } from '../../core/errors.ts'
import type {
  BotOfflineEvent,
  BotOnlineEvent,
  MessageSentEvent,
  MetaEvent,
  PlatformNoticeEvent,
  Session,
} from '../../core/event/index.ts'
import { createSession } from '../../core/event/index.ts'
import type { Message, Sendable } from '../../core/message/index.ts'
import { LruSet } from '../../core/utils/lru.ts'
import { constantTimeEqual } from '../../core/utils/security.ts'
import { OneBotApiImpl, type OneBotOutgoingRequest } from './api.ts'
import type { OneBotApi, OneBotBot } from './bot.ts'
import { ApiError } from './errors.ts'
import { incomingMessage } from './message.ts'
import { SendQueue } from './send-queue.ts'
import type { OneBot11Config, OneBotConnectionConfig, OneBotFrame, OneBotMessageEvent } from './types.ts'

/** OneBot 适配器可注入的连接、定时和测试选项。 */
export interface OneBotAdapterOptions {
  logger?: Logger
  apiTimeout?: number
  reconnect?: { minDelay: number; maxDelay: number }
  pingInterval?: number
  pongTimeout?: number
  heartbeatTimeoutMultiplier?: number
  heartbeatCheckInterval?: number
  stableTime?: number
  ignoreSelf?: boolean
}

interface PendingRequest {
  action: string
  timer: NodeJS.Timeout
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

interface ConnectionOptions {
  logger: Logger
  apiTimeout: number
  reconnect: { minDelay: number; maxDelay: number }
  pingInterval: number
  pongTimeout: number
  heartbeatTimeoutMultiplier: number
  heartbeatCheckInterval: number
  stableTime: number
  ignoreSelf: boolean
  sendQueue: OneBot11Config['sendQueue']
}

type SessionTransport =
  | { connection: 'forward'; url: string; accessToken?: string }
  | { connection: 'reverse'; selfId: string; remoteAddress: string; accessToken: string }

const sendActions = new Set([
  'send_private_msg',
  'send_group_msg',
  'send_msg',
  'send_group_forward_msg',
  'send_private_forward_msg',
])

function sanitizedUrl(source: string): string {
  try {
    const url = new URL(source)
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|password|secret|authorization)/i.test(key)) {
        url.searchParams.delete(key)
      }
    }
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return '<invalid URL>'
  }
}

function redactSecrets(text: string, token: string | undefined): string {
  let result = text
    .replace(/((?:access_token|token|apiToken|password|secret|authorization)=)[^&\s]*/gi, '$1[Redacted]')
    .replace(/((?:wss?|https?):\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[Redacted]@')
  if (token) {
    result = result.replaceAll(token, '[Redacted]')
  }
  return result
}

function errorReason(error: unknown, token: string | undefined): string {
  return error instanceof Error ? redactSecrets(error.message || error.name, token) : 'Unknown error'
}

/** Events received between socket open and login completion are buffered (bounded) instead of dropped. */
const maxPendingEvents = 200

function eventTime(raw: { time?: unknown }): number {
  const time = Number(raw.time)
  return Number.isFinite(time) && time > 0 ? time * 1_000 : Date.now()
}

function platformId(value: unknown): string {
  return String(value)
}

export const onebotCapabilities = {
  segments: ['text', 'at', 'face', 'image', 'audio', 'video', 'file', 'reply', 'forward', 'onebot11:*'],
  textStyles: [],
  actions: [...botActions, 'getAvatarUrl'],
}

class OneBotBotImpl implements OneBotBot {
  readonly platform = 'onebot11'
  readonly capabilities = onebotCapabilities
  readonly onebot: OneBotApi
  readonly sentMessageIds = new LruSet<string>(1_000)
  private currentStatus: 'connecting' | 'online' | 'offline' = 'connecting'
  readonly selfId: string
  nickname: string | undefined
  sendQueue: SendQueue
  private connection: OneBotSession

  constructor(connection: OneBotSession, selfId: string, options: ConnectionOptions) {
    this.connection = connection
    this.selfId = selfId
    this.sendQueue = new SendQueue(options.sendQueue, options.logger, selfId)
    this.onebot = new OneBotApiImpl((action, params) => this.call(action, params), {
      assertOnline: () => this.connection.assertOnline(this),
      prepareOutgoing: (target, message) => this.connection.prepareOutgoing(this, target, message),
      executeOutgoing: (action, params, execute) =>
        this.connection.interceptOutgoing(this, action, params, execute),
      onMessageSent: (input) => {
        this.sentMessageIds.add(input.messageId)
        this.connection.emitMessageSent(this, input)
      },
    })
  }

  setConnection(connection: OneBotSession): void {
    this.connection = connection
  }

  usesConnection(connection: OneBotSession): boolean {
    return this.connection === connection
  }

  get status(): 'connecting' | 'online' | 'offline' {
    return this.currentStatus
  }

  setStatus(status: 'connecting' | 'online' | 'offline'): void {
    this.currentStatus = status
  }

  async sendPrivate(userId: string, content: Sendable): Promise<SendResult> {
    return this.onebot.sendPrivateMsg(userId, content)
  }

  async sendGroup(groupId: string, content: Sendable): Promise<SendResult> {
    return this.onebot.sendGroupMsg(groupId, content)
  }

  sendForward(target: MessageTarget, nodes: ForwardNode[]): Promise<SendResult> {
    const messages = nodes.map((node) => ({
      type: 'node' as const,
      data: { userId: node.userId, nickname: node.nickname, content: node.message },
    }))
    return target.type === 'group'
      ? this.onebot.sendGroupForwardMsg(target.id, messages)
      : this.onebot.sendPrivateForwardMsg(target.id, messages)
  }

  getForward(id: string): Promise<ForwardMessage[]> {
    return this.onebot.getForwardMsg(id)
  }

  async getMessage(messageId: string): Promise<MessageInfo> {
    const info = await this.onebot.getMsg(messageId)
    const role = info.sender.role
    return {
      messageId: info.messageId,
      messageType: info.messageType,
      userId: info.userId,
      ...(info.groupId === undefined ? {} : { groupId: info.groupId }),
      time: info.time,
      message: info.message,
      sender: {
        userId: info.sender.userId,
        nickname: info.sender.nickname,
        ...(typeof info.sender.card === 'string' ? { card: info.sender.card } : {}),
        ...(role === 'owner' || role === 'admin' || role === 'member' ? { role } : {}),
      },
    }
  }

  deleteMessage(messageId: string): Promise<void> {
    return this.onebot.deleteMsg(messageId)
  }

  getSelf(): Promise<UserInfo> {
    return this.onebot.getLoginInfo()
  }

  getGroupList(): Promise<GroupInfo[]> {
    return this.onebot.getGroupList()
  }

  getGroupMember(groupId: string, userId: string): Promise<GroupMemberInfo> {
    return this.onebot.getGroupMemberInfo(groupId, userId)
  }

  getGroupMembers(groupId: string): Promise<GroupMemberInfo[]> {
    return this.onebot.getGroupMemberList(groupId)
  }

  muteMember(groupId: string, userId: string, duration: number): Promise<void> {
    return this.onebot.setGroupBan(groupId, userId, Math.ceil(duration / 1_000))
  }

  kickMember(groupId: string, userId: string, options?: { rejectRequest?: boolean }): Promise<void> {
    return this.onebot.setGroupKick(groupId, userId, options?.rejectRequest)
  }

  setMemberCard(groupId: string, userId: string, card: string): Promise<void> {
    return this.onebot.setGroupCard(groupId, userId, card)
  }

  getFriendList(): Promise<UserInfo[]> {
    return this.onebot.getFriendList()
  }

  getAvatarUrl(userId: string): string | undefined {
    return userId.length > 0 && !/\D/.test(userId)
      ? `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=100`
      : undefined
  }

  call(action: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.connection.requestForBot(this, action, params)
  }
}

class OneBotSession {
  private socket: WebSocket | undefined
  private pingTimer: NodeJS.Timeout | undefined
  private pongTimer: NodeJS.Timeout | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private readonly pending = new Map<string, PendingRequest>()
  private stopped = true
  private connected = false
  private echo = 0
  private heartbeatPeriod: number | undefined
  private lastHeartbeatAt: number | undefined
  private waitingForPong = false
  private currentBot: OneBotBotImpl | undefined
  private previousBot: OneBotBotImpl | undefined
  private readonly pendingEvents: OneBotFrame[] = []
  readonly transport: SessionTransport
  private readonly host: AdapterHost
  private readonly options: ConnectionOptions
  private readonly adapter: OneBotAdapter
  private readonly onOnline: () => void
  private readonly onClose: () => void
  private closing: Promise<void> | undefined

  constructor(
    transport: SessionTransport,
    host: AdapterHost,
    options: ConnectionOptions,
    adapter: OneBotAdapter,
    onOnline: () => void,
    onClose: () => void,
  ) {
    this.transport = transport
    this.host = host
    this.options = options
    this.adapter = adapter
    this.onOnline = onOnline
    this.onClose = onClose
  }

  start(socket: WebSocket): void {
    this.stopped = false
    this.socket = socket
    socket.on('open', () => this.handleOpen(socket))
    socket.on('message', (data) => {
      if (this.socket === socket) this.handleMessage(data)
    })
    socket.on('pong', () => {
      if (this.socket === socket) this.handlePong()
    })
    socket.on('close', () => this.handleClose(socket))
    if (socket.readyState === WebSocket.OPEN) void this.handleOpen(socket)
  }

  stop(reason = 'shutdown'): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.stopped = true
    const socket = this.socket
    if (socket === undefined) return Promise.resolve()
    this.handleClose(socket)
    if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
    this.closing = new Promise<void>((resolve) => {
      const timer = setTimeout(() => socket.terminate(), 1_000)
      socket.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, reason)
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
    })
    return this.closing
  }

  async requestForBot(
    bot: OneBotBotImpl,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.assertOnline(bot)
    if (sendActions.has(action)) return bot.sendQueue.send(() => this.request(action, params))
    return this.request(action, params)
  }

  prepareOutgoing(bot: OneBotBotImpl, target: MessageTarget, message: Message): Promise<PreparedOutgoing> {
    return this.host.prepareOutgoing({ bot, target, message })
  }

  interceptOutgoing(
    bot: OneBotBotImpl,
    action: string,
    params: Record<string, unknown>,
    execute: OneBotOutgoingRequest,
  ): Promise<unknown> {
    return this.host.invokeApi({ bot, method: 'call', args: [action, params] }, (args) =>
      execute(args[0] as string, args[1] as Record<string, unknown>),
    )
  }

  assertOnline(bot: OneBotBotImpl): void {
    if (
      this.currentBot !== bot ||
      !bot.usesConnection(this) ||
      bot.status !== 'online' ||
      !this.connected ||
      this.socket?.readyState !== WebSocket.OPEN
    ) {
      throw new NotConnectedError()
    }
  }

  connectionInfo(): BotInfo {
    if (this.transport.connection === 'reverse') return { connection: '反向 WS' }
    const url = new URL(this.transport.url)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return { connection: '正向 WS', url: url.toString() }
  }

  request(action: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new NotConnectedError())
    }
    const socket = this.socket
    const echo = String(++this.echo)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new ApiTimeoutError(action, this.options.apiTimeout))
      }, this.options.apiTimeout)
      this.pending.set(echo, { action, timer, resolve, reject })
      try {
        socket.send(JSON.stringify({ action, params: params ?? {}, echo }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(error)
      }
    })
  }

  emitMessageSent(
    bot: OneBotBotImpl,
    input: {
      messageType: 'private' | 'group'
      userId?: string
      groupId?: string
      message: Sendable
      messageId: string
    },
  ): void {
    const event: MessageSentEvent = {
      id: randomUUID(),
      platform: 'onebot11',
      selfId: bot.selfId,
      time: Date.now(),
      kind: 'internal',
      name: 'bot.message.sent',
      raw: undefined,
      bot,
      messageId: input.messageId,
      messageType: input.messageType,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
      message: normalizeMessageForEvent(input.message),
    }
    this.host.emit(event)
  }

  private async handleOpen(socket: WebSocket): Promise<void> {
    if (this.stopped || this.socket !== socket) {
      return
    }
    this.connected = true
    this.startLiveness()
    try {
      const login = (await this.request('get_login_info')) as Record<string, unknown>
      if (this.stopped || this.socket !== socket || !this.connected) {
        return
      }
      const loginId = login.userId ?? login.user_id
      if ((typeof loginId !== 'number' && typeof loginId !== 'string') || !/^-?\d+$/.test(String(loginId))) {
        throw new Error('get_login_info returned an invalid user_id')
      }
      const selfId = String(loginId)
      if (this.transport.connection === 'reverse' && this.transport.selfId !== selfId) {
        this.log('warn', { loginSelfId: selfId }, 'OneBot reverse login self ID mismatch')
        socket.close(1008, 'self ID mismatch')
        return
      }
      if (this.previousBot !== undefined && this.previousBot.selfId !== selfId)
        this.adapter.forgetPrevious(this, this.previousBot)
      const bot = this.adapter.claim(this, selfId)
      this.currentBot = bot
      this.previousBot = bot
      if (typeof login.nickname === 'string') bot.nickname = login.nickname
      bot.setStatus('online')
      this.emitBotOnline(bot)
      for (const frame of this.pendingEvents.splice(0)) {
        this.handleEvent(frame)
      }
      this.onOnline()
    } catch (error) {
      if (this.stopped || this.socket !== socket) {
        return
      }
      this.log('warn', { reason: errorReason(error, this.transport.accessToken) }, 'OneBot login failed')
      socket.close()
    }
  }

  private handleMessage(data: RawData): void {
    if (this.heartbeatPeriod !== undefined) {
      this.lastHeartbeatAt = Date.now()
    }
    let frame: OneBotFrame
    try {
      const parsed: unknown = JSON.parse(data.toString())
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.log('warn', {}, 'Invalid OneBot frame')
        return
      }
      frame = parsed as OneBotFrame
    } catch {
      this.log('warn', {}, 'Invalid JSON from OneBot')
      return
    }
    if (frame.echo !== undefined && frame.post_type === undefined) {
      this.resolveResponse(frame)
      return
    }
    if (frame.post_type !== undefined) {
      this.handleEvent(frame)
      return
    }
    this.log('debug', {}, 'Ignoring unknown OneBot frame')
  }

  private resolveResponse(frame: OneBotFrame): void {
    const echo = String(frame.echo)
    const pending = this.pending.get(echo)
    if (pending === undefined) {
      return
    }
    this.pending.delete(echo)
    clearTimeout(pending.timer)
    if (frame.status === 'failed' || (frame.retcode !== undefined && frame.retcode !== 0)) {
      pending.reject(
        new ApiError(
          pending.action,
          frame.retcode ?? -1,
          frame.wording ?? String(frame.message ?? 'API failed'),
        ),
      )
      return
    }
    pending.resolve(frame.data)
  }

  private handleEvent(frame: OneBotFrame): void {
    if (this.currentBot === undefined || this.currentBot.status !== 'online') {
      if (this.pendingEvents.length < maxPendingEvents) {
        this.pendingEvents.push(frame)
      } else {
        this.log(
          'warn',
          { postType: frame.post_type },
          'Dropping OneBot event received before login completed',
        )
      }
      return
    }
    if (frame.post_type === 'message' || frame.post_type === 'message_sent') {
      this.handleMessageEvent(frame as OneBotMessageEvent)
    } else if (frame.post_type === 'notice') {
      this.handleNotice(frame)
    } else if (frame.post_type === 'request') {
      this.handleRequest(frame)
    } else if (frame.post_type === 'meta_event') {
      this.handleMeta(frame)
    }
  }

  private handleMessageEvent(frame: OneBotMessageEvent): void {
    if (
      (frame.message_type !== 'private' && frame.message_type !== 'group') ||
      frame.message_id === undefined ||
      frame.user_id === undefined ||
      (frame.message_type === 'group' && frame.group_id === undefined)
    ) {
      this.log('warn', {}, 'Ignoring malformed OneBot message event')
      return
    }
    if (frame.post_type === 'message_sent' && this.options.ignoreSelf) {
      return
    }
    const bot = this.currentBot
    if (bot === undefined || bot.status !== 'online') {
      return
    }
    let message: Message
    try {
      message = incomingMessage(frame.message)
    } catch (error) {
      this.log('warn', { err: error }, 'Ignoring malformed OneBot message')
      return
    }
    const userId = platformId(frame.user_id)
    const target =
      frame.message_type === 'group'
        ? { messageType: 'group' as const, groupId: platformId(frame.group_id) }
        : { messageType: 'private' as const }
    const nickname = String(frame.sender?.nickname ?? '')
    const senderRole = frame.sender?.role
    const role =
      senderRole === 'owner' || senderRole === 'admin' || senderRole === 'member' ? senderRole : undefined
    const session = createSession(
      {
        id: randomUUID(),
        platform: 'onebot11',
        selfId: bot.selfId,
        time: eventTime(frame as { time?: unknown }),
        raw: frame,
        bot,
        ...target,
        messageId: platformId(frame.message_id),
        userId,
        message,
        sender: {
          userId,
          nickname,
          ...(frame.sender?.card === undefined ? {} : { card: frame.sender.card }),
          ...(role === undefined ? {} : { role }),
        },
        isSuperuser: this.host.isSuperuser({ platform: 'onebot11', selfId: bot.selfId, userId }),
        isBotAdmin: this.host.isBotAdmin({ platform: 'onebot11', selfId: bot.selfId, userId }),
        sentMessageIds: bot.sentMessageIds,
      },
      this.host.sessionServices,
    )
    this.logMessage(session)
    this.host.emit(session)
  }

  private logMessage(session: Session): void {
    const location =
      session.messageType === 'group' ? `group:${session.groupId}` : `private:${session.userId}`
    const characters = [...session.text]
    const text = characters.length > 200 ? `${characters.slice(0, 197).join('')}...` : session.text
    this.host.logger.info(`[${location}] ${session.sender.nickname}(${session.userId}): ${text}`)
  }

  private handleNotice(frame: OneBotFrame): void {
    const bot = this.currentBot
    if (bot === undefined || bot.status !== 'online') {
      return
    }
    const noticeType = String(frame.notice_type ?? '')
    const subType = frame.sub_type === undefined ? undefined : String(frame.sub_type)
    const requiredFields = new Map<string, string[]>([
      ['group_increase', ['group_id', 'user_id', 'operator_id']],
      ['group_decrease', ['group_id', 'user_id', 'operator_id']],
      ['group_recall', ['group_id', 'user_id', 'operator_id', 'message_id']],
      ['friend_recall', ['user_id', 'message_id']],
      ['group_ban', ['group_id', 'user_id', 'operator_id', 'duration']],
      ['group_admin', ['group_id', 'user_id']],
    ])
    const validSubtypes = new Map<string, string[]>([
      ['group_increase', ['approve', 'invite']],
      ['group_decrease', ['leave', 'kick', 'kick_me']],
      ['group_ban', ['ban', 'lift_ban']],
      ['group_admin', ['set', 'unset']],
    ])
    const allowedSubtypes = validSubtypes.get(noticeType)
    if (
      !noticeType ||
      requiredFields.get(noticeType)?.some((key) => frame[key] === undefined || frame[key] === null) ||
      (allowedSubtypes !== undefined && !allowedSubtypes.includes(subType ?? '')) ||
      (noticeType === 'group_ban' && !Number.isFinite(Number(frame.duration) * 1_000)) ||
      (noticeType === 'notify' && subType === 'poke' && (frame.user_id == null || frame.target_id == null))
    ) {
      this.log('warn', { noticeType, subType }, 'Ignoring malformed OneBot notice')
      return
    }
    const base = {
      id: randomUUID(),
      platform: 'onebot11',
      selfId: bot.selfId,
      time: eventTime(frame as { time?: unknown }),
      kind: 'notice' as const,
      raw: frame,
      bot,
    }
    const optionalIds = {
      ...(frame.user_id == null ? {} : { userId: platformId(frame.user_id) }),
      ...(frame.group_id == null ? {} : { groupId: platformId(frame.group_id) }),
      ...(frame.operator_id == null ? {} : { operatorId: platformId(frame.operator_id) }),
    }

    switch (noticeType) {
      case 'group_increase':
        this.host.emit({
          ...base,
          name: 'notice.member.join',
          groupId: platformId(frame.group_id),
          userId: platformId(frame.user_id),
          operatorId: platformId(frame.operator_id),
          joinType: String(subType),
        })
        return
      case 'group_decrease':
        this.host.emit({
          ...base,
          name: 'notice.member.leave',
          groupId: platformId(frame.group_id),
          userId: subType === 'kick_me' ? bot.selfId : platformId(frame.user_id),
          operatorId: platformId(frame.operator_id),
          reason: subType === 'kick_me' ? 'kick' : String(subType),
        })
        return
      case 'group_ban': {
        const member = {
          ...base,
          groupId: platformId(frame.group_id),
          userId: platformId(frame.user_id),
          operatorId: platformId(frame.operator_id),
        }
        this.host.emit(
          subType === 'ban'
            ? { ...member, name: 'notice.member.mute', duration: Number(frame.duration) * 1_000 }
            : { ...member, name: 'notice.member.unmute' },
        )
        return
      }
      case 'group_admin':
        this.host.emit({
          ...base,
          name: 'notice.member.role',
          groupId: platformId(frame.group_id),
          userId: platformId(frame.user_id),
          role: subType === 'set' ? 'admin' : 'member',
        })
        return
      case 'group_recall':
      case 'friend_recall':
        this.host.emit({
          ...base,
          name: 'notice.message.recall',
          userId: platformId(frame.user_id),
          messageId: platformId(frame.message_id),
          ...(noticeType === 'group_recall'
            ? { groupId: platformId(frame.group_id), operatorId: platformId(frame.operator_id) }
            : {}),
        })
        return
      case 'notify':
        if (subType === 'poke') {
          this.host.emit({
            ...base,
            name: 'notice.poke',
            userId: platformId(frame.user_id),
            targetId: platformId(frame.target_id),
            ...(frame.group_id == null ? {} : { groupId: platformId(frame.group_id) }),
          })
          return
        }
        break
    }

    const event: PlatformNoticeEvent = {
      ...base,
      ...optionalIds,
      name: `notice.onebot11.${noticeType}${subType ? `.${subType}` : ''}`,
      platformType: noticeType,
      ...(subType === undefined ? {} : { subType }),
    }
    this.host.emit(event)
  }

  private handleRequest(frame: OneBotFrame): void {
    const bot = this.currentBot
    if (bot === undefined || bot.status !== 'online') {
      return
    }
    if (
      (frame.request_type !== 'friend' && frame.request_type !== 'group') ||
      (frame.request_type === 'group' &&
        ((frame.sub_type !== 'add' && frame.sub_type !== 'invite') || frame.group_id === undefined)) ||
      frame.user_id === undefined ||
      typeof frame.flag !== 'string'
    ) {
      this.log('warn', {}, 'Ignoring malformed OneBot request')
      return
    }
    const flag = frame.flag
    const base = {
      id: randomUUID(),
      platform: 'onebot11',
      selfId: bot.selfId,
      time: eventTime(frame as { time?: unknown }),
      kind: 'request' as const,
      raw: frame,
      bot,
      userId: platformId(frame.user_id),
      comment: String(frame.comment ?? ''),
    }
    if (frame.request_type === 'friend') {
      this.host.emit({
        ...base,
        name: 'request.friend',
        approve: (remark = '') => bot.onebot.setFriendAddRequest(flag, true, remark),
        reject: () => bot.onebot.setFriendAddRequest(flag, false),
      })
      return
    }
    const subType = frame.sub_type === 'add' ? 'add' : 'invite'
    this.host.emit({
      ...base,
      groupId: platformId(frame.group_id),
      name: subType === 'add' ? 'request.group.join' : 'request.group.invite',
      approve: (remark = '') => bot.onebot.setGroupAddRequest(flag, subType, true, remark),
      reject: (reason = '') => bot.onebot.setGroupAddRequest(flag, subType, false, reason),
    })
  }

  private handleMeta(frame: OneBotFrame): void {
    if (this.currentBot === undefined || this.currentBot.status !== 'online') {
      return
    }
    const metaEventType = String(frame.meta_event_type ?? '')
    const interval = frame.interval === undefined ? undefined : Number(frame.interval)
    if (metaEventType === 'heartbeat' && interval !== undefined && Number.isFinite(interval)) {
      this.heartbeatPeriod = interval
      this.lastHeartbeatAt = Date.now()
    }
    const event: MetaEvent = {
      id: randomUUID(),
      platform: 'onebot11',
      selfId: this.currentBot.selfId,
      time: eventTime(frame as { time?: unknown }),
      kind: 'meta',
      name: `meta.${metaEventType}`,
      raw: frame,
      bot: this.currentBot,
      metaEventType,
      ...(frame.status && typeof frame.status === 'object'
        ? { status: frame.status as Record<string, unknown> }
        : {}),
      ...(interval === undefined ? {} : { interval }),
    }
    this.host.emit(event)
  }

  private handlePong(): void {
    this.waitingForPong = false
    if (this.pongTimer !== undefined) {
      clearTimeout(this.pongTimer)
      this.pongTimer = undefined
    }
  }

  private startLiveness(): void {
    this.clearLiveness()
    this.pingTimer = setInterval(() => {
      const socket = this.socket
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        return
      }
      if (this.waitingForPong) {
        return
      }
      this.waitingForPong = true
      socket.ping()
      this.pongTimer = setTimeout(() => {
        if (this.waitingForPong) {
          socket.terminate()
        }
      }, this.options.pongTimeout)
    }, this.options.pingInterval)
    this.heartbeatTimer = setInterval(() => {
      if (
        this.heartbeatPeriod !== undefined &&
        this.lastHeartbeatAt !== undefined &&
        Date.now() - this.lastHeartbeatAt > this.heartbeatPeriod * this.options.heartbeatTimeoutMultiplier
      ) {
        this.socket?.terminate()
      }
    }, this.options.heartbeatCheckInterval)
  }

  private clearLiveness(): void {
    for (const timer of [this.pingTimer, this.pongTimer, this.heartbeatTimer]) {
      if (timer !== undefined) {
        clearTimeout(timer)
        clearInterval(timer)
      }
    }
    this.pingTimer = undefined
    this.pongTimer = undefined
    this.heartbeatTimer = undefined
    this.waitingForPong = false
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) {
      return
    }
    this.socket = undefined
    this.connected = false
    this.clearLiveness()
    this.heartbeatPeriod = undefined
    this.lastHeartbeatAt = undefined
    this.pendingEvents.length = 0
    this.rejectPending(new NotConnectedError())
    if (this.currentBot?.usesConnection(this)) {
      this.currentBot.sendQueue.cancel()
      if (this.currentBot.status === 'online') {
        this.currentBot.setStatus('offline')
        this.emitBotOffline(this.currentBot)
      }
    }
    this.currentBot = undefined
    if (!this.stopped) {
      this.onClose()
    }
  }

  private rejectPending(error: Error): void {
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(echo)
      pending.reject(error)
    }
  }

  private emitBotOnline(bot: OneBotBotImpl): void {
    this.host.logger.info(
      { platform: bot.platform, selfId: bot.selfId, ...this.transportLog() },
      'Bot online',
    )
    const event: BotOnlineEvent = {
      id: randomUUID(),
      platform: 'onebot11',
      selfId: bot.selfId,
      time: Date.now(),
      kind: 'internal',
      name: 'bot.online',
      raw: undefined,
      bot,
      status: 'online',
    }
    this.host.emit(event)
  }

  private emitBotOffline(bot: OneBotBotImpl): void {
    this.host.logger.warn(
      { platform: bot.platform, selfId: bot.selfId, ...this.transportLog() },
      this.stopped ? 'Bot offline (stopping)' : 'Bot offline',
    )
    const event: BotOfflineEvent = {
      id: randomUUID(),
      platform: 'onebot11',
      selfId: bot.selfId,
      time: Date.now(),
      kind: 'internal',
      name: 'bot.offline',
      raw: undefined,
      bot,
      status: 'offline',
    }
    this.host.emit(event)
  }

  private log(level: 'debug' | 'warn', object: Record<string, unknown>, message: string): void {
    this.options.logger[level]({ ...this.transportLog(), ...object }, message)
  }

  private transportLog(): Record<string, unknown> {
    return this.transport.connection === 'forward'
      ? { url: sanitizedUrl(this.transport.url) }
      : { selfId: this.transport.selfId, remoteAddress: this.transport.remoteAddress }
  }
}

class OneBotConnection {
  private readonly host: AdapterHost
  private readonly session: OneBotSession
  private readonly config: OneBotConnectionConfig
  private readonly options: ConnectionOptions
  private reconnectTimer: NodeJS.Timeout | undefined
  private stableTimer: NodeJS.Timeout | undefined
  private backoff: number
  private stopped = true

  constructor(
    config: OneBotConnectionConfig,
    host: AdapterHost,
    options: ConnectionOptions,
    adapter: OneBotAdapter,
  ) {
    this.host = host
    this.config = config
    this.options = options
    this.backoff = options.reconnect.minDelay
    this.session = new OneBotSession(
      { connection: 'forward', url: config.url, accessToken: config.accessToken },
      host,
      options,
      adapter,
      () => {
        this.stableTimer = setTimeout(() => {
          this.backoff = this.options.reconnect.minDelay
        }, this.options.stableTime)
      },
      () => {
        if (this.stableTimer !== undefined) clearTimeout(this.stableTimer)
        this.stableTimer = undefined
        this.scheduleReconnect()
      },
    )
  }

  start(): void {
    if (this.stopped) {
      this.stopped = false
      this.connect()
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer)
    this.reconnectTimer = undefined
    this.stableTimer = undefined
    await this.session.stop()
  }

  private connect(): void {
    if (this.stopped) return
    this.host.connection?.update({ state: 'connecting' })
    this.options.logger.debug({ url: sanitizedUrl(this.config.url) }, 'Connecting OneBot forward WebSocket')
    let socket: WebSocket
    try {
      socket = new WebSocket(this.config.url, {
        headers: this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : undefined,
      })
    } catch (error) {
      this.options.logger.warn(
        { reason: errorReason(error, this.config.accessToken), url: sanitizedUrl(this.config.url) },
        'Failed to create OneBot WebSocket',
      )
      this.host.connection?.update({ state: 'retrying', error: errorReason(error, this.config.accessToken) })
      this.scheduleReconnect()
      return
    }
    socket.on('error', (error: Error & { code?: string }) => {
      if (!this.stopped) {
        this.host.connection?.update({
          state: 'retrying',
          error: errorReason(error, this.config.accessToken),
        })
        this.options.logger.warn(
          {
            reason: errorReason(error, this.config.accessToken),
            ...(error.code === undefined ? {} : { code: error.code }),
            url: sanitizedUrl(this.config.url),
          },
          'OneBot WebSocket error',
        )
      }
    })
    this.session.start(socket)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return
    const base = Math.min(
      this.options.reconnect.maxDelay,
      Math.max(this.options.reconnect.minDelay, this.backoff),
    )
    const delay = Math.min(
      this.options.reconnect.maxDelay,
      Math.max(this.options.reconnect.minDelay, Math.round(base * (0.8 + Math.random() * 0.4))),
    )
    this.backoff = Math.min(
      this.options.reconnect.maxDelay,
      Math.max(this.options.reconnect.minDelay, base * 2),
    )
    this.host.connection?.update({ state: 'retrying', nextRetryAt: Date.now() + delay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }
}

function normalizeMessageForEvent(content: Sendable): Message {
  if (typeof content === 'string') {
    return [{ type: 'text', data: { text: content } }]
  }
  return Array.isArray(content) ? [...content] : [content]
}

/** 连接 OneBot 11 正向或反向 WebSocket 并管理机器人实例的适配器。 */
export class OneBotAdapter implements Adapter {
  readonly platform = 'onebot11'
  private connections: OneBotConnection[] = []
  private readonly host: AdapterHost
  private readonly overrides: OneBotAdapterOptions
  private options: ConnectionOptions
  private reverseToken = ''
  private reverseEnabled = false
  private removeUpgrade?: () => void
  private readonly bots = new Map<string, OneBotBotImpl>()
  private readonly reverseSessions = new Map<string, Set<OneBotSession>>()
  private readonly activeReverseSessions = new Set<OneBotSession>()
  private readonly reverseWebsocket = new WebSocketServer({ noServer: true })
  private stopped = true

  constructor(config: OneBot11Config, host: AdapterHost, options: OneBotAdapterOptions = {}) {
    this.host = host
    this.overrides = options
    this.options = this.connectionOptions(config)
    this.configure(config)
  }

  private connectionOptions(settings: OneBot11Config): ConnectionOptions {
    const options = this.overrides
    return {
      logger: options.logger ?? this.host.logger,
      apiTimeout: options.apiTimeout ?? settings.apiTimeout,
      reconnect: options.reconnect ?? settings.reconnect,
      pingInterval: options.pingInterval ?? 30_000,
      pongTimeout: options.pongTimeout ?? 10_000,
      heartbeatTimeoutMultiplier: options.heartbeatTimeoutMultiplier ?? 2.5,
      heartbeatCheckInterval: options.heartbeatCheckInterval ?? 1_000,
      stableTime: options.stableTime ?? 30_000,
      ignoreSelf: options.ignoreSelf ?? true,
      sendQueue: settings.sendQueue,
    }
  }

  private configure(settings: OneBot11Config): void {
    this.options = this.connectionOptions(settings)
    this.reverseToken = settings.reverse.accessToken
    this.reverseEnabled = settings.reverse.enabled
    this.connections = settings.connections.map(
      (connection) => new OneBotConnection(connection, this.host, this.options, this),
    )
    for (const bot of this.bots.values()) {
      bot.sendQueue = new SendQueue(this.options.sendQueue, this.options.logger, bot.selfId)
    }
  }

  private registerReverse(): void {
    this.removeUpgrade = this.host.registerUpgrade('/onebot/v11/ws', (request, socket, head) => {
      if (this.stopped) return this.rejectUpgrade(socket, 503)
      const token = this.reverseToken
      const url = new URL(request.url ?? '/', 'http://localhost')
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
      const queryToken = url.searchParams.get('access_token')
      if (
        token &&
        !(bearer !== undefined && constantTimeEqual(bearer, token)) &&
        !(queryToken !== null && constantTimeEqual(queryToken, token))
      )
        return this.rejectUpgrade(socket, 401)
      const selfId = request.headers['x-self-id']
      if (typeof selfId !== 'string' || !/^\d+$/.test(selfId) || !Number.isSafeInteger(Number(selfId))) {
        return this.rejectUpgrade(socket, 400, 'X-Self-ID must contain only safe integer digits')
      }
      const role = request.headers['x-client-role']
      if (role !== undefined && role !== 'Universal') {
        return this.rejectUpgrade(
          socket,
          400,
          'X-Client-Role must be Universal; split API/Event connections are not supported',
        )
      }
      const remoteAddress = request.socket.remoteAddress ?? 'unknown'
      this.reverseWebsocket.handleUpgrade(request, socket, head, (client) =>
        this.acceptReverse(client, selfId, remoteAddress),
      )
    })
  }

  private rejectUpgrade(socket: Duplex, status: 400 | 401 | 503, detail?: string): void {
    const message = { 400: 'Bad Request', 401: 'Unauthorized', 503: 'Service Unavailable' }[status]
    const payload = JSON.stringify({
      error: {
        code: { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 503: 'UNAVAILABLE' }[status],
        message: detail ?? message,
      },
    })
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
    )
  }

  claim(session: OneBotSession, selfId: string): OneBotBotImpl {
    let bot = this.bots.get(selfId)
    const existingBot = bot
    const reverseSessions = this.reverseSessions.get(selfId)
    const olderReverseSessions: OneBotSession[] = []
    if (session.transport.connection === 'reverse' && reverseSessions !== undefined) {
      for (const previous of reverseSessions) {
        if (previous === session) break
        olderReverseSessions.push(previous)
      }
    }
    if (
      existingBot !== undefined &&
      existingBot.status === 'online' &&
      !existingBot.usesConnection(session) &&
      !olderReverseSessions.some((previous) => existingBot.usesConnection(previous))
    )
      throw new Error(`Bot onebot11:${selfId} is already online on another connection`)
    if (session.transport.connection === 'reverse') {
      for (const previous of olderReverseSessions) {
        this.options.logger.info(
          { selfId, remoteAddress: session.transport.remoteAddress },
          'Replacing OneBot reverse connection',
        )
        void previous.stop('replaced')
      }
    }
    if (bot === undefined) {
      bot = new OneBotBotImpl(session, selfId, this.options)
      this.host.registerBot(bot)
      this.bots.set(selfId, bot)
    } else {
      this.host.registerBot(bot)
      bot.setConnection(session)
    }
    this.host.setBotInfo(bot, session.connectionInfo())
    return bot
  }

  forgetPrevious(session: OneBotSession, bot: OneBotBotImpl): void {
    if (this.bots.get(bot.selfId) === bot && bot.status !== 'online' && bot.usesConnection(session)) {
      this.host.unregisterBot(bot)
      this.bots.delete(bot.selfId)
    }
  }

  private acceptReverse(socket: WebSocket, selfId: string, remoteAddress: string): void {
    if (this.stopped) {
      socket.close(1001, 'server stopping')
      return
    }
    const session = new OneBotSession(
      { connection: 'reverse', selfId, remoteAddress, accessToken: this.reverseToken ?? '' },
      this.host,
      this.options,
      this,
      () => {},
      () => {},
    )
    const sessions = this.reverseSessions.get(selfId) ?? new Set<OneBotSession>()
    sessions.add(session)
    this.reverseSessions.set(selfId, sessions)
    this.activeReverseSessions.add(session)
    this.options.logger.info({ selfId, remoteAddress }, 'OneBot reverse connection accepted')
    socket.on('error', (error: Error) => {
      this.options.logger.warn(
        { selfId, remoteAddress, reason: errorReason(error, this.reverseToken) },
        'OneBot reverse WebSocket error',
      )
    })
    socket.once('close', (code) => {
      sessions.delete(session)
      if (sessions.size === 0) this.reverseSessions.delete(selfId)
      this.activeReverseSessions.delete(session)
      this.options.logger.info({ selfId, remoteAddress, code }, 'OneBot reverse connection closed')
    })
    session.start(socket)
  }

  async start(): Promise<void> {
    if (!this.stopped) {
      return
    }
    this.stopped = false
    if (this.reverseEnabled) {
      this.registerReverse()
      this.host.connection?.update({ state: 'waiting' })
      if (this.reverseToken === '') this.options.logger.warn('反向 WS 未设置 token')
    }
    for (const connection of this.connections) {
      connection.start()
    }
  }

  private async closeReverseConnections(): Promise<void> {
    await Promise.all([...this.activeReverseSessions].map((session) => session.stop()))
  }

  private async closeConnections(): Promise<void> {
    if (this.stopped) {
      return
    }
    this.stopped = true
    this.removeUpgrade?.()
    this.removeUpgrade = undefined
    await Promise.all([
      ...this.connections.map((connection) => connection.stop()),
      this.closeReverseConnections(),
    ])
    this.reverseSessions.clear()
  }

  async reconfigure(config: unknown): Promise<void> {
    const running = !this.stopped
    await this.closeConnections()
    this.configure(config as OneBot11Config)
    if (running) await this.start()
  }

  async stop(): Promise<void> {
    await this.closeConnections()
    for (const bot of this.bots.values()) this.host.unregisterBot(bot)
    this.bots.clear()
  }
}

export type { OneBot11Config, OneBotConnectionConfig } from './types.ts'
