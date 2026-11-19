import { z } from 'zod'
import type { AdapterHost } from '../../core/adapter.ts'
import type { Bot, MessageTarget, MessageThread, SendResult } from '../../core/bot.ts'
import { NotConnectedError } from '../../core/errors.ts'
import type { Sendable } from '../../core/message/index.ts'
import { redactText } from '../../core/utils/redact.ts'
import type { FeishuCard, FeishuElement } from './cards.ts'
import type { FeishuConfig } from './config.ts'
import { decodeMessageResource, type FeishuMessageInfo, messageResource } from './message.ts'
import type { FeishuRequest, FeishuTransport, FeishuUploadKind } from './transport.ts'

export interface FeishuApi {
  sendCard(target: MessageTarget, card: FeishuCard): Promise<SendResult>
  updateCard(messageId: string, card: FeishuCard): Promise<void>
  /** 以指定消息开启话题；传入现有话题时，messageId 必须是该话题的根消息。 */
  replyInThread(
    target: MessageTarget,
    messageId: string,
    content: Sendable,
  ): Promise<SendResult & { thread: MessageThread }>
  listMessages(
    container: FeishuMessageContainer,
    options?: FeishuListMessagesOptions,
  ): Promise<FeishuMessagePage>
  forwardMessage(messageId: string, target: MessageTarget): Promise<SendResult>
  forwardThread(threadId: string, target: MessageTarget): Promise<SendResult>
  mergeForward(messageIds: string[], target: MessageTarget): Promise<FeishuMergeForwardResult>
  editMessage(messageId: string, text: string): Promise<void>
  addReaction(messageId: string, emoji: string): Promise<string>
  removeReaction(messageId: string, reactionId: string): Promise<void>
  listReactions(messageId: string, options?: FeishuListReactionsOptions): Promise<FeishuPage<FeishuReaction>>
  pinMessage(messageId: string): Promise<void>
  unpinMessage(messageId: string): Promise<void>
  listPins(chatId: string, options?: FeishuPageOptions): Promise<FeishuPage<FeishuPin>>
  listReadUsers(messageId: string, options?: FeishuPageOptions): Promise<FeishuPage<FeishuReadUser>>
  getChat(chatId: string): Promise<FeishuChatInfo>
  setChatMessageMode(chatId: string, mode: 'chat' | 'thread'): Promise<void>
  addChatMembers(chatId: string, openIds: string[]): Promise<FeishuAddMembersResult>
  urgentApp(messageId: string, openIds: string[]): Promise<{ invalidUserIds: string[] }>
  commandButton(label: string, command: string): FeishuElement
  downloadResource(messageId: string, key: string, type: 'image' | 'file'): Promise<Buffer>
}

export interface FeishuMessageContainer {
  type: 'chat' | 'thread'
  id: string
}
export interface FeishuPageOptions {
  pageSize?: number
  pageToken?: string
}
export interface FeishuListMessagesOptions extends FeishuPageOptions {
  order?: 'asc' | 'desc'
  /** 毫秒级 Unix 时间戳，仅适用于 chat 容器。 */
  startTime?: number
  endTime?: number
}
export interface FeishuListReactionsOptions extends FeishuPageOptions {
  emoji?: string
}
export interface FeishuPage<T> {
  items: T[]
  pageToken?: string
}
export interface FeishuReaction {
  reactionId: string
  emoji: string
  operatorId: string
  operatorType: 'user' | 'app'
  time: number
}
export interface FeishuPin {
  messageId: string
  chatId: string
  operatorId: string
  time: number
}
export interface FeishuReadUser {
  userId: string
  time: number
}
export interface FeishuChatInfo {
  chatId: string
  mode: 'p2p' | 'group' | 'topic'
  messageMode?: 'chat' | 'thread'
  name?: string
  description?: string
  avatar?: string
  ownerId?: string
  adminIds: string[]
  botAdminIds: string[]
  memberCount?: number
}
export interface FeishuAddMembersResult {
  invalidIds: string[]
  missingIds: string[]
  pendingApprovalIds: string[]
}
export interface FeishuMergeForwardResult extends SendResult {
  invalidMessageIds: string[]
}
export type FeishuMessagePage = FeishuPage<FeishuMessageInfo>

