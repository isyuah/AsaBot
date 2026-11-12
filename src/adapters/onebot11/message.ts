import type { Message } from '../../core/message/index.ts'
import { incomingSegment } from './conversion.ts'
import { parseCQ } from './cq.ts'

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
    return incomingSegment({ type: entry.type, data: entry.data as Record<string, unknown> })
  })
}
