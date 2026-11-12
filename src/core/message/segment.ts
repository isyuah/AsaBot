import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Segment } from './types.ts'

type TypedSegment<K extends Segment['type']> = Extract<Segment, { type: K }>

function mediaSource(source: string | Buffer): string {
  if (Buffer.isBuffer(source)) {
    return `base64://${source.toString('base64')}`
  }
  if (/^(?:https?|base64|file):\/\//i.test(source)) {
    return source
  }
  return pathToFileURL(resolve(source)).href
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
  image(source: string | Buffer, options: { url?: string; summary?: string } = {}): TypedSegment<'image'> {
    return { type: 'image', data: { file: mediaSource(source), ...options } }
  },
  audio(source: string | Buffer, options: { url?: string } = {}): TypedSegment<'audio'> {
    return { type: 'audio', data: { file: mediaSource(source), ...options } }
  },
  video(source: string | Buffer, options: { url?: string } = {}): TypedSegment<'video'> {
    return { type: 'video', data: { file: mediaSource(source), ...options } }
  },
  reply(id: string | number): TypedSegment<'reply'> {
    return { type: 'reply', data: { id: String(id) } }
  },
  file(source: string | Buffer, options: { name?: string } = {}): TypedSegment<'file'> {
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
    .filter(
      (segment): segment is Extract<import('./types.ts').Segment, { type: 'text' }> =>
        segment.type === 'text',
    )
    .map((segment) => segment.data.text)
    .join('')
}
