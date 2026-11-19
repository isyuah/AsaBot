import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { sendTo, supports } from '../core/bot.ts'
import { durationSchema } from '../core/config/schema.ts'
import type { Message, Segment } from '../core/message/index.ts'
import { isSegment, seg } from '../core/message/index.ts'
import { definePlugin } from '../core/plugin/definition.ts'

interface Renderer {
  text(text: string): Promise<Buffer>
  markdown(markdown: string): Promise<Buffer>
}

interface Piece {
  segment: Segment
  start: number
  end: number
}

function textOf(segment: Segment): string {
  if (isSegment(segment, 'text')) return segment.data.text
  if (isSegment(segment, 'markdown')) return segment.data.content
  return ''
}

function splitMessage(message: Message, chunkSize: number): Message[] {
  const replies = message.filter((segment) => isSegment(segment, 'reply'))
  const pieces: Piece[] = []
  let text = ''
  for (const segment of message) {
    if (isSegment(segment, 'reply')) continue
    const start = text.length
    text += textOf(segment)
    pieces.push({ segment, start, end: text.length })
  }
  const boundaries = (pattern: RegExp): number[] =>
    [...text.matchAll(pattern)].map((match) => (match.index ?? 0) + match[0].length)
  const paragraphs = boundaries(/\n[\t ]*\n+/g)
  const sentences = boundaries(/[。！？.!?]+|\n/g)
  const chunks: Message[] = []
  let start = 0
  while (start < text.length) {
    const limit = Math.min(start + chunkSize, text.length)
    let end = limit
    if (limit < text.length) {
      end =
        paragraphs.filter((index) => index > start && index <= limit).at(-1) ??
        sentences.filter((index) => index > start && index <= limit).at(-1) ??
        limit
      if (
        end < text.length &&
        /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') &&
        /[\uDC00-\uDFFF]/.test(text[end] ?? '')
      ) {
        end = end - 1 > start ? end - 1 : end + 1
      }
    }
    const chunk: Message = chunks.length === 0 ? [...replies] : []
    for (const piece of pieces) {
      if (piece.start === piece.end) {
        if (piece.start >= start && (piece.start < end || (end === text.length && piece.start === end))) {
          chunk.push(piece.segment)
        }
        continue
      }
      const from = Math.max(start, piece.start)
      const to = Math.min(end, piece.end)
      if (from >= to) continue
      const value = textOf(piece.segment).slice(from - piece.start, to - piece.start)
      if (isSegment(piece.segment, 'text')) {
        chunk.push({ ...piece.segment, data: { ...piece.segment.data, text: value } })
      } else if (isSegment(piece.segment, 'markdown')) {
        chunk.push({ ...piece.segment, data: { ...piece.segment.data, content: value } })
      }
    }
    chunks.push(chunk)
    start = end
  }
  return chunks
}

function renderText(message: Message): string {
  return message
    .map((segment) => {
      if (isSegment(segment, 'at')) return `@${segment.data.id}`
      if (isSegment(segment, 'face')) return '[表情]'
      return textOf(segment)
    })
    .join('')
}

export default definePlugin({
  name: 'long-message',
  description: '将长消息转发、渲染或分段发送',
  defaultOnNewBots: true,
  inject: { optional: ['render'] },
  config: z.object({
    threshold: z.number().int().positive().default(1000),
    strategy: z.enum(['forward', 'image', 'split']).default('forward'),
    chunkSize: z.number().int().positive().default(800),
    splitInterval: durationSchema.default(1000),
    markdownAsImage: z.boolean().default(true),
  }),
  setup(ctx) {
    const render = ctx.injectOptional('render') as Renderer | undefined
    const signal = ctx.signal
    ctx.beforeSend(
      async ({ bot, target, message, sendFirst, sendPart }) => {
        if (message.some((segment) => !['text', 'at', 'face', 'reply', 'markdown'].includes(segment.type)))
          return
        const config = ctx.configFor({
          platform: bot.platform,
          selfId: bot.selfId,
          ...(target.type === 'group' ? { groupId: target.id } : {}),
        })
        const imageMarkdown = async (parts: Message): Promise<Message> => {
          if (!config.markdownAsImage || !render || supports(bot, 'markdown') || !supports(bot, 'image'))
            return parts
          return Promise.all(
            parts.map(async (part) =>
              isSegment(part, 'markdown') ? seg.image(await render.markdown(part.data.content)) : part,
            ),
          )
        }
        if (message.map(textOf).join('').length <= config.threshold) return imageMarkdown(message)
        if (config.strategy === 'image' && render && supports(bot, 'image')) {
          const text = renderText(message)
          const image = message.some((segment) => isSegment(segment, 'markdown'))
            ? await render.markdown(text)
            : await render.text(text)
          return [...message.filter((segment) => isSegment(segment, 'reply')), seg.image(image)]
        }
        const chunks = splitMessage(message, config.chunkSize)
        if (!sendFirst && !sendPart && config.strategy !== 'split' && supports(bot, 'sendForward')) {
          const nodes = await Promise.all(
            chunks.map(async (chunk) => ({
              userId: bot.selfId,
              nickname: bot.nickname ?? bot.selfId,
              message: await imageMarkdown(chunk),
            })),
          )
          return { deliver: () => bot.sendForward(target, nodes) }
        }
        // Split sending can take far longer than the hook timeout, so it runs as a delivery after the hook chain.
        return {
          deliver: async () => {
            const first = await imageMarkdown(chunks[0] as Message)
            let sent = await (sendFirst
              ? sendFirst(first)
              : sendPart
                ? sendPart(first)
                : sendTo(bot, target, first))
            let destination = { ...target, thread: target.thread ?? sent.thread }
            for (const chunk of chunks.slice(1)) {
              if (config.splitInterval) await delay(config.splitInterval, undefined, { signal })
              const part = await imageMarkdown(chunk)
              sent = await (sendPart ? sendPart(part) : sendTo(bot, destination, part))
              if (!destination.thread && sent.thread) destination = { ...destination, thread: sent.thread }
            }
            return sent
          },
        }
      },
      { priority: -100 },
    )
  },
})
