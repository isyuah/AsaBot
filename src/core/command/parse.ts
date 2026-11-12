import { messages } from '../dispatch/messages.ts'
import type { CommandDefinition } from './builder.ts'
import { type ArgumentDefinition, type ArgumentSettings, parseValue } from './declaration.ts'
import type { Token, TokenizedMessage } from './tokenizer.ts'

export type ParsedArguments = { args: Record<string, unknown>; options: Record<string, unknown> }

function validate(name: string, value: unknown, settings?: ArgumentSettings): void {
  if (value === undefined || settings === undefined) return
  if (typeof value === 'number') {
    if (settings.min !== undefined && value < settings.min)
      throw new Error(messages.invalid(name, messages.minimum(settings.min)))
    if (settings.max !== undefined && value > settings.max)
      throw new Error(messages.invalid(name, messages.maximum(settings.max)))
  }
  if (typeof value === 'string' && settings.pattern) {
    settings.pattern.lastIndex = 0
    if (!settings.pattern.test(value)) throw new Error(messages.invalid(name, messages.pattern))
  }
  const result = settings.validate?.(value)
  if (typeof result === 'string') throw new Error(messages.validation(name, result))
}

function defaultValue(argument: ArgumentDefinition, timezone: string): unknown {
  return argument.defaultSource === undefined
    ? argument.defaultValue
    : parseValue(argument.type, argument.defaultSource, timezone)
}

/** 根据命令定义及可选前缀生成用法文本。 */
export function formatUsage(
  command: CommandDefinition | { definition: CommandDefinition },
  prefix = '/',
): string {
  const definition = 'definition' in command ? command.definition : command
  const args = definition.arguments.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`))
  return `${prefix}${[...definition.path, ...args].join(' ')}`
}

function remainingPositionals(
  command: CommandDefinition,
  tokens: Token[],
  start: number,
  literal: boolean,
): number {
  let count = 0
  for (let index = start; index < tokens.length; index += 1) {
    const value = tokens[index]?.value
    if (!literal && value === '--') {
      literal = true
      continue
    }
    if (!literal && typeof value === 'string' && /^--?[^\d\s-]/.test(value)) {
      const equals = value.indexOf('=')
      const flag = equals < 0 ? value : value.slice(0, equals)
      const option = command.options.find((item) => item.flags.includes(flag))
      if (option?.argument !== undefined && equals < 0) index += 1
      continue
    }
    count += 1
  }
  return count
}

export function parseArguments(
  command: CommandDefinition,
  source: TokenizedMessage,
  pathLength: number,
  timezone = 'UTC',
): ParsedArguments {
  const args: Record<string, unknown> = Object.create(null)
  const options: Record<string, unknown> = Object.create(null)
  for (const option of command.options)
    options[option.name] =
      option.defaultValue ?? (option.argument ? defaultValue(option.argument, timezone) : undefined)
  const tokens = source.tokens
  let argIndex = 0
  let index = pathLength
  let literal = false
  while (index < tokens.length) {
    const token = tokens[index] as Token
    const value = token.value
    if (!literal && value === '--') {
      literal = true
      index += 1
      continue
    }
    if (!literal && typeof value === 'string' && /^--?[^\d\s-]/.test(value)) {
      if (token.error) throw new Error(messages.unmatchedQuote)
      const equals = value.indexOf('=')
      const flag = equals < 0 ? value : value.slice(0, equals)
      const option = command.options.find((item) => item.flags.includes(flag))
      if (option === undefined) throw new Error(messages.unknownOption(flag))
      if (option.argument === undefined) {
        if (equals >= 0) throw new Error(messages.optionTakesNoValue(flag))
        options[option.name] = true
        index += 1
        continue
      }
      const next = equals >= 0 ? { value: value.slice(equals + 1), start: token.start } : tokens[++index]
      if (next === undefined || next.value === '--') throw new Error(messages.missingOption(flag))
      if (next.error) throw new Error(messages.unmatchedQuote)
      try {
        let input = next.value
        const following = tokens[index + 1]
        if (
          option.argument.type === 'date' &&
          typeof input === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(input) &&
          typeof following?.value === 'string' &&
          /^\d{2}:\d{2}$/.test(following.value)
        ) {
          input += ` ${following.value}`
          index += 1
        }
        options[option.name] = parseValue(option.argument.type, input, timezone)
      } catch (error) {
        throw new Error(
          messages.invalid(option.argument.name, error instanceof Error ? error.message : String(error)),
        )
      }
      index += 1
      continue
    }
    const argument = command.arguments[argIndex]
    if (argument === undefined) throw new Error(messages.extraArgument)
    if (!argument.required) {
      const requiredAfter = command.arguments.slice(argIndex + 1).filter((item) => item.required).length
      if (requiredAfter > 0 && remainingPositionals(command, tokens, index, literal) <= requiredAfter) {
        args[argument.name] = defaultValue(argument, timezone)
        argIndex += 1
        continue
      }
    }
    if (argument.type === 'rest') {
      args[argument.name] = source.rest(token.start)
      index = tokens.length
      argIndex += 1
      break
    }
    if (token.error) throw new Error(messages.unmatchedQuote)
    try {
      let input = value
      const following = tokens[index + 1]
      if (
        argument.type === 'date' &&
        typeof input === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(input) &&
        typeof following?.value === 'string' &&
        /^\d{2}:\d{2}$/.test(following.value)
      ) {
        input += ` ${following.value}`
        index += 1
      }
      args[argument.name] = parseValue(argument.type, input, timezone)
    } catch (error) {
      throw new Error(messages.invalid(argument.name, error instanceof Error ? error.message : String(error)))
    }
    index += 1
    argIndex += 1
  }
  for (const argument of command.arguments.slice(argIndex)) {
    if (argument.required) throw new Error(messages.missing(argument.name))
    args[argument.name] = defaultValue(argument, timezone)
  }
  for (const argument of command.arguments) validate(argument.name, args[argument.name], argument.settings)
  for (const option of command.options)
    validate(option.argument?.name ?? option.name, options[option.name], option.settings)
  return { args, options }
}
