import { isAbsolute, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { KnownSegment, Segment } from './types.ts'

type TypedSegment<K extends KnownSegment['type']> = Extract<KnownSegment, { type: K }>

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
  if (isAbsolute(source) || win32.isAbsolute(source)) {
    if (process.platform !== 'win32' && win32.isAbsolute(source)) {
      const normalized = source.replaceAll('\\', '/')
      if (normalized.startsWith('//')) {
        const [host, ...parts] = normalized.slice(2).split('/')
        return `file://${host}/${parts.map(encodeURIComponent).join('/')}`
      }
      return `file:///${normalized
        .split('/')
        .map((part, index) => (index === 0 ? part : encodeURIComponent(part)))
        .join('/')}`
    }
    return pathToFileURL(source).href
  }
  if (/^\.\.?\//.test(source)) {
    throw new TypeError('请使用 new URL(..., import.meta.url) 或绝对路径指定本地文件')
  }
  return source
}

export const seg = {
  text(text: string): TypedSegment<'text'> {
    return { type: 'text', data: { text } }
  },
  at(id: string): TypedSegment<'at'> {
    return { type: 'at', data: { id } }
  },
  atAll(): TypedSegment<'at'> {
    return { type: 'at', data: { id: 'all' } }
  },
  face(id: string | number): TypedSegment<'face'> {
    return { type: 'face', data: { id: String(id) } }
  },
  image(
    source: string | Buffer | URL,
    options: { url?: string; summary?: string } = {},
  ): TypedSegment<'image'> {
    return { type: 'image', data: { file: mediaSource(source), ...options } }
  },
  audio(source: string | Buffer | URL, options: { url?: string } = {}): TypedSegment<'audio'> {
    return { type: 'audio', data: { file: mediaSource(source), ...options } }
  },
  video(source: string | Buffer | URL, options: { url?: string } = {}): TypedSegment<'video'> {
    return { type: 'video', data: { file: mediaSource(source), ...options } }
  },
  reply(id: string | number): TypedSegment<'reply'> {
    return { type: 'reply', data: { id: String(id) } }
  },
  file(source: string | Buffer | URL, options: { name?: string } = {}): TypedSegment<'file'> {
    return { type: 'file', data: { file: mediaSource(source), ...options } }
  },
  forward(id: string | number): TypedSegment<'forward'> {
    return { type: 'forward', data: { id: String(id) } }
  },
}

export function normalizeSendable(content: import('./types.ts').Sendable): import('./types.ts').Message {
  if (typeof content === 'string') {
    return [seg.text(content)]
  }
  return Array.isArray(content) ? [...content] : [content]
}

export function plainText(message: import('./types.ts').Message): string {
  return message
    .filter((segment) => isSegment(segment, 'text'))
    .map((segment) => segment.data.text)
    .join('')
}
