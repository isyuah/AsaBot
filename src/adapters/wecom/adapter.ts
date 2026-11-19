import { randomUUID } from 'node:crypto'
import type { Adapter, AdapterHost } from '../../core/adapter.ts'
import { createSession } from '../../core/event/index.ts'
import { LruSet } from '../../core/utils/lru.ts'
import { WecomBotImpl } from './bot.ts'
import { platform, type WecomConfig, wecomSchema } from './config.ts'
import {
  eventFrame,
  type WecomCardActionEvent,
  type WecomEnterChatEvent,
  type WecomFeedbackEvent,
} from './events.ts'
import { incoming, messageFrame } from './message.ts'
import { SDKTransport, type WecomTransport } from './transport.ts'

interface Running {
  bot: WecomBotImpl
  transport: WecomTransport
  shutdown: AbortController
  seen: LruSet<string>
}

export interface WecomAdapterOptions {
  createTransport?: (config: WecomConfig) => WecomTransport
}

const messageWindow = 24 * 60 * 60_000
const eventWindow = 5_000

export class WecomAdapter implements Adapter {
  readonly platform = platform
  readonly #host: AdapterHost
  readonly #options: WecomAdapterOptions
  #config: WecomConfig
  #running?: Running

  constructor(config: WecomConfig, host: AdapterHost, options: WecomAdapterOptions = {}) {
    this.#config = config
    this.#host = host
    this.#options = options
  }

  async start(): Promise<void> {
    if (this.#running) return
    const config = this.#config
    const host = this.#host
    const transport = this.#options.createTransport?.(config) ?? new SDKTransport(config)
    const shutdown = new AbortController()
    const bot = new WecomBotImpl(config, host, transport, shutdown.signal)
    const running = { bot, transport, shutdown, seen: new LruSet<string>(8192) }
    const current = () => this.#running === running && !shutdown.signal.aborted
    const log = host.logger.child({ platform, selfId: bot.selfId })
    host.registerBot(bot)
    this.#running = running
    host.setBotInfo(bot, { connection: '企业微信 WebSocket 长连接' })
    host.connection?.update({ state: 'connecting', nextRetryAt: undefined })
    transport.start({
      connecting: () => {
        if (!current()) return
        bot.setStatus('connecting')
        host.connection?.update({ state: 'connecting', nextRetryAt: undefined })
      },
      ready: () => {
        if (!current()) return
        bot.setStatus('online')
        host.connection?.update({ state: 'online' })
        log.info('企业微信认证成功')
      },
      disconnected: () => {
        if (current()) bot.setStatus('offline')
      },
      retrying: (delay) => {
        if (!current()) return
        const reason = '企业微信长连接中断，正在重连'
        host.connection?.update({ state: 'retrying', error: reason, nextRetryAt: Date.now() + delay })
        log.warn({ retryIn: delay }, reason)
      },
      failed: (reason) => {
        if (!current()) return
        shutdown.abort()
        transport.close()
        bot.setStatus('offline')
        host.connection?.update({ state: 'error', error: reason, nextRetryAt: undefined })
        log.warn(reason)
      },
      message: (frame) => {
        if (current() && bot.status === 'online') this.#message(running, frame, config.botName)
      },
      event: (frame) => {
        if (current() && bot.status === 'online') this.#event(running, frame)
      },
    })
  }

  async stop(): Promise<void> {
    const running = this.#running
    if (!running) return
    this.#running = undefined
    running.shutdown.abort()
    running.transport.close()
    running.bot.setStatus('offline')
    this.#host.unregisterBot(running.bot)
  }

  async reconfigure(config: unknown): Promise<void> {
    const next = wecomSchema.parse(config)
    await this.stop()
    this.#config = next
    await this.start()
  }

  #message(running: Running, frame: unknown, botName?: string): void {
    const receivedAt = Date.now()
    const parsed = messageFrame.safeParse(frame)
    if (!parsed.success) {
      this.#host.logger.debug({ platform }, '忽略无效或不支持的企业微信消息')
      return
    }
    const { body, headers } = parsed.data
    if (!this.#accept(running, body)) return
    const { bot } = running
    const actor = { platform, selfId: bot.selfId, userId: body.from.userid }
    const channel =
      body.chattype === 'group'
        ? { messageType: 'group' as const, groupId: body.chatid }
        : { messageType: 'private' as const }
    const message = incoming(body, bot.media, receivedAt, botName)
    if (!message.length) return
    const session = createSession(
      {
        ...actor,
        ...channel,
        id: randomUUID(),
        bot,
        time: body.create_time ? body.create_time * 1000 : receivedAt,
        raw: undefined,
        messageId: body.msgid,
        message,
        sender: { userId: actor.userId, nickname: actor.userId },
        isSuperuser: this.#host.isSuperuser(actor),
        isBotAdmin: this.#host.isBotAdmin(actor),
      },
      this.#host.sessionServices,
    )
    const target = { type: session.messageType, id: session.groupId ?? session.userId }
    this.#host.emit(
      bot.bindSession(session, { target, reqId: headers.req_id, deadline: receivedAt + messageWindow }),
    )
  }

