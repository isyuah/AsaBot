import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Adapter, AdapterHost } from '../../core/adapter.ts'
import { createSession } from '../../core/event/index.ts'
import { seg } from '../../core/message/index.ts'
import { redactText } from '../../core/utils/redact.ts'
import { FeishuBotImpl } from './bot.ts'
import { cardResponseSchema, type FeishuCardActionEvent, type FeishuCardResponse } from './cards.ts'
import { type FeishuAccountConfig, type FeishuConfig, feishuSchema } from './config.ts'
import type { FeishuChatUpdatedEvent, FeishuMessageReadEvent, FeishuReactionEvent } from './events.ts'
import { incomingMessage, mentionSchema, threadFields, threadOf } from './message.ts'
import {
  type FeishuEventHandlers,
  type FeishuLifecycle,
  type FeishuTransport,
  SDKTransport,
} from './transport.ts'

export interface FeishuAdapterOptions {
  createTransport?: (account: FeishuAccountConfig, lifecycle: FeishuLifecycle) => FeishuTransport
}

const baseSchema = z.object({ event_id: z.string().min(1), create_time: z.string().optional() })
const userId = z.object({ open_id: z.string().min(1) })
const reactionEventSchema = baseSchema
  .extend({
    message_id: z.string().min(1),
    reaction_type: z.object({ emoji_type: z.string().min(1) }),
    action_time: z.coerce.number().int().positive(),
  })
  .and(
    z.discriminatedUnion('operator_type', [
      z.object({ operator_type: z.literal('user'), user_id: userId }),
      z.object({ operator_type: z.literal('app'), app_id: z.string().min(1) }),
    ]),
  )
const changeSchema = z.record(z.string(), z.unknown()).optional()
const chatUpdatedSchema = baseSchema.extend({
  chat_id: z.string().min(1),
  operator_id: userId.partial().optional(),
  before_change: changeSchema,
  after_change: changeSchema,
})
const messageReadSchema = baseSchema.extend({
  reader: z.object({ reader_id: userId, read_time: z.coerce.number().int().positive() }),
  message_id_list: z.array(z.string().min(1)).min(1),
})
const messageEvent = baseSchema.extend({
  sender: z.object({ sender_id: userId, sender_type: z.string() }),
  message: threadFields.extend({
    chat_id: z.string(),
    chat_type: z.enum(['p2p', 'group']),
    message_type: z.string(),
    content: z.string(),
    create_time: z.string(),
    mentions: z.array(mentionSchema).default([]),
  }),
})

const cardEventSchema = baseSchema.extend({
  host: z.literal('im_message'),
  operator: z.object({ open_id: z.string().min(1) }),
  context: z.object({ open_message_id: z.string().min(1), open_chat_id: z.string().min(1) }),
  action: z
    .object({
      tag: z.string(),
      name: z.string().optional(),
      value: z.record(z.string(), z.unknown()).default({}),
      input_value: z.string().optional(),
      option: z.string().optional(),
      options: z.array(z.string()).optional(),
      form_value: z.record(z.string(), z.unknown()).optional(),
      timezone: z.string().optional(),
    })
    .passthrough(),
})

class Account {
  readonly config: FeishuAccountConfig
  private readonly settings: FeishuConfig
  private readonly host: AdapterHost
  private readonly options: FeishuAdapterOptions
  private transport?: FeishuTransport
  private bot?: FeishuBotImpl
  private closed = false
  private reconnect?: NodeJS.Timeout
  private failures = 0
  private readonly seen = new Map<string, { expires: number; result: Promise<unknown> }>()
  private readonly messages = new Map<string, { userId: string; groupId?: string }>()
  private readonly cardResponses = new Set<() => void>()

  constructor(
    config: FeishuAccountConfig,
    settings: FeishuConfig,
    host: AdapterHost,
    options: FeishuAdapterOptions,
  ) {
    this.config = config
    this.settings = settings
    this.host = host
    this.options = options
  }

