import { isDeepStrictEqual } from 'node:util'
import type { Logger } from 'pino'
import { type Bot, supportsSegment } from '../bot.ts'
import { UnsupportedError } from '../errors.ts'
import { isSegment, seg } from './segment.ts'
import type { Message, Segment } from './types.ts'

export const neutralSegments = [
  'text',
  'markdown',
  'button',
  'at',
  'face',
  'image',
  'audio',
  'video',
  'file',
  'reply',
  'forward',
] as const

function markdownMarkup(content: string): string {
  return content
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]*|[-+*][ \t]+|\d+[.)][ \t]+)/gm, '')
    .replace(/(\*\*|__|~~|\|\|)(.*?)\1/g, '$2')
    .replace(/(^|\s)([*_])([^\n]+?)\2(?=\s|[.,!?，。！？]|$)/g, '$1$3')
}

function markdownInline(content: string): string {
  let result = ''
  let cursor = 0
  for (const match of content.matchAll(/(`+)([^\n]*?)\1/g)) {
    result += markdownMarkup(content.slice(cursor, match.index)) + match[2]
    cursor = match.index + match[0].length
  }
  return result + markdownMarkup(content.slice(cursor))
}

function markdownText(content: string): string {
  let result = ''
  let cursor = 0
  for (const match of content.matchAll(
    /^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)^[ \t]{0,3}\1[ \t]*$/gm,
  )) {
    result += markdownInline(content.slice(cursor, match.index)) + match[2]
    cursor = match.index + match[0].length
  }
  return result + markdownInline(content.slice(cursor))
}

function append(result: Message, segment: Segment): void {
  const previous = result.at(-1)
  if (previous && isSegment(previous, 'text') && isSegment(segment, 'text')) {
    const { text: _previousText, ...previousData } = previous.data
    const { text: _text, ...data } = segment.data
    if (isDeepStrictEqual(previousData, data)) {
      result[result.length - 1] = {
        ...previous,
        data: { ...previous.data, text: previous.data.text + segment.data.text },
      }
      return
    }
  }
  result.push(segment)
}

export function lowerMessage(bot: Bot, message: Message, logger: Logger): Message {
  const result: Message = []
  const lowered = new Set<string>()
  for (const segment of message) {
    const neutral = (neutralSegments as readonly string[]).includes(segment.type)
    const colon = segment.type.indexOf(':')
    if (!neutral && colon === -1) {
      logger.warn(
        { platform: bot.platform, segment: segment.type },
        'Unknown segment has no platform namespace',
      )
      lowered.add(segment.type)
      continue
    }
    if (!neutral && segment.type.slice(0, colon) !== bot.platform) {
      lowered.add(segment.type)
      continue
    }
    if (isSegment(segment, 'text') && supportsSegment(bot, 'text')) {
      const style = segment.data.style?.filter((item) => bot.capabilities.textStyles.includes(item))
      if (style?.length !== segment.data.style?.length) lowered.add('text.style')
      const { style: _style, ...data } = segment.data
      append(result, { ...segment, data: { ...data, ...(style?.length ? { style } : {}) } })
      continue
    }
    if (supportsSegment(bot, segment.type)) {
      append(result, segment)
      continue
    }
    lowered.add(segment.type)
    if (!supportsSegment(bot, 'text')) continue
    let text: string | undefined
    if (isSegment(segment, 'markdown')) text = markdownText(segment.data.content)
    else if (isSegment(segment, 'button')) {
      text =
        segment.data.kind === 'link'
          ? `${segment.data.label}: ${segment.data.value}`
          : `${segment.data.label}：发送 ${segment.data.value}`
    } else if (isSegment(segment, 'at')) text = `@${segment.data.id}`
    else if (isSegment(segment, 'face')) text = '[表情]'
    else if (isSegment(segment, 'image')) text = '[图片]'
    else if (isSegment(segment, 'audio')) text = '[语音]'
    else if (isSegment(segment, 'video')) text = '[视频]'
    else if (isSegment(segment, 'file')) text = segment.data.name ? `[文件 ${segment.data.name}]` : '[文件]'
    else if (isSegment(segment, 'forward')) text = '[合并转发]'
    if (text !== undefined) append(result, seg.text(text))
  }
  if (lowered.size)
    logger.debug({ platform: bot.platform, segments: [...lowered] }, 'Outgoing message lowered')
  if (result.length === 0) throw new UnsupportedError(bot.platform, `发送 ${message[0]?.type ?? '消息'}`)
  return result
}
