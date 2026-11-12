import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import type { Message, Sendable } from '../core/message/index.ts'

export interface MockCall {
  action: string
  params: Record<string, unknown>
  echo?: string
}

export interface MockOneBotOptions {
  token?: string
  accessToken?: string
  userId?: string
  nickname?: string
  heartbeat?: boolean
  heartbeatInterval?: number
  respondToPing?: boolean
}

export interface MockReverseOptions {
  token?: string
  selfId?: string
  role?: string | null
}

export type MockCallHandler = (params: Record<string, unknown>, call: MockCall) => unknown | Promise<unknown>

interface Waiter {
  action: string
  predicate?: (call: MockCall) => boolean
  resolve: (call: MockCall) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class MockOneBot {
  readonly calls: MockCall[] = []
  readonly ready: Promise<void>
  connectionAttempts = 0
  private readonly server: WebSocketServer
  private readonly clients = new Set<WebSocket>()
  private readonly handlers = new Map<string, Set<MockCallHandler>>()
  private readonly waiters = new Set<Waiter>()
  private readonly token: string | undefined
  private readonly userId: string
  private readonly nickname: string
  private readonly heartbeatInterval: number
  private readonly respondToPing: boolean
  private heartbeatTimer: NodeJS.Timeout | undefined
  private nextMessageId = 1
  private listening = false

  constructor(options: MockOneBotOptions = {}) {
    this.token = options.token ?? options.accessToken
    this.userId = options.userId ?? '10000'
    this.nickname = options.nickname ?? 'MockBot'
    this.heartbeatInterval = options.heartbeatInterval ?? 1_000
    this.respondToPing = options.respondToPing ?? true
    this.server = new WebSocketServer({
      port: 0,
      clientTracking: true,
      autoPong: this.respondToPing,
      verifyClient: (
        info: { req: IncomingMessage },
        callback: (accepted: boolean, code?: number, message?: string) => void,
      ) => {
        this.connectionAttempts += 1
        const authorization = info.req.headers.authorization
        const expected = this.token === undefined ? undefined : `Bearer ${this.token}`
        if (expected !== undefined && authorization !== expected) {
          callback(false, 401, 'Unauthorized')
          return
        }
        callback(true)
      },
    })
    this.ready = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.listening = true
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
    })
    this.server.on('connection', (socket) => this.handleConnection(socket))
    if (options.heartbeat) {
      this.setHeartbeat(true)
    }
  }

  get connectionCount(): number {
    return this.clients.size
  }

  get url(): string {
    const address = this.server.address()
    if (address !== null && typeof address === 'object') {
      return `ws://127.0.0.1:${(address as AddressInfo).port}`
    }
    return 'ws://127.0.0.1:0'
  }

  connectReverse(url: string, options: MockReverseOptions = {}): Promise<WebSocket> {
    const token = options.token ?? this.token
    const socket = new WebSocket(url, {
      autoPong: this.respondToPing,
      headers: {
        'X-Self-ID': options.selfId ?? this.userId,
        ...(options.role === null ? {} : { 'X-Client-Role': options.role ?? 'Universal' }),
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
    })
    return new Promise((resolve, reject) => {
      socket.once('open', () => {
        this.handleConnection(socket)
        resolve(socket)
      })
      socket.on('error', reject)
    })
  }

  onCall(action: string, handler: MockCallHandler): () => void {
    const handlers = this.handlers.get(action) ?? new Set<MockCallHandler>()
    handlers.add(handler)
    this.handlers.set(action, handlers)
    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) {
        this.handlers.delete(action)
      }
    }
  }

  waitForCall(
    action: string,
    predicate?: ((call: MockCall) => boolean) | number,
    timeout = 2_000,
  ): Promise<MockCall> {
    const actualPredicate = typeof predicate === 'function' ? predicate : undefined
    const actualTimeout = typeof predicate === 'number' ? predicate : timeout
    const existing = this.calls.find((call) => call.action === action && (actualPredicate?.(call) ?? true))
    if (existing !== undefined) {
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        action,
        predicate: actualPredicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          reject(new Error(`Timed out waiting for MockOneBot call ${action}`))
        }, actualTimeout),
      }
      this.waiters.add(waiter)
    })
  }

  emitGroupMessage(input: {
    groupId: string
    userId: string
    message: string | Message
    role?: 'owner' | 'admin' | 'member'
    nickname?: string
    card?: string
  }): void {
    this.push({
      time: Math.floor(Date.now() / 1_000),
      self_id: Number(this.userId),
      post_type: 'message',
      message_type: 'group',
      message_id: this.nextMessageId++,
      group_id: Number(input.groupId),
      user_id: Number(input.userId),
      message:
        typeof input.message === 'string' ? [{ type: 'text', data: { text: input.message } }] : input.message,
      raw_message: typeof input.message === 'string' ? input.message : undefined,
      sender: {
        user_id: Number(input.userId),
        nickname: input.nickname ?? input.userId,
        ...(input.card === undefined ? {} : { card: input.card }),
        ...(input.role === undefined ? {} : { role: input.role }),
      },
    })
  }

  emitPrivateMessage(input: { userId: string; message: string | Message; nickname?: string }): void {
    this.push({
      time: Math.floor(Date.now() / 1_000),
      self_id: Number(this.userId),
      post_type: 'message',
      message_type: 'private',
      message_id: this.nextMessageId++,
      user_id: Number(input.userId),
      message:
        typeof input.message === 'string' ? [{ type: 'text', data: { text: input.message } }] : input.message,
      raw_message: typeof input.message === 'string' ? input.message : undefined,
      sender: { user_id: Number(input.userId), nickname: input.nickname ?? input.userId },
    })
  }

  emitNotice(raw: Record<string, unknown>): void {
    this.push({ ...raw, post_type: 'notice' })
  }

  push(raw: Record<string, unknown>): void {
    const payload = JSON.stringify(raw)
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    }
  }

  dropConnections(): void {
    for (const client of this.clients) {
      client.terminate()
    }
  }

  setHeartbeat(enabled: boolean | 'on' | 'off'): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (enabled === true || enabled === 'on') {
      this.heartbeatTimer = setInterval(() => {
        this.push({
          time: Math.floor(Date.now() / 1_000),
          self_id: Number(this.userId),
          post_type: 'meta_event',
          meta_event_type: 'heartbeat',
          interval: this.heartbeatInterval,
          status: { online: true, good: true },
        })
      }, this.heartbeatInterval)
    }
  }

  async close(): Promise<void> {
    this.setHeartbeat(false)
    await this.ready
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('MockOneBot closed'))
    }
    this.waiters.clear()
    for (const client of this.clients) {
      client.close(1000, 'shutdown')
      client.terminate()
    }
    this.clients.clear()
    if (!this.listening) {
      return
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        this.listening = false
        resolve()
      })
    })
  }

  private handleConnection(socket: WebSocket): void {
    this.clients.add(socket)
    socket.on('close', () => this.clients.delete(socket))
    socket.on('message', (data) => {
      void this.handleRequest(socket, data.toString())
    })
    socket.send(
      JSON.stringify({
        time: Math.floor(Date.now() / 1_000),
        self_id: Number(this.userId),
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: 'connect',
      }),
    )
  }

  private async handleRequest(socket: WebSocket, source: string): Promise<void> {
    let request: { action?: string; params?: Record<string, unknown>; echo?: string }
    try {
      request = JSON.parse(source) as typeof request
    } catch {
      return
    }
    if (typeof request.action !== 'string') {
      return
    }
    const call: MockCall = { action: request.action, params: request.params ?? {}, echo: request.echo }
    this.calls.push(call)
    for (const waiter of [...this.waiters]) {
      if (waiter.action === call.action && (waiter.predicate?.(call) ?? true)) {
        clearTimeout(waiter.timer)
        this.waiters.delete(waiter)
        waiter.resolve(call)
      }
    }
    const handlers = this.handlers.get(call.action)
    let data: unknown
    try {
      if (handlers !== undefined && handlers.size > 0) {
        const handler = [...handlers].at(-1)
        data = await handler?.(call.params, call)
      } else {
        data = this.defaultResponse(call)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ status: 'failed', retcode: 1, wording: message, echo: call.echo }))
      }
      return
    }
    if (socket.readyState === WebSocket.OPEN) {
      if (data !== null && typeof data === 'object' && ('status' in data || 'retcode' in data)) {
        socket.send(JSON.stringify({ ...(data as Record<string, unknown>), echo: call.echo }))
      } else {
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: call.echo }))
      }
    }
  }

  private defaultResponse(call: MockCall): unknown {
    switch (call.action) {
      case 'get_login_info':
        return { user_id: Number(this.userId), nickname: this.nickname }
      case 'get_version_info':
        return { app_name: 'MockOneBot', app_version: '1', protocol_version: 'v11' }
      case 'get_msg':
        return {
          message_id: call.params.message_id,
          time: Math.floor(Date.now() / 1_000),
          sender: { user_id: Number(this.userId), nickname: this.nickname },
          message: [],
        }
      case 'send_group_msg':
      case 'send_private_msg':
      case 'send_group_forward_msg':
      case 'send_private_forward_msg':
        return { message_id: this.nextMessageId++ }
      case 'get_friend_list':
      case 'get_group_list':
      case 'get_group_member_list':
        return []
      case 'get_stranger_info':
        return { user_id: call.params.user_id, nickname: String(call.params.user_id) }
      case 'get_group_info':
        return { group_id: call.params.group_id, group_name: String(call.params.group_id) }
      case 'get_group_member_info':
        return {
          group_id: call.params.group_id,
          user_id: call.params.user_id,
          nickname: String(call.params.user_id),
          role: 'member',
        }
      default:
        return {}
    }
  }
}

export type { Message, Sendable }