  async start(): Promise<void> {
    if (this.closed) return
    this.host.logger.info(
      { platform: 'feishu', appId: this.config.appId },
      'Connecting Feishu long connection',
    )
    this.host.connection?.update({ state: 'connecting' })
    const lifecycle: FeishuLifecycle = {
      ready: () => {
        if (this.transport !== transport || this.closed) return
        this.failures = 0
        clearTimeout(this.reconnect)
        this.reconnect = undefined
        this.status('online')
        this.host.connection?.update({ state: 'online' })
      },
      reconnecting: () => {
        if (this.transport === transport && !this.closed) {
          this.host.logger.info(
            { platform: 'feishu', appId: this.config.appId, selfId: this.bot?.selfId },
            'Reconnecting Feishu long connection',
          )
          this.status('connecting')
          this.host.connection?.update({ state: 'connecting' })
        }
      },
      error: (error) => {
        if (this.transport !== transport || this.closed) return
        this.status('offline')
        this.recover(error)
      },
    }
    const transport =
      this.options.createTransport?.(this.config, lifecycle) ??
      new SDKTransport(this.config, this.settings, lifecycle, this.host.logger)
    this.transport = transport
    try {
      const response = z
        .object({
          code: z.number(),
          msg: z.string().optional(),
          bot: z
            .object({
              open_id: z.string(),
              app_name: z.string().default(''),
              avatar_url: z.string().optional(),
            })
            .optional(),
        })
        .parse(await transport.request('GET', '/bot/v3/info/'))
      if (response.code !== 0 || !response.bot)
        throw new Error(`Feishu bot info ${response.code}: ${response.msg ?? 'missing bot identity'}`)
      if (this.closed || this.transport !== transport) return
      this.bot = new FeishuBotImpl(
        this.host,
        transport,
        { userId: response.bot.open_id, nickname: response.bot.app_name, avatar: response.bot.avatar_url },
        this.settings,
        this.config.appSecret,
      )
      this.host.registerBot(this.bot)
      this.host.setBotInfo(this.bot, { connection: 'long-connection' })
      await transport.start(this.handlers(this.bot))
    } catch (error) {
      if (this.closed || this.transport !== transport) return
      this.status('offline')
      this.recover(error)
    }
  }