const envelope = z.object({ code: z.number(), msg: z.string().optional() }).passthrough()
export const idSchema = z.string().min(1)
const timeSchema = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const ids = z.array(idSchema).default([])
export const chatMode = z.enum(['group', 'p2p', 'topic'])
const messageMode = z.enum(['chat', 'thread'])
export const chatRolesSchema = z.object({
  chat_mode: chatMode.optional(),
  owner_id: z.string().optional(),
  user_manager_id_list: ids,
})
const fullChat = chatRolesSchema.extend({
  chat_mode: chatMode,
  group_message_type: messageMode.optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  avatar: z.string().optional(),
  bot_manager_id_list: ids,
  user_count: z.coerce.number().int().nonnegative().optional(),
})
const container = z.object({ type: z.enum(['chat', 'thread']), id: idSchema })
const pageOptions = z.object({
  pageSize: z.number().int().min(1).max(50).default(20),
  pageToken: idSchema.optional(),
})
const messageListOptions = pageOptions.extend({
  order: z.enum(['asc', 'desc']).default('desc'),
  startTime: z.number().int().nonnegative().optional(),
  endTime: z.number().int().nonnegative().optional(),
})
const messageListArgs = z.tuple([container, messageListOptions.prefault({})]).refine(([source, options]) => {
  const { startTime, endTime } = options
  if (startTime === undefined && endTime === undefined) return true
  return source.type === 'chat' && (startTime === undefined || endTime === undefined || startTime < endTime)
}, 'Message time filters require a chat and startTime before endTime')
const reactionListOptions = pageOptions.extend({ emoji: idSchema.optional() })
const readUserListOptions = pageOptions.extend({ pageSize: z.number().int().min(1).max(100).default(20) })
const reaction = z
  .object({
    reaction_id: idSchema,
    reaction_type: z.object({ emoji_type: idSchema }),
    operator: z.object({ operator_id: idSchema, operator_type: z.enum(['user', 'app']) }),
    action_time: timeSchema,
  })
  .transform(
    (item): FeishuReaction => ({
      reactionId: item.reaction_id,
      emoji: item.reaction_type.emoji_type,
      operatorId: item.operator.operator_id,
      operatorType: item.operator.operator_type,
      time: item.action_time,
    }),
  )
const pin = z
  .object({
    message_id: idSchema,
    chat_id: idSchema,
    operator_id: idSchema,
    create_time: timeSchema,
  })
  .transform(
    (item): FeishuPin => ({
      messageId: item.message_id,
      chatId: item.chat_id,
      operatorId: item.operator_id,
      time: item.create_time,
    }),
  )
const readUser = z
  .object({ user_id: idSchema, timestamp: timeSchema })
  .transform((item): FeishuReadUser => ({ userId: item.user_id, time: item.timestamp }))
const addedMembers = z.object({
  invalid_id_list: ids,
  not_existed_id_list: ids,
  pending_approval_id_list: ids,
})

export const messagePath = (id: string): string => `/im/v1/messages/${encodeURIComponent(id)}`
export const chatPath = (id: string): string => `/im/v1/chats/${encodeURIComponent(id)}`

export class FeishuClient {
  private readonly host: AdapterHost
  private readonly bot: Bot
  private readonly transport: FeishuTransport
  private readonly config: FeishuConfig

  constructor(host: AdapterHost, bot: Bot, transport: FeishuTransport, config: FeishuConfig) {
    this.host = host
    this.bot = bot
    this.transport = transport
    this.config = config
  }

  async invoke<T>(
    method: keyof FeishuApi,
    args: unknown[],
    run: (args: unknown[]) => Promise<T>,
  ): Promise<T> {
    const result = await this.host.invokeApi(
      { bot: this.bot, method: `feishu.${method}`, args },
      (actualArgs) => {
        if (this.bot.status !== 'online') throw new NotConnectedError()
        return run(actualArgs)
      },
    )
    // In-process interceptors may replace the result and are responsible for preserving the method's return type.
    return result as T
  }

  private async checked(work: () => Promise<unknown>): Promise<z.output<typeof envelope>> {
    try {
      const result = envelope.parse(await work())
      if (result.code !== 0) throw new Error(`Feishu API ${result.code}: ${result.msg ?? 'request failed'}`)
      return result
    } catch (error) {
      throw new Error(redactText(error instanceof Error ? error.message : String(error), this.config))
    }
  }

