import type { Message, Segment } from '../../core/message/index.ts'
import { incomingSegment, outgoingSegment } from './conversion.ts'

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('[', '&#91;').replaceAll(']', '&#93;')
}

function escapeParameter(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('[', '&#91;')
    .replaceAll(']', '&#93;')
    .replaceAll(',', '&#44;')
}

function decodeParameter(value: string): string {
  return value
    .replaceAll('&#44;', ',')
    .replaceAll('&#91;', '[')
    .replaceAll('&#93;', ']')
    .replaceAll('&amp;', '&')
}

function decodeText(value: string): string {
  return value.replaceAll('&#91;', '[').replaceAll('&#93;', ']').replaceAll('&amp;', '&')
}

function encodeSegment(segment: Segment): string {
  if (segment.type === 'text') {
    return escapeText(String(segment.data.text))
  }
  const params = Object.entries(segment.data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${escapeParameter(String(value))}`)
    .join(',')
  return `[CQ:${segment.type}${params ? `,${params}` : ''}]`
}

export function toCQ(message: Message): string {
  return message.map((segment) => encodeSegment(outgoingSegment(segment))).join('')
}

function splitParameters(source: string): string[] {
  return source.split(',')
}

export function parseCQ(source: string): Message {
  const message: Message = []
  const pattern = /\[CQ:([\w.-]+)((?:,[^\]]*)?)\]/g
  let cursor = 0
  for (;;) {
    const match = pattern.exec(source)
    if (match === null) {
      break
    }
    if (match.index > cursor) {
      message.push({ type: 'text', data: { text: decodeText(source.slice(cursor, match.index)) } })
    }
    const type = match[1]
    const parameterSource = match[2]
    if (type === undefined || parameterSource === undefined) {
      cursor = match.index + match[0].length
      continue
    }
    const data: Record<string, unknown> = {}
    if (parameterSource.length > 1) {
      for (const part of splitParameters(parameterSource.slice(1))) {
        const equals = part.indexOf('=')
        if (equals <= 0) {
          continue
        }
        const key = part.slice(0, equals)
        data[key] = decodeParameter(part.slice(equals + 1))
      }
    }
    message.push(incomingSegment({ type, data }))
    cursor = match.index + match[0].length
  }
  if (cursor < source.length || message.length === 0) {
    message.push({ type: 'text', data: { text: decodeText(source.slice(cursor)) } })
  }
  return message
}