  private recover(error: unknown): void {
    this.host.logger.warn(
      {
        platform: 'feishu',
        appId: this.config.appId,
        reason: redactText(error instanceof Error ? error.message : String(error), this.config),
      },
      'Feishu connection failed; retrying',
    )
    if (this.reconnect) return
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(6, this.failures++))
    this.host.connection?.update({
      state: 'retrying',
      error: redactText(error instanceof Error ? error.message : String(error), this.config),
      nextRetryAt: Date.now() + delay,
    })
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined
      this.disconnect()
      void this.start()
    }, delay)
    this.reconnect.unref()
  }

  private status(state: 'online' | 'offline' | 'connecting'): void {
    const bot = this.bot
    if (!bot || state === bot.status) return
    const previous = bot.status
    bot.status = state
    if (state === 'online' || previous === 'online') {
      const fields = { platform: 'feishu', appId: this.config.appId, selfId: bot.selfId }
      if (state === 'online') this.host.logger.info(fields, 'Feishu bot online')
      else if (this.closed) this.host.logger.info(fields, 'Feishu bot offline (stopping)')
      else this.host.logger.warn(fields, 'Feishu bot offline')
      const common = {
        id: randomUUID(),
        platform: 'feishu',
        selfId: bot.selfId,
        time: Date.now(),
        kind: 'internal' as const,
        raw: undefined,
        bot,
      }
      this.host.emit(
        state === 'online'
          ? { ...common, name: 'bot.online', status: 'online' }
          : { ...common, name: 'bot.offline', status: 'offline' },
      )
    }
  }

  private disconnect(): void {
    this.status('offline')
    const transport = this.transport
    this.transport = undefined
    transport?.close()
    if (this.bot) {
      this.bot.shutdown.abort()
      this.host.unregisterBot(this.bot)
      this.bot = undefined
    }
  }

  stop(): void {
    this.closed = true
    for (const cancel of this.cardResponses) cancel()
    clearTimeout(this.reconnect)
    this.disconnect()
    this.seen.clear()
  }

  private handlers(bot: FeishuBotImpl): FeishuEventHandlers {
    const guard =
      (type: string, handler: (raw: unknown) => Promise<unknown>): ((raw: unknown) => Promise<unknown>) =>
      async (raw) => {
        if (this.closed || this.bot !== bot) return {}
        try {
          const event = baseSchema.parse(raw)
          this.host.logger.debug(
            { platform: 'feishu', selfId: bot.selfId, event: type, eventId: event.event_id },
            'Feishu event received',
          )
          const now = Date.now()
          for (const [key, entry] of this.seen) {
            if (entry.expires > now) break
            this.seen.delete(key)
          }
          const key = `${type}:${event.event_id}`
          const cached = this.seen.get(key)
          if (cached) return await cached.result
          const result = handler(raw)
          this.seen.set(key, { expires: now + this.settings.dedupTtl, result })
          while (this.seen.size > this.settings.dedupCapacity)
            this.seen.delete(this.seen.keys().next().value as string)
          try {
            return await result
          } catch (error) {
            this.seen.delete(key)
            throw error
          }
        } catch (error) {
          this.host.logger.warn(
            {
              platform: 'feishu',
              appId: this.config.appId,
              event: type,
              reason: redactText(error instanceof Error ? error.message : String(error), this.config),
            },
            'Feishu event rejected',
          )
          return {}
        }
      }
    const base = (raw: unknown) => {
      const event = baseSchema.parse(raw)
      const timestamp = Number(event.create_time)
      return {
        id: event.event_id,
        platform: 'feishu',
        selfId: bot.selfId,
        time:
          Number.isFinite(timestamp) && timestamp > 0
            ? Math.trunc(timestamp >= 1e15 ? timestamp / 1000 : timestamp)
            : Date.now(),
        raw,
        bot,
        kind: 'notice' as const,
      }
    }
    const handlers: FeishuEventHandlers = {}
    handlers['im.message.receive_v1'] = guard('im.message.receive_v1', async (raw) => {
      const event = messageEvent.parse(raw)
      const user = event.sender.sender_id.open_id
      if (this.host.ignoreSelf && (user === bot.selfId || bot.sentMessageIds.has(event.message.message_id)))
        return {}
      const message = event.message
      const groupId = message.chat_type === 'group' ? message.chat_id : undefined
      const channel =
        message.chat_type === 'group'
          ? { messageType: 'group' as const, groupId: message.chat_id }
          : { messageType: 'private' as const }
      const thread = threadOf(message)
      const sender = await bot.resolveSender(user, groupId)
      if (this.closed || this.bot !== bot) return {}
      this.messages.set(message.message_id, { userId: user, ...(groupId ? { groupId } : {}) })
      while (this.messages.size > 1000) this.messages.delete(this.messages.keys().next().value as string)
      const session = createSession(
        {
          ...base(raw),
          ...channel,
          messageId: message.message_id,
          userId: user,
          thread,
          time: z.coerce.number().finite().positive().parse(message.create_time),
          message: incomingMessage(
            message.message_type,
            message.content,
            message.mentions.flatMap((mention) => {
              const id = mention.id?.open_id || (mention.key === '@_all' ? 'all' : undefined)
              return id ? [{ key: mention.key, id }] : []
            }),
            message.parent_id,
            message.message_id,
          ),
          sender,
          isSuperuser: this.host.isSuperuser({ platform: 'feishu', selfId: bot.selfId, userId: user }),
          isBotAdmin: this.host.isBotAdmin({ platform: 'feishu', selfId: bot.selfId, userId: user }),
          sentMessageIds: bot.sentMessageIds,
        },
        this.host.sessionServices,
      )
      bot.rememberConversation(session.messageId, session.target)
      this.host.logger.info(
        {
          platform: 'feishu',
          selfId: bot.selfId,
          eventId: session.id,
          messageId: session.messageId,
          messageType: session.messageType,
          userId: user,
          ...(groupId ? { groupId } : {}),
          ...(thread ? { threadId: thread.id } : {}),
          isBotAdmin: session.isBotAdmin,
          isSuperuser: session.isSuperuser,
          preview: [...redactText(session.text, this.config)].slice(0, 200).join(''),
        },
        'Feishu message received',
      )
      this.host.emit(session)
      return {}
    })
    for (const [type, join] of [
      ['im.chat.member.user.added_v1', true],
      ['im.chat.member.user.deleted_v1', false],
    ] as const)
      handlers[type] = guard(type, async (raw) => {
        const event = baseSchema
          .extend({
            chat_id: z.string(),
            operator_id: userId.optional(),
            users: z.array(z.object({ user_id: userId })),
          })
          .parse(raw)
        for (const user of event.users) {
          const common = {
            ...base(raw),
            id: `${event.event_id}:${user.user_id.open_id}`,
            groupId: event.chat_id,
            userId: user.user_id.open_id,
            ...(event.operator_id ? { operatorId: event.operator_id.open_id } : {}),
          }
          this.host.emit(
            join
              ? { ...common, name: 'notice.member.join', joinType: 'unknown' }
              : { ...common, name: 'notice.member.leave', reason: 'unknown' },
          )
        }
        return {}
      })
    for (const [type, name] of [
      ['im.message.reaction.created_v1', 'notice.feishu.reaction.added'],
      ['im.message.reaction.deleted_v1', 'notice.feishu.reaction.removed'],
    ] as const) {
      handlers[type] = guard(type, async (raw) => {
        const event = reactionEventSchema.parse(raw)
        if (this.host.ignoreSelf && event.operator_type === 'app' && event.app_id === this.config.appId)
          return {}
        const channel = await bot.resolveConversation(event.message_id)
        if (this.closed || this.bot !== bot) return {}
        const actor =
          event.operator_type === 'user'
            ? { operatorType: 'user' as const, userId: event.user_id.open_id }
            : { operatorType: 'app' as const, operatorAppId: event.app_id }
        const notice: FeishuReactionEvent = {
          ...base(raw),
          name,
          platformType: type,
          ...(channel.groupId === undefined ? {} : { groupId: channel.groupId }),
          ...(channel.thread ? { thread: channel.thread } : {}),
          ...actor,
          time: event.action_time,
          messageId: event.message_id,
          emoji: event.reaction_type.emoji_type,
        }
        this.host.emit(notice)
        return {}
      })
    }
    handlers['im.chat.updated_v1'] = guard('im.chat.updated_v1', async (raw) => {
      const event = chatUpdatedSchema.parse(raw)
      bot.invalidateChat(event.chat_id)
      const notice: FeishuChatUpdatedEvent = {
        ...base(raw),
        name: 'notice.feishu.chat.updated',
        platformType: 'im.chat.updated_v1',
        groupId: event.chat_id,
        ...(event.operator_id?.open_id ? { operatorId: event.operator_id.open_id } : {}),
        ...(event.before_change ? { before: event.before_change } : {}),
        ...(event.after_change ? { after: event.after_change } : {}),
      }
      this.host.emit(notice)
      return {}
    })
    handlers['im.message.message_read_v1'] = guard('im.message.message_read_v1', async (raw) => {
      const event = messageReadSchema.parse(raw)
      const notice: FeishuMessageReadEvent = {
        ...base(raw),
        name: 'notice.feishu.message.read',
        platformType: 'im.message.message_read_v1',
        userId: event.reader.reader_id.open_id,
        time: event.reader.read_time,
        messageIds: event.message_id_list,
      }
      this.host.emit(notice)
      return {}
    })
    for (const [type, name] of [
      ['im.chat.member.bot.added_v1', 'notice.feishu.bot.added'],
      ['im.chat.member.bot.deleted_v1', 'notice.feishu.bot.removed'],
    ] as const)
      handlers[type] = guard(type, async (raw) => {
        const event = baseSchema.extend({ chat_id: z.string(), operator_id: userId.optional() }).parse(raw)
        this.host.emit({
          ...base(raw),
          name,
          platformType: type,
          groupId: event.chat_id,
          userId: bot.selfId,
          ...(event.operator_id ? { operatorId: event.operator_id.open_id } : {}),
        })
        return {}
      })
    handlers['im.message.recalled_v1'] = guard('im.message.recalled_v1', async (raw) => {
      const event = baseSchema.extend({ message_id: z.string(), chat_id: z.string() }).parse(raw)
      const source = this.messages.get(event.message_id)
      if (source)
        this.host.emit({
          ...base(raw),
          ...source,
          name: 'notice.message.recall',
          messageId: event.message_id,
        })
      else {
        const channel = await bot.resolveChannel(event.chat_id)
        if (this.closed || this.bot !== bot) return {}
        const notice = {
          ...base(raw),
          ...(channel.messageType === 'group' ? { groupId: channel.groupId } : {}),
          name: 'notice.feishu.message.recall' as const,
          platformType: 'im.message.recalled_v1',
          messageId: event.message_id,
        }
        this.host.emit(notice)
      }
      return {}
    })
    handlers['card.action.trigger'] = guard('card.action.trigger', (raw) => this.cardAction(bot, raw))
    return handlers
  }

  private cardAction(bot: FeishuBotImpl, raw: unknown): Promise<FeishuCardResponse> {
    const source = cardEventSchema.parse(raw)
    const completion = Promise.withResolvers<FeishuCardResponse>()
    const deadline = Date.now() + 2000
    let completed = false
    const finish = (response: FeishuCardResponse): boolean => {
      if (completed) return false
      completed = true
      clearTimeout(timer)
      this.cardResponses.delete(cancel)
      completion.resolve(response)
      return true
    }
    const cancel = () => {
      finish({})
    }
    const timer = setTimeout(cancel, 2000)
    timer.unref()
    this.cardResponses.add(cancel)
    const respond = (response: FeishuCardResponse): boolean => {
      if (completed || Date.now() >= deadline || this.closed || this.bot !== bot) return false
      return finish(cardResponseSchema.parse(response))
    }
    void (async () => {
      const messageId = source.context.open_message_id
      const chatId = source.context.open_chat_id
      const action = source.action
      const command =
        action.tag === 'button' && action.form_value === undefined ? bot.commandFrom(action.value) : undefined
      const known = bot.knownConversation(messageId)
      if (known?.messageType === 'group' && known.groupId !== chatId)
        throw new Error('Feishu card does not belong to the callback chat')
      const channel = known ?? (await bot.resolveChannel(chatId))
      const user = source.operator.open_id
      const sender = await bot.resolveSender(
        user,
        channel.messageType === 'group' ? channel.groupId : undefined,
      )
      if (this.closed || this.bot !== bot) return
      let thread = known?.thread
      let commandChannelResolved = known !== undefined
      if (!known) {
        try {
          const message = await bot.getMessageResource(messageId)
          if (message.chat_id !== chatId)
            throw new Error('Feishu message does not belong to the callback chat')
          thread = threadOf(message)
          commandChannelResolved = true
        } catch (error) {
          this.host.logger.debug(
            { platform: 'feishu', messageId, reason: redactText(String(error), this.config) },
            'Cannot resolve Feishu card thread',
          )
        }
      }
      if (this.closed || this.bot !== bot) return
      const target = {
        platform: 'feishu',
        selfId: bot.selfId,
        type: channel.messageType,
        id: channel.messageType === 'group' ? channel.groupId : user,
        ...(thread ? { thread } : {}),
      }
      if (commandChannelResolved) bot.rememberConversation(messageId, target)
      const event: FeishuCardActionEvent = {
        id: source.event_id,
        kind: 'notice',
        name: 'notice.feishu.card.action',
        platform: 'feishu',
        selfId: bot.selfId,
        time: Date.now(),
        raw,
        bot,
        platformType: 'card.action.trigger',
        userId: user,
        sender,
        ...(channel.messageType === 'group' ? { groupId: channel.groupId } : {}),
        chatId,
        messageId,
        ...(thread ? { thread } : {}),
        ...(commandChannelResolved ? { target } : {}),
        action: {
          tag: action.tag,
          value: action.value,
          ...(action.name === undefined ? {} : { name: action.name }),
          ...(action.input_value === undefined ? {} : { inputValue: action.input_value }),
          ...(action.option === undefined ? {} : { option: action.option }),
          ...(action.options === undefined ? {} : { options: action.options }),
          ...(action.form_value === undefined ? {} : { formValue: action.form_value }),
          ...(action.timezone === undefined ? {} : { timezone: action.timezone }),
          raw: action,
        },
        respond,
      }
      this.host.emit(event)
      if (command !== undefined) {
        if (!commandChannelResolved) {
          respond({
            toast: { type: 'warning', content: '无法确认这张卡片所在的会话，请让机器人重新发送卡片' },
          })
          return
        }
        this.host.emit(
          createSession(
            {
              id: `${source.event_id}:command`,
              platform: 'feishu',
              selfId: bot.selfId,
              time: event.time,
              raw,
              bot,
              ...channel,
              thread,
              messageId,
              userId: user,
              message: [seg.at(bot.selfId), seg.text(command)],
              sender,
              isSuperuser: this.host.isSuperuser({ platform: 'feishu', selfId: bot.selfId, userId: user }),
              isBotAdmin: this.host.isBotAdmin({ platform: 'feishu', selfId: bot.selfId, userId: user }),
              sentMessageIds: bot.sentMessageIds,
            },
            this.host.sessionServices,
          ),
        )
      }
    })().catch((error: unknown) => {
      this.host.logger.warn(
        {
          platform: 'feishu',
          appId: this.config.appId,
          eventId: source.event_id,
          reason: redactText(error instanceof Error ? error.message : String(error), this.config),
        },
        'Feishu card action failed',
      )
      respond({ toast: { type: 'error', content: '暂时无法处理，请稍后重试' } })
    })
    return completion.promise
  }
}

