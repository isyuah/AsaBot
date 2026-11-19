import { randomUUID } from 'node:crypto'
import { type ReplyFeedback, type StreamReplyBody, type WelcomeReplyBody, WsCmd } from '@wecom/aibot-node-sdk'
import { z } from 'zod'
import type { AdapterHost } from '../../core/adapter.ts'
import type { Bot, BotCapabilities, MessageTarget, SendResult } from '../../core/bot.ts'
import { dispatchContext } from '../../core/dispatch/trace.ts'
import { NotConnectedError, UnsupportedError } from '../../core/errors.ts'
import type { Session } from '../../core/event/index.ts'
import { type Message, normalizeSendable, type Sendable, seg } from '../../core/message/index.ts'
import { cardForSend, cardSchema, feedbackIdSchema, type WecomTemplateCard, wecom } from './cards.ts'
import { platform, type WecomConfig } from './config.ts'
import { WecomMedia } from './media.ts'
import { contentText, outgoing } from './message.ts'
import type { ReplyBody, WecomTransport } from './transport.ts'

export const wecomCapabilities: BotCapabilities = {
  segments: ['text', 'markdown', 'image', 'audio', 'video', 'file', 'wecom:card'],
  textStyles: [],
  actions: [
    'sendPrivate',
    'sendGroup',
    'getSelf',
    'wecom.reply',
    'wecom.downloadMedia',
    'wecom.stream.update',
    'wecom.stream.finish',
    'wecom.replyWelcome',
    'wecom.updateCard',
  ],
}

const segment = z.object({ type: z.string().min(1), data: z.record(z.string(), z.unknown()) })
const sendable = z.union([z.string(), segment, z.array(segment)])
const sendResult = z.object({ messageId: z.string().min(1) })
const welcome = z.union([contentText, cardSchema])
const cardUpdate = z.tuple([cardSchema, z.array(z.string().min(1)).optional()])

export interface WecomStream {
  readonly id: string
  update(content: string): Promise<void>
  finish(content: string): Promise<SendResult>
}

export interface WecomBot extends Bot {
  readonly platform: typeof platform
  readonly wecom: { downloadMedia(handle: string): Promise<Buffer> }
}

export interface WecomSession extends Session {
  readonly platform: typeof platform
  readonly bot: WecomBot
  readonly wecom: { createStream(options?: { feedbackId?: string }): WecomStream }
}

export interface WecomCallback {
  reqId: string
  target: MessageTarget
  deadline: number
}

export class WecomBotImpl implements WecomBot {
  readonly platform = platform
  readonly capabilities = wecomCapabilities
  readonly selfId: string
  readonly nickname?: string
  readonly #host: AdapterHost
  readonly #transport: WecomTransport
  readonly #shutdown: AbortSignal
  readonly #media: WecomMedia
  #status: Bot['status'] = 'connecting'

  constructor(config: WecomConfig, host: AdapterHost, transport: WecomTransport, shutdown: AbortSignal) {
    this.selfId = config.botId
    this.nickname = config.botName
    this.#host = host
    this.#transport = transport
    this.#shutdown = shutdown
    this.#media = new WecomMedia(shutdown)
  }

  get media(): WecomMedia {
    return this.#media
  }

