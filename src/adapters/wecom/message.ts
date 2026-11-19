import type { SendMsgBody } from '@wecom/aibot-node-sdk'
import { z } from 'zod'
import { isSegment, type Message, seg } from '../../core/message/index.ts'
import { cardForSend, cardSchema } from './cards.ts'
import { attachmentSchema, type MediaSegment, type WecomMedia } from './media.ts'

const id = z.string().min(1).max(1024)
export const frameHeader = z.object({ headers: z.object({ req_id: z.string().min(1).max(256) }) })
export const inboundFields = z.object({
  msgid: id,
  aibotid: id,
  from: z.object({ userid: id, corpid: id.optional() }),
  create_time: z.number().int().positive().optional(),
  compat_info: z.unknown().optional(),
})
export const groupChat = z.object({ chattype: z.literal('group'), chatid: id })
const privateChat = z.object({ chattype: z.literal('single') })
const text = z.object({ msgtype: z.literal('text'), text: z.object({ content: z.string() }) })
const image = z.object({ msgtype: z.literal('image'), image: attachmentSchema })
const contentSchema = z.discriminatedUnion('msgtype', [
  text,
  image,
  z.object({ msgtype: z.literal('file'), file: attachmentSchema }),
  z.object({ msgtype: z.literal('video'), video: attachmentSchema }),
  z.object({ msgtype: z.literal('voice'), voice: z.object({ content: z.string() }) }),
  z.object({
    msgtype: z.literal('mixed'),
    mixed: z.object({ msg_item: z.array(z.discriminatedUnion('msgtype', [text, image])) }),
  }),
])
export const messageFrame = frameHeader.extend({
  body: inboundFields
    .extend({ quote: contentSchema.optional() })
    .and(z.discriminatedUnion('chattype', [privateChat, groupChat]))
    .and(contentSchema),
})

type Content = z.output<typeof contentSchema>
type Inbound = z.output<typeof messageFrame>['body']

function segments(content: Content, media: WecomMedia, now: number): Message {
  switch (content.msgtype) {
    case 'text':
      return [seg.text(content.text.content)]
    case 'voice':
      return [seg.text(content.voice.content)]
    case 'image':
      return [media.remember('image', content.image, now)]
    case 'file':
      return [media.remember('file', content.file, now)]
    case 'video':
      return [media.remember('video', content.video, now)]
    case 'mixed':
      return content.mixed.msg_item.flatMap((item) => segments(item, media, now))
  }
}

export function incoming(body: Inbound, media: WecomMedia, now: number, botName?: string): Message {
  const message = segments(body, media, now)
  if (body.chattype === 'group') {
    const first = message[0]
    if (botName && first && isSegment(first, 'text') && body.msgtype !== 'voice') {
      const prefix = `@${botName}`
      const content = first.data.text.trimStart()
      const after = content.slice(prefix.length)
      if (content.startsWith(prefix) && (after === '' || /^\s/.test(after)))
        message[0] = seg.text(after.trimStart())
    }
    message.unshift(seg.at(body.aibotid))
  }
  if (body.quote) {
    message.unshift({
      type: 'reply',
      data: { id: `wecom-quote:${body.msgid}`, message: segments(body.quote, media, now) },
    })
  }
  return message
}

export const contentText = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= 20_480, '企业微信单条内容不能超过 20480 字节')

type OutgoingPart = { body: SendMsgBody; message: Message } | { media: MediaSegment }

function markdownPart(content: string, message: Message): OutgoingPart {
  return { body: { msgtype: 'markdown', markdown: { content: contentText.parse(content) } }, message }
}

export function* outgoing(message: Message): Generator<OutgoingPart> {
  let content = ''
  let parts: Message = []
  for (const segment of message) {
    if (isSegment(segment, 'text') || isSegment(segment, 'markdown')) {
      content +=
        segment.type === 'markdown'
          ? segment.data.content
          : segment.data.text.replace(/[\\`*_{}[\]()#+\-.!|>~<]/g, '\\$&')
      parts.push(segment)
      continue
    }
    if (content) yield markdownPart(content, parts)
    content = ''
    parts = []
    if (
      isSegment(segment, 'image') ||
      isSegment(segment, 'file') ||
      isSegment(segment, 'video') ||
      isSegment(segment, 'audio')
    ) {
      yield { media: segment }
    } else if (segment.type === 'wecom:card') {
      const card = cardForSend(cardSchema.parse(segment.data.card))
      yield {
        body: { msgtype: 'template_card', template_card: card },
        message: [{ type: 'wecom:card', data: { card } }],
      }
    } else throw new Error(`未知的企业微信消息段：${segment.type}`)
  }
  if (content) yield markdownPart(content, parts)
}
