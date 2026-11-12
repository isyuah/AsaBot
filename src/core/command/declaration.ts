import { messages } from '../dispatch/messages.ts'
import type { Message, Segment } from '../message/index.ts'
import { isSegment } from '../message/index.ts'
import { parseDuration } from '../utils/duration.ts'

export type ArgumentType =
  | 'string'
  | 'number'
  | 'integer'
  | 'posint'
  | 'natural'
  | 'date'
  | 'boolean'
  | 'user'
  | 'duration'
  | 'image'
  | 'rest'
  | `${string}|${string}`

export interface ArgumentSettings<T = unknown> {
  description?: string
  min?: number
  max?: number
  pattern?: RegExp
  validate?: (value: T) => true | string
}

export interface ArgumentDefinition {
  name: string
  type: ArgumentType
  required: boolean
  defaultValue?: unknown
  defaultSource?: string
  settings?: ArgumentSettings
}

export interface Declaration {
  path: string[]
  arguments: ArgumentDefinition[]
}

const types: ArgumentType[] = [
  'string',
  'number',
  'integer',
  'posint',
  'natural',
  'date',
  'boolean',
  'user',
  'duration',
  'image',
  'rest',
]

type DateParts = [year: number, month: number, day: number, hour: number, minute: number]

function dateParts(date: Date, timezone: string): DateParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    era: 'short',
  })
  const parts = formatter.formatToParts(date)
  const number = (name: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === name)?.value)
  const year = number('year')
  return [
    parts.find((part) => part.type === 'era')?.value === 'BC' ? 1 - year : year,
    number('month'),
    number('day'),
    number('hour'),
    number('minute'),
  ]
}

function utcTimestamp([year, month, day, hour, minute]: DateParts): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, 0, 0)
  return date.getTime()
}

function parseDate(value: string, timezone: string): Date {
  const today = dateParts(new Date(), timezone)
  const full = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(value)
  const partial = /^(\d{2})-(\d{2})$/.exec(value)
  const time = /^(\d{2}):(\d{2})$/.exec(value)
  if (!full && !partial && !time) throw new Error(messages.expected.date)
  const values: DateParts = full
    ? [Number(full[1]), Number(full[2]), Number(full[3]), Number(full[4] ?? 0), Number(full[5] ?? 0)]
    : partial
      ? [today[0], Number(partial[1]), Number(partial[2]), 0, 0]
      : [today[0], today[1], today[2], Number(time?.[1]), Number(time?.[2])]
  const desired = utcTimestamp(values)
  const check = new Date(desired)
  if (
    values[1] < 1 ||
    values[1] > 12 ||
    values[2] < 1 ||
    values[3] > 23 ||
    values[4] > 59 ||
    check.getUTCFullYear() !== values[0] ||
    check.getUTCMonth() + 1 !== values[1] ||
    check.getUTCDate() !== values[2]
  )
    throw new Error(messages.expected.validDate)
  let timestamp = desired
  for (let i = 0; i < 3; i++) {
    const parts = dateParts(new Date(timestamp), timezone)
    const represented = utcTimestamp(parts)
    timestamp += desired - represented
  }
  const result = new Date(timestamp)
  if (!dateParts(result, timezone).every((part, index) => part === values[index]))
    throw new Error(messages.expected.validDate)
  return result
}

export function parseValue(type: ArgumentType, value: string | Segment, timezone = 'UTC'): unknown {
  if (type.includes('|')) {
    const choices = type.split('|')
    if (typeof value === 'string' && choices.includes(value)) return value
    throw new Error(messages.choices(choices))
  }
  if (type === 'image') {
    if (typeof value !== 'string' && isSegment(value, 'image') && typeof value.data.file === 'string')
      return value
    throw new Error(messages.expected.image)
  }
  if (type === 'user') {
    if (
      typeof value !== 'string' &&
      isSegment(value, 'at') &&
      typeof value.data.id === 'string' &&
      value.data.id
    ) {
      return value.data.id
    }
    if (typeof value === 'string' && value.length > 0 && !/\s/.test(value)) return value
    throw new Error(messages.expected.user)
  }
  if (type === 'rest') {
    return typeof value === 'string' ? ([{ type: 'text', data: { text: value } }] satisfies Message) : [value]
  }
  if (typeof value !== 'string') {
    throw new Error(messages.expected[type as keyof typeof messages.expected])
  }
  switch (type) {
    case 'string':
      return value
    case 'number': {
      const number = Number(value)
      if (value.trim() !== '' && Number.isFinite(number)) return number
      throw new Error(messages.expected.number)
    }
    case 'integer': {
      const number = Number(value)
      if (/^[+-]?\d+$/.test(value) && Number.isSafeInteger(number)) return number
      throw new Error(messages.expected.integer)
    }
    case 'posint':
    case 'natural': {
      const number = Number(value)
      if (
        /^\+?\d+$/.test(value) &&
        Number.isSafeInteger(number) &&
        (type === 'posint' ? number > 0 : number >= 0)
      )
        return number
      throw new Error(messages.expected[type])
    }
    case 'date':
      return parseDate(value, timezone)
    case 'boolean':
      if (value === 'true') return true
      if (value === 'false') return false
      throw new Error(messages.expected.boolean)
    case 'duration':
      try {
        return parseDuration(value)
      } catch {
        throw new Error(messages.expected.duration)
      }
  }
}

export function parseArgument(source: string): ArgumentDefinition {
  const match = /^(?:<([^<>[\]]+)>|\[([^<>[\]]+)\])$/.exec(source)
  if (!match) throw new Error(`无效的参数声明：${source}`)
  const required = match[1] !== undefined
  const body = (match[1] ?? match[2]) as string
  const parsed = /^([\w-]+)(?::([^=\s]+))?(?:=(.*))?$/.exec(body)
  if (!parsed) throw new Error(`无效的参数声明：${source}`)
  const name = parsed[1] as string
  const type = parsed[2] ?? 'string'
  if (!types.includes(type as ArgumentType) && !/^[^|\s=]+(?:\|[^|\s=]+)+$/.test(type))
    throw new Error(`参数 <${name}> 的类型未知：${type}`)
  const defaultSource = parsed[3]
  if (required && defaultSource !== undefined) throw new Error(`必填参数 <${name}> 不能设置默认值`)
  let defaultValue: unknown
  if (defaultSource !== undefined && type !== 'date') {
    try {
      defaultValue = parseValue(type as ArgumentType, defaultSource)
    } catch (error) {
      throw new Error(
        `参数 <${name}> 的默认值无效：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return {
    name,
    type: type as ArgumentType,
    required,
    ...(defaultSource === undefined ? {} : type === 'date' ? { defaultSource } : { defaultValue }),
  }
}

export function parseDeclaration(source: string): Declaration {
  const parts = source.trim().split(/\s+/).filter(Boolean)
  const path: string[] = []
  const args: ArgumentDefinition[] = []
  for (const part of parts) {
    if (part.startsWith('<') || part.startsWith('[')) {
      const argument = parseArgument(part)
      if (args.some((item) => item.name === argument.name)) throw new Error(`重复的参数：${argument.name}`)
      if (args.some((item) => item.type === 'rest')) throw new Error('rest 参数必须位于最后')
      args.push(argument)
    } else {
      if (args.length > 0 || /[<>[\]]/.test(part)) throw new Error(`无效的命令声明：${source}`)
      path.push(part)
    }
  }
  if (path.length === 0) throw new Error('命令声明必须包含命令名')
  return { path, arguments: args }
}
