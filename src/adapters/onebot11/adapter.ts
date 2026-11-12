import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import WebSocket, { type RawData } from 'ws'
import type { Adapter, AdapterHost } from '../../core/adapter.ts'
import type {
  GroupInfo,
  GroupMemberInfo,
  OneBotApi,
  OneBotBot,
  SendResult,
  UserInfo,
} from '../../core/bot.ts'
import { ApiError, ApiTimeoutError, NotConnectedError } from '../../core/errors.ts'
import type {
  BotOfflineEvent,
  BotOnlineEvent,
  MessageSentEvent,
  MetaEvent,
  NoticeEvent,
  RequestEvent,
  Session,
} from '../../core/event/index.ts'
import { createSession } from '../../core/event/index.ts'
import type { Message, Sendable } from '../../core/message/index.ts'
import { LruSet } from '../../core/utils/lru.ts'
import { OneBotApiImpl } from './api.ts'
import { incomingMessage } from './message.ts'
import type { OneBot11Config, OneBotConnectionConfig, OneBotFrame, OneBotMessageEvent } from './types.ts'

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
}

function sanitizedUrl(source: string): string {
  try {
    const url = new URL(source)
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase() === 'access_token') {
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
  let result = text.replace(/access_token=[^&\s]*/gi, 'access_token=[Redacted]')
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

class OneBotBotImpl implements OneBotBot {
  readonly platform = 'onebot11'
  readonly onebot: OneBotApi
  readonly sentMessageIds = new LruSet<string>(1_000)
  private currentStatus: 'connecting' | 'online' | 'offline' = 'connecting'
  readonly selfId: string
  private readonly connection: OneBotConnection

  constructor(connection: OneBotConnection, selfId: string) {
    this.connection = connection
    this.selfId = selfId
    this.onebot = new OneBotApiImpl((action, params) => connection.requestForBot(this, action, params), {
      assertOnline: () => connection.assertOnline(this),
      onMessageSent: (input) => {
        this.sentMessageIds.add(input.messageId)
        connection.emitMessageSent(this, input)
      },
    })
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

  getFriendList(): Promise<UserInfo[]> {
    return this.onebot.getFriendList()
  }

  call(action: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.connection.requestForBot(this, action, params)
  }
}

class OneBotConnection {
  private socket: WebSocket | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private pingTimer: NodeJS.Timeout | undefined
  private pongTimer: NodeJS.Timeout | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private stableTimer: NodeJS.Timeout | undefined
  private readonly pending = new Map<string, PendingRequest>()
  private stopped = true
  private connected = false
  private echo = 0
  private backoff: number
  private heartbeatPeriod: number | undefined
  private lastHeartbeatAt: number | undefined
  private waitingForPong = false
  private currentBot: OneBotBotImpl | undefined
  private readonly pendingEvents: OneBotFrame[] = []
  private readonly config: OneBotConnectionConfig
  private readonly host: AdapterHost
  private readonly options: ConnectionOptions

  constructor(config: OneBotConnectionConfig, host: AdapterHost, options: ConnectionOptions) {
    this.config = config
    this.host = host
    this.options = options
    this.backoff = options.reconnect.minDelay
  }

  start(): void {
    if (!this.stopped) {
      return
    }
    this.stopped = false
    this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearReconnect()
    this.clearLiveness()
    this.pendingEvents.length = 0
    this.rejectPending(new NotConnectedError('OneBot connection stopped'))
    const socket = this.socket
    this.socket = undefined
    this.connected = false
    if (socket !== undefined) {
      if (socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => socket.terminate(), 1_000)
          socket.once('close', () => {
            clearTimeout(timer)
            resolve()
          })
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1000, 'shutdown')
          } else {
            socket.terminate()
          }
        })
      }
    }
    if (this.currentBot !== undefined) {
      const bot = this.currentBot
      if (bot.status === 'online') {
        bot.setStatus('offline')
        this.emitBotOffline(bot)
      }
      this.host.unregisterBot(bot)
    }
  }

  async requestForBot(
    bot: OneBotBotImpl,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.assertOnline(bot)
    return this.request(action, params)
  }

  assertOnline(bot: OneBotBotImpl): void {
    if (
      this.currentBot !== bot ||
      bot.status !== 'online' ||
      !this.connected ||
      this.socket?.readyState !== WebSocket.OPEN
    ) {
      throw new NotConnectedError()
    }
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
      name: 'message.sent',
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

  private connect(): void {
    if (this.stopped) {
      return
    }
    this.clearReconnect()
    this.log('debug', { url: sanitizedUrl(this.config.url) }, 'Connecting OneBot forward WebSocket')
    let socket: WebSocket
    try {
      socket = new WebSocket(this.config.url, {
        headers: this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : undefined,
      })
    } catch (error) {
      this.log(
        'warn',
        { reason: errorReason(error, this.config.accessToken), url: sanitizedUrl(this.config.url) },
        'Failed to create OneBot WebSocket',
      )
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.on('open', () => this.handleOpen(socket))
    socket.on('message', (data) => this.handleMessage(data))
    socket.on('pong', () => this.handlePong())
    socket.on('error', (error: Error & { code?: string }) => {
      if (!this.stopped) {
        this.log(
          'warn',
          {
            reason: errorReason(error, this.config.accessToken),
            ...(error.code === undefined ? {} : { code: error.code }),
            url: sanitizedUrl(this.config.url),
          },
          'OneBot WebSocket error',
        )
      }
    })
    socket.on('close', () => this.handleClose(socket))
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
      if (this.currentBot !== undefined && this.currentBot.selfId !== selfId) {
        const previous = this.currentBot
        if (previous.status === 'online') {
          previous.setStatus('offline')
          this.emitBotOffline(previous)
        }
        this.host.unregisterBot(previous)
        this.currentBot = undefined
      }
      if (this.currentBot === undefined) {
        this.currentBot = new OneBotBotImpl(this, selfId)
      }
      const bot = this.currentBot
      this.host.registerBot(bot)
      bot.setStatus('online')
      this.emitBotOnline(bot)
      for (const frame of this.pendingEvents.splice(0)) {
        this.handleEvent(frame)
      }
      this.stableTimer = setTimeout(() => {
        this.backoff = this.options.reconnect.minDelay
      }, this.options.stableTime)
    } catch (error) {
      if (this.stopped || this.socket !== socket) {
        return
      }
      this.log('warn', { reason: errorReason(error, this.config.accessToken) }, 'OneBot login failed')
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
    const session = createSession({
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
      isSuperuser: this.host.isSuperuser(userId),
      sentMessageIds: bot.sentMessageIds,
    })
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
    if (this.currentBot === undefined || this.currentBot.status !== 'online') {
      return
    }
    const noticeType = String(frame.notice_type ?? '')
    const subType = frame.sub_type === undefined ? undefined : String(frame.sub_type)
    const requiredFields: Record<string, string[]> = {
      group_increase: ['group_id', 'user_id', 'operator_id'],
      group_decrease: ['group_id', 'user_id', 'operator_id'],
      group_recall: ['group_id', 'user_id', 'operator_id', 'message_id'],
      friend_recall: ['user_id', 'message_id'],
      group_ban: ['group_id', 'user_id', 'operator_id', 'duration'],
      group_admin: ['group_id', 'user_id'],
    }
    const validSubtypes: Record<string, string[]> = {
      group_increase: ['approve', 'invite'],
      group_decrease: ['leave', 'kick', 'kick_me'],
      group_ban: ['ban', 'lift_ban'],
      group_admin: ['set', 'unset'],
    }
    if (
      !noticeType ||
      requiredFields[noticeType]?.some((key) => frame[key] === undefined || frame[key] === null) ||
      (validSubtypes[noticeType] !== undefined && !validSubtypes[noticeType].includes(subType ?? '')) ||
      (noticeType === 'notify' && subType === 'poke' && (frame.user_id == null || frame.target_id == null))
    ) {
      this.log('warn', { noticeType, subType }, 'Ignoring malformed OneBot notice')
      return
    }
    const name = `notice.${noticeType}${subType ? `.${subType}` : ''}`
    const event: NoticeEvent = {
      id: randomUUID(),
      platform: 'onebot11',
      selfId: this.currentBot.selfId,
      time: eventTime(frame as { time?: unknown }),
      kind: 'notice',
      name,
      raw: frame,
      bot: this.currentBot,
      noticeType,
      ...(subType === undefined ? {} : { subType }),
      ...(frame.user_id === undefined ? {} : { userId: platformId(frame.user_id) }),
      ...(frame.group_id === undefined ? {} : { groupId: platformId(frame.group_id) }),
      ...(frame.operator_id === undefined ? {} : { operatorId: platformId(frame.operator_id) }),
      ...(frame.message_id === undefined ? {} : { messageId: platformId(frame.message_id) }),
      ...(frame.target_id === undefined ? {} : { targetId: platformId(frame.target_id) }),
      ...(frame.duration === undefined ? {} : { duration: Number(frame.duration) }),
    } as NoticeEvent
    this.host.emit(event)
  }

  private handleRequest(frame: OneBotFrame): void {
    const bot = this.currentBot
    if (bot === undefined || bot.status !== 'online') {
      return
    }
    if (
      (frame.request_type !== 'friend' && frame.request_type !== 'group') ||
      (frame.request_type === 'group' && frame.sub_type !== 'add' && frame.sub_type !== 'invite') ||
      frame.user_id === undefined ||
      typeof frame.flag !== 'string'
    ) {
      this.log('warn', {}, 'Ignoring malformed OneBot request')
      return
    }
    const requestType = frame.request_type
    const subType = frame.sub_type === 'add' || frame.sub_type === 'invite' ? frame.sub_type : undefined
    const flag = frame.flag
    const event: RequestEvent = {
      id: randomUUID(),
      platform: 'onebot11',
      selfId: bot.selfId,
      time: eventTime(frame as { time?: unknown }),
      kind: 'request',
      name: `request.${requestType}${subType ? `.${subType}` : ''}`,
      raw: frame,
      bot,
      requestType,
      ...(subType === undefined ? {} : { subType }),
      userId: platformId(frame.user_id),
      ...(frame.group_id === undefined ? {} : { groupId: platformId(frame.group_id) }),
      comment: String(frame.comment ?? ''),
      flag,
      approve: (remark = '') =>
        requestType === 'friend'
          ? bot.onebot.setFriendAddRequest(flag, true, remark)
          : bot.onebot.setGroupAddRequest(flag, subType as 'add' | 'invite', true, remark),
      reject: (reason = '') =>
        requestType === 'friend'
          ? bot.onebot.setFriendAddRequest(flag, false)
          : bot.onebot.setGroupAddRequest(flag, subType as 'add' | 'invite', false, reason),
    }
    this.host.emit(event)
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
    for (const timer of [this.pingTimer, this.pongTimer, this.heartbeatTimer, this.stableTimer]) {
      if (timer !== undefined) {
        clearTimeout(timer)
        clearInterval(timer)
      }
    }
    this.pingTimer = undefined
    this.pongTimer = undefined
    this.heartbeatTimer = undefined
    this.stableTimer = undefined
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
    if (this.currentBot !== undefined && this.currentBot.status === 'online') {
      this.currentBot.setStatus('offline')
      this.emitBotOffline(this.currentBot)
    }
    if (!this.stopped) {
      this.scheduleReconnect()
    }
  }

  private rejectPending(error: Error): void {
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(echo)
      pending.reject(error)
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) {
      return
    }
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  private emitBotOnline(bot: OneBotBotImpl): void {
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
    this.options.logger[level](object, message)
  }
}

function normalizeMessageForEvent(content: Sendable): Message {
  if (typeof content === 'string') {
    return [{ type: 'text', data: { text: content } }]
  }
  return Array.isArray(content) ? [...content] : [content]
}

export class OneBotAdapter implements Adapter {
  readonly platform = 'onebot11'
  private readonly connections: OneBotConnection[]
  private stopped = true

  constructor(
    config: OneBot11Config | OneBotConnectionConfig[],
    host: AdapterHost,
    options: OneBotAdapterOptions = {},
  ) {
    const settings = Array.isArray(config)
      ? { connections: config, apiTimeout: 30_000, reconnect: { minDelay: 1_000, maxDelay: 60_000 } }
      : config
    const connectionOptions: ConnectionOptions = {
      logger: options.logger ?? host.logger,
      apiTimeout: options.apiTimeout ?? settings.apiTimeout,
      reconnect: options.reconnect ?? settings.reconnect,
      pingInterval: options.pingInterval ?? 30_000,
      pongTimeout: options.pongTimeout ?? 10_000,
      heartbeatTimeoutMultiplier: options.heartbeatTimeoutMultiplier ?? 2.5,
      heartbeatCheckInterval: options.heartbeatCheckInterval ?? 1_000,
      stableTime: options.stableTime ?? 30_000,
      ignoreSelf: options.ignoreSelf ?? true,
    }
    this.connections = settings.connections.map(
      (connection) => new OneBotConnection(connection, host, connectionOptions),
    )
  }

  async start(): Promise<void> {
    if (!this.stopped) {
      return
    }
    this.stopped = false
    for (const connection of this.connections) {
      connection.start()
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return
    }
    this.stopped = true
    for (const connection of this.connections) {
      await connection.stop()
    }
  }
}

export type { OneBot11Config, OneBotConnectionConfig } from './types.ts'