  #event(running: Running, frame: unknown): void {
    const receivedAt = Date.now()
    const parsed = eventFrame.safeParse(frame)
    if (!parsed.success) {
      this.#host.logger.debug({ platform }, '忽略无效或不支持的企业微信事件')
      return
    }
    const { body, headers } = parsed.data
    if (!this.#accept(running, body)) return
    const { event, from } = body
    const { bot } = running
    const group = body.chattype === 'group'
    const target = {
      platform,
      selfId: bot.selfId,
      type: group ? ('group' as const) : ('private' as const),
      id: group ? body.chatid : from.userid,
    }
    const callback = { target, reqId: headers.req_id, deadline: receivedAt + eventWindow }
    const common = {
      id: randomUUID(),
      platform,
      selfId: bot.selfId,
      bot,
      raw: undefined,
      kind: 'notice',
      target,
      time: body.create_time ? body.create_time * 1000 : receivedAt,
      userId: from.userid,
      corpId: from.corpid,
      ...(group && { groupId: body.chatid }),
      messageId: body.msgid,
    } as const
    switch (event.eventtype) {
      case 'enter_chat': {
        if (group) return
        const notice: WecomEnterChatEvent = {
          ...common,
          name: 'notice.wecom.enter_chat',
          platformType: event.eventtype,
          replyWelcome: bot.welcome(callback),
        }
        this.#host.emit(notice)
        return
      }
      case 'template_card_event': {
        const data = event.template_card_event
        const notice: WecomCardActionEvent = {
          ...common,
          name: 'notice.wecom.card.action',
          platformType: event.eventtype,
          cardType: data.card_type,
          eventKey: data.event_key,
          taskId: data.task_id,
          selectedItems: (data.selected_items?.selected_item ?? []).map((item) => ({
            questionKey: item.question_key,
            optionIds: item.option_ids.option_id,
          })),
          updateCard: bot.cardUpdate(callback, data.task_id),
        }
        this.#host.emit(notice)
        return
      }
      case 'feedback_event': {
        const data = event.feedback_event
        const notice: WecomFeedbackEvent = {
          ...common,
          name: 'notice.wecom.feedback',
          platformType: event.eventtype,
          feedbackId: data.id,
          feedbackType: data.type,
          content: data.content,
          inaccurateReasons: data.inaccurate_reason_list,
        }
        this.#host.emit(notice)
      }
    }
  }

  #accept(
    { bot, seen }: Running,
    body: { aibotid: string; from: { userid: string }; msgid: string; compat_info?: unknown },
  ): boolean {
    if (
      body.aibotid !== bot.selfId ||
      body.compat_info !== undefined ||
      (this.#host.ignoreSelf && body.from.userid === bot.selfId) ||
      seen.has(body.msgid)
    )
      return false
    seen.add(body.msgid)
    return true
  }
}
