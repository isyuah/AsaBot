import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AdapterHost } from '../../core/adapter.ts'
import type { Bot, BotCapabilities, SendResult } from '../../core/bot.ts'
import { dispatchContext } from '../../core/dispatch/trace.ts'
import { ConversationUnavailableError, NotConnectedError, UnsupportedError } from '../../core/errors.ts'
import { isSegment, normalizeSendable, type Segment, type Sendable, seg } from '../../core/message/index.ts'
import { WeixinMedia } from './media.ts'
import { WeixinMessages } from './message.ts'
import { errorSchema, type IlinkRequest, platform, sentSchema, typingSchema } from './protocol.ts'

export const weixinCapabilities: BotCapabilities = {
  segments: ['text', 'image', 'video', 'file'],
  textStyles: [],
  actions: ['sendPrivate', 'getSelf', 'weixin-clawbot.downloadMedia', 'weixin-clawbot.setTyping'],
}

const maxText = 4000
const formatSchema = z.enum(['original', 'wav']).default('original')
const downloadArgs = z.tuple([z.string().min(1), formatSchema])
const typingArgs = z.tuple([z.string().regex(/^\S+$/).max(512), z.boolean()])
export type ConnectionStore = NonNullable<AdapterHost['connection']>['store']
export const contextKey = (userId: string) => `context:${userId}`

function* splitText(text: string) {
  let offset = 0
  let part = ''
  for (const point of text) {
    if (offset + point.length > maxText) {
      yield part
      offset = 0
      part = ''
    }
    part += point
    offset += point.length
  }
  if (part) yield part
}

export class WeixinBot implements Bot {
  readonly platform = platform
  readonly capabilities = weixinCapabilities
  readonly selfId: string
  #status: Bot['status'] = 'connecting'
  readonly #host: AdapterHost
  readonly #request: IlinkRequest
  readonly #store: ConnectionStore
  readonly #media: WeixinMedia
  readonly #messages: WeixinMessages
  readonly #tickets = new Map<string, { ticket: string; expiresAt: number; context: string }>()

  constructor(
    selfId: string,
    host: AdapterHost,
    store: ConnectionStore,
    request: IlinkRequest,
    signal: AbortSignal,
  ) {
    this.selfId = selfId
    this.#host = host
    this.#store = store
    this.#request = request
    this.#media = new WeixinMedia(signal)
    this.#messages = new WeixinMessages(this.#media)
  }

  readonly weixin = {
    downloadMedia: async (file: string, format: 'original' | 'wav' = 'original'): Promise<Buffer> => {
      const result = await this.#host.invokeApi(
        { bot: this, method: 'weixin-clawbot.downloadMedia', args: [file, format] },
        async (args) => {
          const [handle, output] = downloadArgs.parse(args)
          return this.#media.download(handle, output)
        },
      )
      if (!Buffer.isBuffer(result)) throw new TypeError('媒体下载必须返回 Buffer')
      return result
    },
    setTyping: async (userId: string, typing = true): Promise<void> => {
      await this.#host.invokeApi(
        { bot: this, method: 'weixin-clawbot.setTyping', args: [userId, typing] },
        async (args) => {
          const [peer, active] = typingArgs.parse(args)
          await this.#setTyping(peer, active)
        },
      )
    },
  }

  incoming(...args: Parameters<WeixinMessages['incoming']>) {
    return this.#messages.incoming(...args)
  }

  get status(): Bot['status'] {
    return this.#status
  }

  setStatus(status: 'online' | 'offline'): void {
    if (this.#status === status) return
    this.#status = status
    const fields = {
      id: randomUUID(),
      platform,
      selfId: this.selfId,
      time: Date.now(),
      raw: undefined,
      kind: 'internal' as const,
      bot: this,
    }
    this.#host.emit(
      status === 'online'
        ? { ...fields, name: 'bot.online', status }
        : { ...fields, name: 'bot.offline', status },
    )
  }

  async sendPrivate(userId: string, content: Sendable): Promise<SendResult> {
    this.#assertOnline()
    const prepared = await this.#host.prepareOutgoing({
      bot: this,
      target: { type: 'private', id: userId },
      message: normalizeSendable(content),
    })
    if (!Array.isArray(prepared)) return prepared.sent
    const contextToken = this.#context(userId)
    let last: SendResult | undefined
    for (const segment of prepared) {
      if (isSegment(segment, 'text')) {
        for (const text of splitText(segment.data.text)) {
          last = await this.#deliver(userId, contextToken, { type: 1, text_item: { text } }, seg.text(text))
        }
      } else if (isSegment(segment, 'image') || isSegment(segment, 'video') || isSegment(segment, 'file')) {
        const uploaded = await this.#media.upload(userId, segment, this.#request)
        last = await this.#deliver(userId, contextToken, uploaded.item, uploaded.segment)
      }
    }
    if (!last) throw new Error('没有可发送的消息内容')
    return last
  }

  async #deliver(userId: string, contextToken: string, item: object, segment: Segment): Promise<SendResult> {
    const clientId = randomUUID()
    const response = await this.#request('sendmessage', sentSchema, {
      msg: {
        from_user_id: '',
        to_user_id: userId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [item],
      },
    })
    const messageId = response.message_id ?? clientId
    this.#messages.remember(userId, messageId, [segment])
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
      messageType: 'private',
      userId,
      ...(context?.active.value && { eventId: context.eventId }),
      message: [segment],
    })
    return { messageId }
  }

  async #setTyping(userId: string, active: boolean): Promise<void> {
    this.#assertOnline()
    const context = this.#context(userId)
    const previous = this.#tickets.get(userId)
    let ticket: string
    if (previous && previous.expiresAt > Date.now() && (!active || previous.context === context)) {
      ticket = previous.ticket
    } else {
      const result = await this.#request(
        'getconfig',
        typingSchema,
        { ilink_user_id: userId, context_token: context },
        10_000,
      )
      ticket = result.typing_ticket
      this.#tickets.delete(userId)
      this.#tickets.set(userId, { ticket, context, expiresAt: Date.now() + 60_000 })
      const first = this.#tickets.keys().next()
      if (this.#tickets.size > 256 && !first.done) this.#tickets.delete(first.value)
    }
    await this.#request(
      'sendtyping',
      errorSchema,
      { ilink_user_id: userId, typing_ticket: ticket, status: active ? 1 : 2 },
      10_000,
    )
  }

  #assertOnline(): void {
    if (this.#status !== 'online') throw new NotConnectedError('微信 ClawBot 未上线')
  }

  #context(userId: string): string {
    const token = this.#store.get<string>(contextKey(userId))
    if (!token) throw new ConversationUnavailableError('请先让对方给这台微信 ClawBot 发送一条消息')
    return token
  }

  async getSelf() {
    return { userId: this.selfId, nickname: this.selfId }
  }

  async sendGroup(): Promise<never> {
    return this.#unsupported('sendGroup')
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

export function isWeixinClawBot(bot: Bot): bot is WeixinBot {
  return bot instanceof WeixinBot
}
