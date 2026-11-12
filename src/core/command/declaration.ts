import type { Message, Segment } from '../message/index.ts'
import { parseDuration } from '../utils/duration.ts'

export type ArgumentType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'user'
  | 'duration'
  | 'image'
  | 'rest'

export interface ArgumentDefinition {
  name: string
  type: ArgumentType
  required: boolean
  defaultValue?: unknown
}

export interface Declaration {
  path: string[]
  arguments: ArgumentDefinition[]
}

const types: ArgumentType[] = ['string', 'number', 'integer', 'boolean', 'user', 'duration', 'image', 'rest']

export function parseValue(type: ArgumentType, value: string | Segment): unknown {
  if (type === 'image') {
    if (typeof value !== 'string' && value.type === 'image' && typeof value.data.file === 'string')
      return value
    throw new Error('图片')
  }
  if (type === 'user') {
    if (
      typeof value !== 'string' &&
      value.type === 'at' &&
      typeof value.data.id === 'string' &&
      value.data.id
    ) {
      return value.data.id
    }
    if (typeof value === 'string' && value.length > 0 && !/\s/.test(value)) return value
    throw new Error('用户 ID 或 @用户')
  }
  if (type === 'rest') {
    return typeof value === 'string' ? ([{ type: 'text', data: { text: value } }] satisfies Message) : [value]
  }
  if (typeof value !== 'string') {
    const expected = {
      string: '文本',
      number: '数字',
      integer: '整数',
      boolean: '布尔值（true 或 false）',
      duration: '时长（如 10s）',
    }
    throw new Error(expected[type])
  }
  switch (type) {
    case 'string':
      return value
    case 'number': {
      const number = Number(value)
      if (value.trim() !== '' && Number.isFinite(number)) return number
      throw new Error('数字')
    }
    case 'integer': {
      const number = Number(value)
      if (/^[+-]?\d+$/.test(value) && Number.isSafeInteger(number)) return number
      throw new Error('整数')
    }
    case 'boolean':
      if (value === 'true') return true
      if (value === 'false') return false
      throw new Error('布尔值（true 或 false）')
    case 'duration':
      try {
        return parseDuration(value)
      } catch {
        throw new Error('时长（如 10s）')
      }
  }
}

export function parseArgument(source: string): ArgumentDefinition {
  const match = /^(?:<([^<>[\]]+)>|\[([^<>[\]]+)\])$/.exec(source)
  if (!match) throw new Error(`无效的参数声明：${source}`)
  const required = match[1] !== undefined
  const body = (match[1] ?? match[2]) as string
  const parsed = /^([\w-]+)(?::([\w-]+))?(?:=(.*))?$/.exec(body)
  if (!parsed) throw new Error(`无效的参数声明：${source}`)
  const name = parsed[1] as string
  const type = parsed[2] ?? 'string'
  if (!types.includes(type as ArgumentType)) throw new Error(`参数 <${name}> 的类型未知：${type}`)
  const defaultSource = parsed[3]
  if (required && defaultSource !== undefined) throw new Error(`必填参数 <${name}> 不能设置默认值`)
  let defaultValue: unknown
  if (defaultSource !== undefined) {
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
    ...(defaultSource === undefined ? {} : { defaultValue }),
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
