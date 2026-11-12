import type { Message, Segment } from '../message/index.ts'
import { isSegment } from '../message/index.ts'

interface Unit {
  segment: number
  offset: number
  value: string | Segment
}

export interface Token {
  value: string | Segment
  start: number
  error?: 'unmatchedQuote'
}

export interface TokenizedMessage {
  tokens: Token[]
  rest(start: number): Message
}

export function tokenize(message: Message): TokenizedMessage {
  const units: Unit[] = []
  for (const [segment, part] of message.entries()) {
    if (isSegment(part, 'text')) {
      const text = part.data.text
      for (let offset = 0; offset < text.length; offset += 1) {
        units.push({ segment, offset, value: text[offset] as string })
      }
    } else {
      units.push({ segment, offset: 0, value: part })
    }
  }

  const tokens: Token[] = []
  let index = 0
  while (index < units.length) {
    const current = units[index] as Unit
    if (typeof current.value === 'string' && /\s/.test(current.value)) {
      index += 1
      continue
    }
    const start = index
    if (typeof current.value !== 'string') {
      tokens.push({ value: current.value, start })
      index += 1
      continue
    }
    let value = ''
    let quote: string | undefined
    while (index < units.length) {
      const character = (units[index] as Unit).value
      if (typeof character !== 'string') break
      if (quote === undefined && /\s/.test(character)) break
      if (character === quote) {
        quote = undefined
      } else if (quote === undefined && (character === '"' || character === "'")) {
        quote = character
      } else if (quote !== undefined && character === '\\' && index + 1 < units.length) {
        const next = (units[index + 1] as Unit).value
        if (next === quote || next === '\\') {
          value += next
          index += 1
        } else {
          value += character
        }
      } else {
        value += character
      }
      index += 1
    }
    tokens.push({ value, start, ...(quote === undefined ? {} : { error: 'unmatchedQuote' as const }) })
  }

  return {
    tokens,
    rest(start) {
      const unit = units[start]
      if (unit === undefined) return []
      const result = message.slice(unit.segment)
      const first = result[0]
      if (first && isSegment(first, 'text')) {
        result[0] = { type: 'text', data: { text: first.data.text.slice(unit.offset) } }
      }
      return result
    },
  }
}
