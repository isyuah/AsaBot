import type { Message, Segment } from '../../core/message/index.ts'
import { parseCQ } from '../../core/message/index.ts'

export function incomingMessage(value: unknown): Message {
  if (typeof value === 'string') {
    return parseCQ(value)
  }
  if (!Array.isArray(value)) {
    throw new Error('OneBot message must be a CQ string or an array of segments')
  }
  return value.map((segment: unknown) => {
    if (segment === null || typeof segment !== 'object') {
      throw new Error('Invalid OneBot message segment')
    }
    const entry = segment as { type?: unknown; data?: unknown }
    if (typeof entry.type !== 'string' || entry.data === null || typeof entry.data !== 'object') {
      throw new Error('Invalid OneBot message segment')
    }
    const data = { ...(entry.data as Record<string, unknown>) }
    if (entry.type === 'at' && data.qq !== undefined) {
      data.qq = String(data.qq)
    }
    if (['reply', 'face', 'forward'].includes(entry.type) && data.id !== undefined) {
      data.id = String(data.id)
    }
    if (entry.type === 'image' && data.sub_type !== undefined) {
      data.subType = Number(data.sub_type)
      delete data.sub_type
    }
    return { type: entry.type, data } as Segment
  })
}