  raw(method: string, path: string, input?: FeishuRequest): Promise<z.output<typeof envelope>> {
    return this.checked(() => this.transport.request(method, path, input))
  }

  async data<T>(method: string, path: string, schema: z.ZodType<T>, input?: FeishuRequest): Promise<T> {
    const result = await this.raw(method, path, input)
    return schema.parse(result.data)
  }

  async upload(kind: FeishuUploadKind, bytes: Buffer, name: string): Promise<string> {
    const result = await this.checked(() => this.transport.upload(kind, bytes, name))
    if (kind === 'image') return z.object({ image_key: idSchema }).parse(result.data).image_key
    return z.object({ file_key: idSchema }).parse(result.data).file_key
  }

  async download(messageId: string, key: string, type: 'image' | 'file'): Promise<Buffer> {
    try {
      return await this.transport.download(messageId, key, type)
    } catch (error) {
      throw new Error(redactText(error instanceof Error ? error.message : String(error), this.config))
    }
  }

  async page<T>(
    path: string,
    schema: z.ZodType<T>,
    params: Record<string, string | number>,
    { pageSize, pageToken }: { pageSize: number; pageToken?: string },
  ): Promise<FeishuPage<T>> {
    const page = await this.data(
      'GET',
      path,
      z.object({
        items: z.array(schema).default([]),
        has_more: z.boolean().default(false),
        page_token: idSchema.optional(),
      }),
      { params: { ...params, page_size: pageSize, ...(pageToken ? { page_token: pageToken } : {}) } },
    )
    if (!page.has_more) return { items: page.items }
    if (!page.page_token || page.page_token === pageToken)
      throw new Error('Feishu returned an invalid pagination token')
    return { items: page.items, pageToken: page.page_token }
  }

  async allPages<T>(
    path: string,
    schema: z.ZodType<T>,
    params: Record<string, string | number>,
  ): Promise<T[]> {
    const items: T[] = []
    const seen = new Set<string>()
    let pageToken: string | undefined
    do {
      const page = await this.page(path, schema, params, { pageSize: 100, pageToken })
      items.push(...page.items)
      pageToken = page.pageToken
      if (pageToken) {
        if (seen.has(pageToken)) throw new Error('Feishu returned an invalid pagination token')
        seen.add(pageToken)
      }
    } while (pageToken)
    return items
  }
}

export function feishuOperations(
  client: FeishuClient,
  messageType: (chatId: string) => Promise<'private' | 'group'>,
  invalidateChat: (chatId: string) => void,
): Omit<
  FeishuApi,
  | 'sendCard'
  | 'updateCard'
  | 'replyInThread'
  | 'forwardMessage'
  | 'forwardThread'
  | 'mergeForward'
  | 'commandButton'
  | 'downloadResource'
