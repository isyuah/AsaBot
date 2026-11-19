import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { MessageInfo, MessageThread } from '../../core/bot.ts'
import type { Message, TextStyle } from '../../core/message/index.ts'
import { seg } from '../../core/message/index.ts'

const object = z.record(z.string(), z.unknown())
const textStyles = new Set<string>(['bold', 'italic', 'underline', 'strike', 'code'])
export const threadFields = z.object({
  message_id: z.string().min(1),
  thread_id: z.string().optional(),
  root_id: z.string().optional(),
  parent_id: z.string().optional(),
})

export function threadOf(message: z.output<typeof threadFields>): MessageThread | undefined {
  if (!message.thread_id) return undefined
  return {
    id: message.thread_id,
    rootMessageId: message.root_id || message.parent_id || message.message_id,
  }
}

const timeSchema = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const storedMessageContent = z.discriminatedUnion('deleted', [
  z.object({ deleted: z.literal(true), body: z.object({ content: z.string().optional() }).optional() }),
  z.object({ deleted: z.literal(false).optional(), body: z.object({ content: z.string() }) }),
])
export const messageResource = threadFields
  .extend({
    msg_type: z.string(),
    chat_id: z.string().min(1),
    create_time: timeSchema,
    sender: z.object({ id: z.string(), sender_type: z.string() }),
    mentions: z
      .array(z.object({ key: z.string().min(1), id: z.string(), name: z.string().optional() }))
      .default([]),
    upper_message_id: z.string().optional(),
    updated: z.boolean().optional(),
  })
  .and(storedMessageContent)

export interface FeishuMessageInfo extends MessageInfo {
  chatId: string
  senderType: string
  deleted: boolean
  updated: boolean
  parentMessageId?: string
}

export function decodeMessageResource(
  source: z.output<typeof messageResource>,
  messageType: MessageInfo['messageType'],
): FeishuMessageInfo {
  const thread = threadOf(source)
  return {
    messageId: source.message_id,
    messageType,
    userId: source.sender.id,
    ...(messageType === 'group' ? { groupId: source.chat_id } : {}),
    ...(thread === undefined ? {} : { thread }),
    ...(source.parent_id ? { parentMessageId: source.parent_id } : {}),
    time: source.create_time,
    message: source.deleted
      ? []
      : incomingMessage(
          source.msg_type,
          source.body.content,
          source.mentions,
          source.parent_id,
          source.message_id,
        ),
    sender: { userId: source.sender.id, nickname: source.sender.id },
    chatId: source.chat_id,
    senderType: source.sender.sender_type,
    deleted: source.deleted === true,
    updated: source.updated === true,
  }
}

export const mentionSchema = z.object({
  key: z.string().min(1),
  id: z.object({ open_id: z.string().optional() }).optional(),
  name: z.string().optional(),
})
export interface FeishuMention {
  key: string
  id: string
  name?: string
}

function textWithMentions(text: string, mentions: FeishuMention[]): Message {
  const result: Message = []
  let remaining = text
  const keys = new Map(mentions.map((mention) => [mention.key, mention.id]))
  while (remaining) {
    const next = [...keys]
      .map(([key, id]) => ({ key, id, index: remaining.indexOf(key) }))
      .filter((m) => m.key && m.index >= 0)
      .sort((a, b) => a.index - b.index || b.key.length - a.key.length)[0]
    if (!next) {
      result.push(seg.text(remaining))
      break
    }
    if (next.index) result.push(seg.text(remaining.slice(0, next.index)))
    result.push(seg.at(next.id))
    remaining = remaining.slice(next.index + next.key.length)
  }
  return result
}

/** Decode Feishu's JSON message body, preserving rich-text order and references. */
export function incomingMessage(
  type: string,
  json: string,
  mentions: FeishuMention[] = [],
  parentId?: string,
  messageId?: string,
): Message {
  const result: Message = parentId ? [seg.reply(parentId)] : []
  // The Feishu API can use a display string rather than JSON for forwarded messages.
  if (type === 'merge_forward' && messageId) return [...result, seg.forward(messageId)]
  const content = object.parse(JSON.parse(json))
  if (type === 'text') result.push(...textWithMentions(z.string().parse(content.text), mentions))
  else if (type === 'image') result.push(seg.image(z.string().parse(content.image_key)))
  else if (type === 'audio') result.push(seg.audio(z.string().parse(content.file_key)))
  else if (type === 'media') result.push(seg.video(z.string().parse(content.file_key)))
  else if (type === 'file')
    result.push(
      seg.file(z.string().parse(content.file_key), { name: z.string().optional().parse(content.file_name) }),
    )
  else if (type === 'post') {
    const post = Array.isArray(content.content)
      ? content
      : object.parse(content.zh_cn ?? content.en_us ?? Object.values(content)[0])
    if (typeof post.title === 'string' && post.title) result.push(seg.text(`${post.title}\n`))
    const lines = z.array(z.array(object)).parse(post.content)
    lines.forEach((line, index) => {
      if (index) result.push(seg.text('\n'))
      for (const item of line) {
        if (item.tag === 'text') {
          const style = z
            .array(z.string())
            .optional()
            .parse(item.style)
            ?.filter((s): s is TextStyle => textStyles.has(s))
          result.push(seg.text(z.string().parse(item.text), style))
        } else if (item.tag === 'at') {
          const id = z.string().parse(item.user_id)
          result.push(seg.at(mentions.find((mention) => mention.key === id)?.id ?? id))
        } else if (item.tag === 'a')
          result.push(seg.text(`${z.string().parse(item.text)} (${z.string().parse(item.href)})`))
        else if (item.tag === 'img') result.push(seg.image(z.string().parse(item.image_key)))
        else if (item.tag === 'media') result.push(seg.video(z.string().parse(item.file_key)))
        else if (item.tag === 'emotion')
          result.push({ type: 'feishu:emoji', data: { emoji_type: z.string().parse(item.emoji_type) } })
        else if (item.tag === 'md') result.push(seg.markdown(z.string().parse(item.text)))
        else result.push({ type: 'feishu:post.element', data: item })
      }
    })
  } else result.push({ type: `feishu:${type}`, data: content })
  return result
}

/** One deadline covers media headers and body. Opaque platform keys return undefined. */
export async function readMedia(
  source: string,
  limit: number,
  timeout: number,
  shutdown: AbortSignal,
): Promise<Buffer | undefined> {
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(timeout)])
  signal.throwIfAborted()
  if (source.startsWith('base64://')) {
    if ((source.length - 9) * 0.75 > limit + 2) throw new Error('Media exceeds mediaMaxBytes')
    const value = source.slice(9)
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
      throw new Error('Invalid base64 media')
    const bytes = Buffer.from(value, 'base64')
    if (bytes.length > limit) throw new Error('Media exceeds mediaMaxBytes')
    return bytes
  }
  if (source.startsWith('file://')) {
    const path = fileURLToPath(source)
    if ((await stat(path)).size > limit) throw new Error('Media exceeds mediaMaxBytes')
    const bytes = await readFile(path, { signal })
    if (bytes.length > limit) throw new Error('Media exceeds mediaMaxBytes')
    return bytes
  }
  if (!/^https?:\/\//.test(source)) return undefined
  const response = await fetch(source, { signal })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Media HTTP ${response.status}`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Media response has no body')
  const chunks: Buffer[] = []
  let length = 0
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Media exceeds mediaMaxBytes')
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.length
      if (length > limit) throw new Error('Media exceeds mediaMaxBytes')
      chunks.push(Buffer.from(part.value))
    }
    return Buffer.concat(chunks)
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