  readonly wecom = {
    downloadMedia: async (handle: string): Promise<Buffer> => {
      const output = await this.#host.invokeApi(
        { bot: this, method: 'wecom.downloadMedia', args: [handle] },
        async ([value]) => this.#media.download(z.string().min(1).parse(value)),
      )
      if (!Buffer.isBuffer(output)) throw new TypeError('媒体下载必须返回 Buffer')
      return output
    },
  }

  get status(): Bot['status'] {
    return this.#status
  }

  setStatus(status: Bot['status']): void {
    if (status === this.#status) return
    const previous = this.#status
    this.#status = status
    if (status !== 'online' && previous !== 'online') return
    const event = {
      id: randomUUID(),
      kind: 'internal' as const,
      platform,
      selfId: this.selfId,
      time: Date.now(),
      raw: undefined,
      bot: this,
    }
    this.#host.emit(
      status === 'online'
        ? { ...event, name: 'bot.online', status }
        : { ...event, name: 'bot.offline', status: 'offline' },
    )
  }

  bindSession(session: Session, callback: WecomCallback): WecomSession {
    const proactiveReply = session.reply
    const binding: Pick<WecomSession, 'platform' | 'bot' | 'wecom' | 'reply'> = {
      platform: this.platform,
      bot: this,
      wecom: {
        createStream: (options?: { feedbackId?: string }) =>
          this.#createStream(callback, options?.feedbackId),
      },
      reply: (content: Sendable, options: { quote?: boolean; at?: boolean } = {}) => {
        if (options.quote === false) return proactiveReply(content, options)
        const message = normalizeSendable(content)
        if (options.at && session.groupId) message.unshift(seg.at(session.userId))
        return this.#reply(callback, message)
      },
    }
    return Object.assign(session, binding)
  }

  welcome(callback: WecomCallback): (content: string | WecomTemplateCard) => Promise<SendResult> {
    const consume = this.#oneShot(callback)
    return (content) =>
      this.#invokeSend('wecom.replyWelcome', [content], async ([value]) => {
        const parsed = welcome.parse(value)
        const input = typeof parsed === 'string' ? parsed : cardForSend(parsed)
        const body: WelcomeReplyBody =
          typeof input === 'string'
            ? { msgtype: 'text', text: { content: input } }
            : { msgtype: 'template_card', template_card: input }
        consume()
        const id = await this.#respond(callback, body, WsCmd.RESPONSE_WELCOME)
        return this.#record(
          callback.target,
          [typeof input === 'string' ? seg.text(input) : wecom.card(input)],
          id,
        )
      })
  }

  cardUpdate(
    callback: WecomCallback,
    taskId: string,
  ): (card: WecomTemplateCard, userIds?: string[]) => Promise<SendResult> {
    const consume = this.#oneShot(callback)
    return (card, userIds) =>
      this.#invokeSend('wecom.updateCard', [card, userIds], async (args) => {
        const [input, users] = cardUpdate.parse(args)
        const template = { ...input, task_id: taskId }
        consume()
        const id = await this.#respond(
          callback,
          {
            response_type: 'update_template_card',
            template_card: template,
            ...(users?.length ? { userids: users } : {}),
          },
          WsCmd.RESPONSE_UPDATE,
        )
        return this.#record(callback.target, [wecom.card(template)], id)
      })
  }

  sendPrivate(userId: string, content: Sendable): Promise<SendResult> {
    return this.#send({ type: 'private', id: userId }, content)
  }

  sendGroup(groupId: string, content: Sendable): Promise<SendResult> {
    return this.#send({ type: 'group', id: groupId }, content)
  }

  async getSelf() {
    return { userId: this.selfId, nickname: this.nickname ?? this.selfId }
  }

  #reply(callback: WecomCallback, content: Sendable): Promise<SendResult> {
    return this.#invokeSend('wecom.reply', [content], async ([value]) =>
      this.#send(callback.target, sendable.parse(value), callback),
    )
  }

  async #invokeSend(
    method: string,
    args: unknown[],
    execute: (args: unknown[]) => Promise<SendResult>,
  ): Promise<SendResult> {
    return sendResult.parse(await this.#host.invokeApi({ bot: this, method, args }, execute))
  }

  async #send(target: MessageTarget, content: Sendable, callback?: WecomCallback): Promise<SendResult> {
    this.#assertOnline()
    if (callback) this.#assertCallback(callback)
    const prepared = await this.#host.prepareOutgoing({
      bot: this,
      target,
      message: normalizeSendable(content),
      ...(callback && { sendPart: (part: Sendable) => this.#reply(callback, part) }),
    })
    if (!Array.isArray(prepared)) return prepared.sent
    let sent: SendResult | undefined
    for (const part of outgoing(prepared)) {
      this.#assertOnline()
      if (callback) this.#assertCallback(callback)
      const { body, message } = 'media' in part ? await this.#media.upload(part.media, this.#transport) : part
      this.#assertOnline()
      const id = callback ? await this.#respond(callback, body) : await this.#transport.send(target, body)
      sent = this.#record(target, message, id)
    }
    if (!sent) throw new Error('没有可发送的企业微信消息内容')
    return sent
  }

  #createStream(callback: WecomCallback, feedbackId?: string): WecomStream {
    this.#assertOnline()
    this.#assertCallback(callback)
    const id = randomUUID()
    const feedback: ReplyFeedback | undefined =
      feedbackId === undefined ? undefined : { id: feedbackIdSchema.parse(feedbackId) }
    let startedAt: number | undefined
    let busy = false
    let finished = false
    const send = async (content: unknown, finish: boolean) => {
      const text = contentText.parse(content)
      if (busy) throw new Error('请等待企业微信上一帧流式回复完成')
      if (finished) throw new Error('企业微信流式回复已结束')
      const now = Date.now()
      if (startedAt !== undefined && now >= startedAt + 10 * 60_000)
        throw new Error('企业微信流式回复已超过 10 分钟')
      this.#assertOnline()
      this.#assertCallback(callback)
      const body: StreamReplyBody = {
        msgtype: 'stream',
        stream: { id, content: text, finish, ...(startedAt === undefined && feedback && { feedback }) },
      }
      busy = true
      startedAt ??= now
      try {
        const messageId = await this.#respond(callback, body)
        if (finish) finished = true
        return { text, messageId }
      } finally {
        busy = false
      }
    }
    return {
      id,
      update: async (content) => {
        await this.#host.invokeApi({ bot: this, method: 'wecom.stream.update', args: [content] }, ([value]) =>
          send(value, false),
        )
      },
      finish: (content) =>
        this.#invokeSend('wecom.stream.finish', [content], async ([value]) => {
          const { text, messageId } = await send(value, true)
          return this.#record(callback.target, [seg.markdown(text)], messageId)
        }),
    }
  }

  #oneShot(callback: WecomCallback): () => void {
    let used = false
    return () => {
      this.#assertOnline()
      this.#assertCallback(callback)
      if (used) throw new Error('此企业微信事件已回复')
      used = true
    }
  }

  #respond(
    callback: WecomCallback,
    body: ReplyBody,
    command?: Parameters<WecomTransport['reply']>[2],
  ): Promise<string | undefined> {
    this.#assertOnline()
    this.#assertCallback(callback)
    return this.#transport.reply(callback.reqId, body, command)
  }

  #assertCallback(callback: WecomCallback): void {
    if (Date.now() >= callback.deadline) throw new Error('企业微信回调回复已超时')
  }

  #assertOnline(): void {
    if (this.#status !== 'online') throw new NotConnectedError('企业微信未上线')
  }

  #record(target: MessageTarget, message: Message, messageId = `wecom-local:${randomUUID()}`): SendResult {
    this.#shutdown.throwIfAborted()
    const context = dispatchContext.getStore()
    this.#host.emit({
      id: randomUUID(),
      kind: 'internal',
      name: 'bot.message.sent',
      time: Date.now(),
      raw: undefined,
      bot: this,
      platform,
      selfId: this.selfId,
      messageId,
      messageType: target.type,
      ...(target.type === 'group' ? { groupId: target.id } : { userId: target.id }),
      ...(context?.active.value && { eventId: context.eventId }),
      message,
    })
    return { messageId }
  }

  async sendForward(): Promise<never> {
    return this.#unsupported('sendForward')
  }
  async getForward(): Promise<never> {
    return this.#unsupported('getForward')
  }
  async deleteMessage(): Promise<never> {
    return this.#unsupported('deleteMessage')
  }
  async getMessage(): Promise<never> {
    return this.#unsupported('getMessage')
  }
  async getGroupList(): Promise<never> {
    return this.#unsupported('getGroupList')
  }
  async getGroupMember(): Promise<never> {
    return this.#unsupported('getGroupMember')
  }
  async getGroupMembers(): Promise<never> {
    return this.#unsupported('getGroupMembers')
  }
  async muteMember(): Promise<never> {
    return this.#unsupported('muteMember')
  }
  async kickMember(): Promise<never> {
    return this.#unsupported('kickMember')
  }
  async setMemberCard(): Promise<never> {
    return this.#unsupported('setMemberCard')
  }
  async getFriendList(): Promise<never> {
    return this.#unsupported('getFriendList')
  }
  async call(action: string): Promise<never> {
    return this.#unsupported(action)
  }

  #unsupported(action: string): never {
    throw new UnsupportedError(platform, action)
  }
}

export function isWecomBot(bot: Bot): bot is WecomBot {
  return bot instanceof WecomBotImpl
}

export function isWecomSession(session: Session): session is WecomSession {
  return isWecomBot(session.bot) && 'wecom' in session
}
