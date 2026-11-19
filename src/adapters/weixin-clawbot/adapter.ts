import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Adapter, AdapterHost } from '../../core/adapter.ts'
import { createSession } from '../../core/event/index.ts'
import { LruSet } from '../../core/utils/lru.ts'
import { type ConnectionStore, contextKey, WeixinBot } from './bot.ts'
import {
  type Account,
  accountSchema,
  errorSchema,
  IlinkError,
  type IlinkRequest,
  ilink,
  ilinkOrigin,
  itemSchema,
  platform,
  readInbound,
  updatesSchema,
} from './protocol.ts'

const cursorKey = 'updates'
const expiredMessage = '微信授权已失效，请重新扫码'

interface Running {
  bot: WeixinBot
  controller: AbortController
  poll: Promise<void>
  notifyStop: () => Promise<void>
}

export class WeixinAdapter implements Adapter {
  readonly platform = platform
  private config: Account
  private readonly host: AdapterHost
  private readonly connection: NonNullable<AdapterHost['connection']>
  private running?: Running

  constructor(config: Account, host: AdapterHost) {
    if (!host.connection) throw new Error('微信 ClawBot 需要独立的连接')
    this.connection = host.connection
    this.config = config
    this.host = host
  }

  async start(): Promise<void> {
    if (this.running) return
    const { selfId, token, apiBaseUrl } = this.config
    const origin = ilinkOrigin(apiBaseUrl)
    const controller = new AbortController()
    const { signal } = controller
    const store = this.connection.store
    const cursor = store.get<string>(cursorKey) ?? ''
    let expired = false
    const request: IlinkRequest = async (operation, schema, data, timeout, operationSignal) => {
      try {
        return await ilink(
          new URL(`/ilink/bot/${operation}`, origin),
          operation,
          schema,
          operationSignal ? AbortSignal.any([signal, operationSignal]) : signal,
          { data, token, timeout },
        )
      } catch (error) {
        if (!signal.aborted && error instanceof IlinkError && error.expired) {
          expired = true
          controller.abort()
          bot.setStatus('offline')
          this.connection.update({ state: 'reauthorize', error: expiredMessage, nextRetryAt: undefined })
        }
        throw error
      }
    }
    const bot = new WeixinBot(selfId, this.host, store, request, signal)
    this.host.registerBot(bot)
    this.host.setBotInfo(bot, { connection: 'iLink HTTPS 长轮询' })
    this.connection.update({ state: 'connecting' })
    this.running = {
      bot,
      controller,
      poll: this.poll(bot, store, request, signal, cursor),
      notifyStop: async () => {
        if (!expired)
          await this.notify('notifystop', bot, () =>
            ilink(
              new URL('/ilink/bot/msg/notifystop', origin),
              '停止通知',
              errorSchema,
              AbortSignal.timeout(2000),
              { data: {}, token, timeout: 2000 },
            ),
          )
      },
    }
  }

  async stop(): Promise<void> {
    const running = this.running
    if (!running) return
    running.controller.abort()
    running.bot.setStatus('offline')
    try {
      await running.poll
      await running.notifyStop()
    } finally {
      this.host.unregisterBot(running.bot)
      this.running = undefined
    }
  }

  async reconfigure(config: unknown): Promise<void> {
    const next = accountSchema.parse(config)
    await this.stop()
    this.config = next
    await this.start()
  }

  private async poll(
    bot: WeixinBot,
    store: ConnectionStore,
    request: IlinkRequest,
    signal: AbortSignal,
    initialCursor: string,
  ): Promise<void> {
    await this.notify('notifystart', bot, () => request('msg/notifystart', errorSchema, {}, 3000), signal)
    let cursor = initialCursor
    let timeout = 40_000
    let failures = 0
    const seen = new LruSet<string>(2048)
    while (!signal.aborted) {
      const startedAt = Date.now()
      let delay: number
      try {
        const updates = await request('getupdates', updatesSchema, { get_updates_buf: cursor }, timeout)
        if (signal.aborted) return
        bot.setStatus('online')
        for (const payload of updates.msgs ?? []) this.receive(bot, store, seen, payload)
        if (updates.get_updates_buf && updates.get_updates_buf !== cursor) {
          store.set(cursorKey, updates.get_updates_buf)
          cursor = updates.get_updates_buf
        }
        if (updates.longpolling_timeout_ms) timeout = Math.min(updates.longpolling_timeout_ms + 5000, 120_000)
        failures = 0
        delay = Math.max(0, 250 - (Date.now() - startedAt))
      } catch (error) {
        if (signal.aborted) return
        bot.setStatus('offline')
        const reason =
          error instanceof IlinkError
            ? error.message
            : error instanceof DOMException && error.name === 'TimeoutError'
              ? '微信长轮询超时'
              : '微信消息同步失败'
        delay = Math.min(1000 * 2 ** failures++, 30_000)
        this.connection.update({ state: 'retrying', error: reason, nextRetryAt: Date.now() + delay })
        this.host.logger.warn({ selfId: bot.selfId, reason }, 'Weixin ClawBot polling failed')
      }
      if (delay) {
        try {
          await sleep(delay, undefined, { signal, ref: false })
        } catch (error) {
          if (!signal.aborted) throw error
        }
      }
    }
  }

  private async notify(
    operation: string,
    bot: WeixinBot,
    send: () => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await send()
    } catch {
      if (!signal?.aborted)
        this.host.logger.debug(
          { selfId: bot.selfId, operation },
          'Weixin ClawBot lifecycle notification failed',
        )
    }
  }

  private receive(bot: WeixinBot, store: ConnectionStore, seen: LruSet<string>, payload: unknown): void {
    const inbound = readInbound(payload)
    const userId = inbound?.from_user_id
    if (!userId || (this.host.ignoreSelf && userId === bot.selfId)) return
    const items = (inbound.item_list ?? []).flatMap((item) => {
      const parsed = itemSchema.safeParse(item)
      return parsed.success ? [parsed.data] : []
    })
    const messageId = inbound.message_id ?? items.find((item) => item.msg_id)?.msg_id ?? randomUUID()
    const key = JSON.stringify([userId, messageId])
    if (seen.has(key)) return
    if (inbound.context_token) store.set(contextKey(userId), inbound.context_token)
    const message = bot.incoming(userId, messageId, items)
    if (message.length) {
      const actor = { platform, selfId: bot.selfId, userId }
      this.host.emit(
        createSession(
          {
            ...actor,
            id: randomUUID(),
            bot,
            time: inbound.create_time_ms || Date.now(),
            raw: undefined,
            messageId,
            messageType: 'private',
            message,
            sender: { userId, nickname: userId },
            isSuperuser: this.host.isSuperuser(actor),
            isBotAdmin: this.host.isBotAdmin(actor),
          },
          this.host.sessionServices,
        ),
      )
    }
    seen.add(key)
  }
}
