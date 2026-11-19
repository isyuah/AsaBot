import {
  type SendMsgBody,
  type StreamReplyBody,
  type UpdateTemplateCardBody,
  type UploadMediaOptions,
  type WelcomeReplyBody,
  WSAuthFailureError,
  WSClient,
  WSReconnectExhaustedError,
  WsCmd,
} from '@wecom/aibot-node-sdk'
import { z } from 'zod'
import type { MessageTarget } from '../../core/bot.ts'
import type { WecomConfig } from './config.ts'

export type ReplyBody = SendMsgBody | StreamReplyBody | WelcomeReplyBody | UpdateTemplateCardBody
type ReplyCommand = typeof WsCmd.RESPONSE | typeof WsCmd.RESPONSE_WELCOME | typeof WsCmd.RESPONSE_UPDATE
type PushBody = SendMsgBody & { chat_type: 1 | 2 }

export interface WecomHandlers {
  connecting(): void
  ready(): void
  disconnected(): void
  retrying(delay: number): void
  failed(reason: string): void
  message(frame: unknown): void
  event(frame: unknown): void
}

export interface WecomTransport {
  start(handlers: WecomHandlers): void
  close(): void
  send(target: MessageTarget, body: SendMsgBody): Promise<string | undefined>
  reply(reqId: string, body: ReplyBody, command?: ReplyCommand): Promise<string | undefined>
  upload(bytes: Buffer, options: UploadMediaOptions): Promise<string>
}

const sdkLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

const ackSchema = z.object({ errcode: z.number().int() })
const messageAck = z.object({ body: z.object({ msgid: z.string().min(1) }) })
const uploadAck = z.object({ media_id: z.string().min(1) })

async function request<Result>(operation: string, execute: () => Promise<Result>): Promise<Result> {
  try {
    return await execute()
  } catch (error) {
    const ack = ackSchema.safeParse(error)
    if (ack.success) throw new Error(`企业微信${operation}被拒绝（错误码 ${ack.data.errcode}）`)
    throw new Error(`企业微信${operation}失败或等待回执超时`)
  }
}

function acknowledged(frame: unknown): string | undefined {
  const ack = ackSchema.parse(frame)
  if (ack.errcode !== 0) throw ack
  return messageAck.safeParse(frame).data?.body.msgid
}

export class SDKTransport implements WecomTransport {
  readonly #client: WSClient
  readonly #subscribeTimeout: number
  readonly #reconnectInterval: number
  #timer?: NodeJS.Timeout

  constructor(
    config: WecomConfig,
    {
      wsUrl,
      subscribeTimeout = 10_000,
      reconnectInterval = 1_000,
    }: { wsUrl?: string; subscribeTimeout?: number; reconnectInterval?: number } = {},
  ) {
    this.#subscribeTimeout = subscribeTimeout
    this.#reconnectInterval = reconnectInterval
    this.#client = new WSClient({
      botId: config.botId,
      secret: config.secret,
      wsUrl,
      wsOptions: { handshakeTimeout: 10_000, maxPayload: 1024 * 1024 },
      logger: sdkLogger,
      reconnectInterval,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 0,
      maxReplyQueueSize: 32,
    })
  }

  start(handlers: WecomHandlers): void {
    this.#client
      .on('connected', () => {
        handlers.connecting()
        this.#timer = setTimeout(
          () => handlers.failed('企业微信订阅超时，请检查网络后手动重连'),
          this.#subscribeTimeout,
        ).unref()
      })
      .on('authenticated', () => {
        clearTimeout(this.#timer)
        handlers.ready()
      })
      .on('disconnected', () => {
        clearTimeout(this.#timer)
        handlers.disconnected()
      })
      .on('reconnecting', (attempt) =>
        handlers.retrying(Math.min(this.#reconnectInterval * 2 ** (attempt - 1), 30_000)),
      )
      .on('error', (error) => {
        if (error instanceof WSAuthFailureError)
          handlers.failed('企业微信认证失败，请核对 BotID 和 Secret 后手动重连')
        else if (error instanceof WSReconnectExhaustedError)
          handlers.failed('企业微信重连失败，请检查网络后手动重连')
      })
      .on('event.disconnected_event', () =>
        handlers.failed('此 BotID 已在另一实例上线，请停止另一实例后手动重连'),
      )
      .on('message', handlers.message)
      .on('event.enter_chat', handlers.event)
      .on('event.template_card_event', handlers.event)
      .on('event.feedback_event', handlers.event)
      .connect()
  }

  close(): void {
    clearTimeout(this.#timer)
    this.#client.removeAllListeners()
    this.#client.disconnect()
  }

  send(target: MessageTarget, body: SendMsgBody): Promise<string | undefined> {
    const payload: PushBody = { ...body, chat_type: target.type === 'private' ? 1 : 2 }
    return request('主动发送', async () => acknowledged(await this.#client.sendMessage(target.id, payload)))
  }

  reply(reqId: string, body: ReplyBody, command: ReplyCommand = WsCmd.RESPONSE): Promise<string | undefined> {
    return request('回调回复', async () =>
      acknowledged(await this.#client.reply({ headers: { req_id: reqId } }, body, command)),
    )
  }

  upload(bytes: Buffer, options: UploadMediaOptions): Promise<string> {
    return request(
      '上传媒体',
      async () => uploadAck.parse(await this.#client.uploadMedia(bytes, options)).media_id,
    )
  }
}
