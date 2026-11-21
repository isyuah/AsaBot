import { isAbsolute, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { KnownSegment, Segment, TextStyle } from './types.ts'

type TypedSegment<K extends KnownSegment['type']> = Extract<KnownSegment, { type: K }>

/** 判断消息段类型并收窄到对应的已知段类型。 */
export function isSegment<K extends KnownSegment['type']>(
  segment: Segment,
  type: K,
): segment is TypedSegment<K> {
  return segment.type === type
}

function mediaSource(source: string | Buffer | URL): string {
  if (Buffer.isBuffer(source)) {
    return `base64://${source.toString('base64')}`
  }
  if (source instanceof URL) return source.href
  if (/^(?:https?|base64|file):\/\//i.test(source)) {
    return source
  }
  if (isAbsolute(source) && !source.startsWith('//')) return pathToFileURL(source).href
  if (win32.isAbsolute(source)) return pathToFileURL(source, { windows: true }).href
  if (/^\.\.?\//.test(source)) {
    throw new TypeError('请使用 new URL(..., import.meta.url) 或绝对路径指定本地文件')
  }
  return source
}

/** 创建平台无关消息段的构造器集合。 */
export const seg = {
  /** 构造纯文本段，可附带平台支持的文本样式。 */
  text(text: string, style?: TextStyle[]): TypedSegment<'text'> {
    return { type: 'text', data: { text, ...(style === undefined ? {} : { style }) } }
  },
  /** 构造 Markdown 消息段；不支持的平台会降级为纯文本。 */
  markdown(content: string): TypedSegment<'markdown'> {
    return { type: 'markdown', data: { content } }
  },
  /** 构造链接或命令按钮；options 指定 link 或 command。 */
  button(label: string, options: { link: string } | { command: string }): TypedSegment<'button'> {
    return 'link' in options
      ? { type: 'button', data: { label, kind: 'link', value: options.link } }
      : { type: 'button', data: { label, kind: 'command', value: options.command } }
  },
  /** 构造提及指定用户的消息段。 */
  at(id: string): TypedSegment<'at'> {
    return { type: 'at', data: { id } }
  },
  /** 构造提及全体成员的消息段。 */
  atAll(): TypedSegment<'at'> {
    return { type: 'at', data: { id: 'all' } }
  },
  /** 构造平台表情段，id 的含义由平台决定。 */
  face(id: string | number): TypedSegment<'face'> {
    return { type: 'face', data: { id: String(id) } }
  },
  /** 构造图片段；支持 Buffer、URL、绝对路径和平台文件 ID，以 ./ 或 ../ 开头会抛 TypeError。 */
  image(
    source: string | Buffer | URL,
    options: { url?: string; summary?: string } = {},
  ): TypedSegment<'image'> {
    return { type: 'image', data: { file: mediaSource(source), ...options } }
  },
  /** 构造语音段；支持 Buffer、URL、绝对路径和平台文件 ID，以 ./ 或 ../ 开头会抛 TypeError。 */
  audio(source: string | Buffer | URL, options: { url?: string } = {}): TypedSegment<'audio'> {
    return { type: 'audio', data: { file: mediaSource(source), ...options } }
  },
  /** 构造视频段；支持 Buffer、URL、绝对路径和平台文件 ID，以 ./ 或 ../ 开头会抛 TypeError。 */
  video(source: string | Buffer | URL, options: { url?: string } = {}): TypedSegment<'video'> {
    return { type: 'video', data: { file: mediaSource(source), ...options } }
  },
  /** 构造引用指定消息 ID 的回复段。 */
  reply(id: string | number): TypedSegment<'reply'> {
    return { type: 'reply', data: { id: String(id) } }
  },
  /** 构造文件段；支持 Buffer、URL、绝对路径和平台文件 ID，以 ./ 或 ../ 开头会抛 TypeError。 */
  file(source: string | Buffer | URL, options: { name?: string } = {}): TypedSegment<'file'> {
    return { type: 'file', data: { file: mediaSource(source), ...options } }
  },
  /** 构造引用已有合并转发 ID 的消息段。 */
  forward(id: string | number): TypedSegment<'forward'> {
    return { type: 'forward', data: { id: String(id) } }
  },
}

/** 将文本或消息段规范化为消息段数组，字符串按纯文本处理。 */
export function normalizeSendable(content: import('./types.ts').Sendable): import('./types.ts').Message {
  if (typeof content === 'string') {
    return [seg.text(content)]
  }
  return Array.isArray(content) ? [...content] : [content]
}

/** 拼接消息中所有文本段的内容。 */
export function plainText(message: import('./types.ts').Message): string {
  return message
    .filter((segment) => isSegment(segment, 'text'))
    .map((segment) => segment.data.text)
    .join('')
}