export class FeishuAdapter implements Adapter {
  readonly platform = 'feishu'
  private config: FeishuConfig
  private readonly host: AdapterHost
  private readonly options: FeishuAdapterOptions
  private readonly accounts = new Map<string, Account>()
  private running = false

  constructor(config: FeishuConfig, host: AdapterHost, options: FeishuAdapterOptions = {}) {
    this.config = config
    this.host = host
    this.options = options
  }
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.apply(this.config)
  }
  async stop(): Promise<void> {
    this.running = false
    for (const account of this.accounts.values()) account.stop()
    this.accounts.clear()
  }
  async reconfigure(config: unknown): Promise<void> {
    const next = feishuSchema.parse(config)
    if (this.running) await this.apply(next)
    this.config = next
  }
  private async apply(config: FeishuConfig): Promise<void> {
    const settingsChanged = !isDeepStrictEqual({ ...this.config, accounts: [] }, { ...config, accounts: [] })
    for (const [id, account] of this.accounts) {
      if (settingsChanged || !config.accounts.some((entry) => isDeepStrictEqual(entry, account.config))) {
        account.stop()
        this.accounts.delete(id)
      }
    }
    await Promise.all(
      config.accounts
        .filter((entry) => !this.accounts.has(entry.appId))
        .map(async (entry) => {
          const account = new Account(entry, config, this.host, this.options)
          this.accounts.set(entry.appId, account)
          await account.start()
        }),
    )
  }
}