> {
  return {
    listMessages: (container, options) =>
      client.invoke('listMessages', [container, options], async (args) => {
        const [source, settings] = messageListArgs.parse(args)
        const page = await client.page(
          '/im/v1/messages',
          messageResource,
          {
            container_id_type: source.type,
            container_id: source.id,
            sort_type: settings.order === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
            ...(settings.startTime === undefined
              ? {}
              : { start_time: Math.floor(settings.startTime / 1000) }),
            ...(settings.endTime === undefined ? {} : { end_time: Math.ceil(settings.endTime / 1000) }),
          },
          settings,
        )
        const first = page.items[0]
        if (!first) return { items: [], pageToken: page.pageToken }
        const type = await messageType(first.chat_id)
        return {
          items: page.items.map((item) => decodeMessageResource(item, type)),
          pageToken: page.pageToken,
        }
      }),
    editMessage: (messageId, text) =>
      client.invoke('editMessage', [messageId, text], async (args) => {
        const [id, value] = z.tuple([idSchema, z.string()]).parse(args)
        await client.raw('PUT', messagePath(id), {
          data: { msg_type: 'text', content: JSON.stringify({ text: value }) },
        })
      }),
    addReaction: (messageId, emoji) =>
      client.invoke('addReaction', [messageId, emoji], async (args) => {
        const [id, kind] = z.tuple([idSchema, idSchema]).parse(args)
        const result = await client.data(
          'POST',
          `${messagePath(id)}/reactions`,
          z.object({ reaction_id: idSchema }),
          {
            data: { reaction_type: { emoji_type: kind } },
          },
        )
        return result.reaction_id
      }),
    removeReaction: (messageId, reactionId) =>
      client.invoke('removeReaction', [messageId, reactionId], async (args) => {
        const [id, reactionId] = z.tuple([idSchema, idSchema]).parse(args)
        await client.raw('DELETE', `${messagePath(id)}/reactions/${encodeURIComponent(reactionId)}`)
      }),
    listReactions: (messageId, options) =>
      client.invoke('listReactions', [messageId, options], (args) => {
        const [id, settings] = z.tuple([idSchema, reactionListOptions.prefault({})]).parse(args)
        return client.page(
          `${messagePath(id)}/reactions`,
          reaction,
          {
            user_id_type: 'open_id',
            ...(settings.emoji ? { reaction_type: settings.emoji } : {}),
          },
          settings,
        )
      }),
    pinMessage: (messageId) =>
      client.invoke('pinMessage', [messageId], async (args) => {
        const [id] = z.tuple([idSchema]).parse(args)
        await client.raw('POST', '/im/v1/pins', { data: { message_id: id } })
      }),
    unpinMessage: (messageId) =>
      client.invoke('unpinMessage', [messageId], async (args) => {
        const [id] = z.tuple([idSchema]).parse(args)
        await client.raw('DELETE', `/im/v1/pins/${encodeURIComponent(id)}`)
      }),
    listPins: (chatId, options) =>
      client.invoke('listPins', [chatId, options], (args) => {
        const [id, settings] = z.tuple([idSchema, pageOptions.prefault({})]).parse(args)
        return client.page('/im/v1/pins', pin, { chat_id: id }, settings)
      }),
    listReadUsers: (messageId, options) =>
      client.invoke('listReadUsers', [messageId, options], (args) => {
        const [id, settings] = z.tuple([idSchema, readUserListOptions.prefault({})]).parse(args)
        return client.page(`${messagePath(id)}/read_users`, readUser, { user_id_type: 'open_id' }, settings)
      }),
    getChat: (chatId) =>
      client.invoke('getChat', [chatId], async (args) => {
        const [id] = z.tuple([idSchema]).parse(args)
        const chat = await client.data('GET', chatPath(id), fullChat, { params: { user_id_type: 'open_id' } })
        return {
          chatId: id,
          mode: chat.chat_mode,
          messageMode: chat.group_message_type,
          name: chat.name,
          description: chat.description,
          avatar: chat.avatar,
          ownerId: chat.owner_id,
          adminIds: chat.user_manager_id_list,
          botAdminIds: chat.bot_manager_id_list,
          memberCount: chat.user_count,
        }
      }),
    setChatMessageMode: (chatId, mode) =>
      client.invoke('setChatMessageMode', [chatId, mode], async (args) => {
        const [id, value] = z.tuple([idSchema, messageMode]).parse(args)
        await client.raw('PUT', chatPath(id), { data: { group_message_type: value } })
        invalidateChat(id)
      }),
    addChatMembers: (chatId, openIds) =>
      client.invoke('addChatMembers', [chatId, openIds], async (args) => {
        const [id, members] = z.tuple([idSchema, z.array(idSchema).min(1).max(50)]).parse(args)
        const added = await client.data('POST', `${chatPath(id)}/members`, addedMembers, {
          params: { member_id_type: 'open_id', succeed_type: 1 },
          data: { id_list: members },
        })
        return {
          invalidIds: added.invalid_id_list,
          missingIds: added.not_existed_id_list,
          pendingApprovalIds: added.pending_approval_id_list,
        }
      }),
    urgentApp: (messageId, openIds) =>
      client.invoke('urgentApp', [messageId, openIds], async (args) => {
        const [id, users] = z.tuple([idSchema, z.array(idSchema).min(1).max(200)]).parse(args)
        const result = await client.data(
          'PATCH',
          `${messagePath(id)}/urgent_app`,
          z.object({ invalid_user_id_list: ids }),
          {
            params: { user_id_type: 'open_id' },
            data: { user_id_list: users },
          },
        )
        return { invalidUserIds: result.invalid_user_id_list }
      }),
  }
}
