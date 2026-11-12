import type { Segment } from '../../core/message/index.ts'

export function idNumber(value: string): number {
  const number = Number(value)
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new Error(`OneBot IDs must be safe integers, got ${value}`)
  }
  return number
}

export function incomingSegment(segment: { type: string; data: Record<string, unknown> }): Segment {
  const data = { ...segment.data }
  if (segment.type === 'at' && data.qq !== undefined) {
    if (typeof data.qq !== 'string' && typeof data.qq !== 'number') throw new Error('Invalid OneBot at ID')
    data.id = String(data.qq)
    delete data.qq
  }
  if (['reply', 'face', 'forward'].includes(segment.type) && data.id !== undefined) {
    if (typeof data.id !== 'string' && typeof data.id !== 'number')
      throw new Error(`Invalid OneBot ${segment.type} ID`)
    data.id = String(data.id)
  }
  const required: Record<string, string> = {
    text: 'text',
    at: 'id',
    face: 'id',
    image: 'file',
    record: 'file',
    video: 'file',
    file: 'file',
    reply: 'id',
    forward: 'id',
  }
  const field = required[segment.type]
  if (field !== undefined && typeof data[field] !== 'string')
    throw new Error(`Invalid OneBot ${segment.type} ${field}`)
  const optional: Record<string, string[]> = {
    image: ['url', 'summary'],
    record: ['url'],
    video: ['url'],
    file: ['name'],
  }
  for (const key of optional[segment.type] ?? []) {
    if (data[key] !== undefined && typeof data[key] !== 'string')
      throw new Error(`Invalid OneBot ${segment.type} ${key}`)
  }
  return { type: segment.type === 'record' ? 'audio' : segment.type, data } as Segment
}

export function outgoingSegment(segment: Segment): Segment {
  const data: Record<string, unknown> = { ...segment.data }
  if (segment.type === 'at') {
    data.qq = data.id === 'all' ? 'all' : idNumber(String(data.id))
    delete data.id
  }
  // reply/face ids are numeric in OneBot 11; forward ids are opaque resource ids (e.g. NapCat's string resid) and must
  // pass through unchanged so a received forward can be re-sent.
  if (segment.type === 'face' || segment.type === 'reply') {
    data.id = idNumber(String(data.id))
  }
  return { type: segment.type === 'audio' ? 'record' : segment.type, data } as Segment
}
