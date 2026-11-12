import { messages } from '../dispatch/messages.ts'
import type { CommandDefinition } from './builder.ts'
import { parseValue } from './declaration.ts'
import type { Token, TokenizedMessage } from './tokenizer.ts'

export type ParsedArguments = { args: Record<string, unknown>; options: Record<string, unknown> }

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
): ParsedArguments {
  const args: Record<string, unknown> = Object.create(null)
  const options: Record<string, unknown> = Object.create(null)
  for (const option of command.options) options[option.name] = option.defaultValue
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
        options[option.name] = parseValue(option.argument.type, next.value)
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
        args[argument.name] = argument.defaultValue
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
      args[argument.name] = parseValue(argument.type, value)
    } catch (error) {
      throw new Error(messages.invalid(argument.name, error instanceof Error ? error.message : String(error)))
    }
    index += 1
    argIndex += 1
  }
  for (const argument of command.arguments.slice(argIndex)) {
    if (argument.required) throw new Error(messages.missing(argument.name))
    args[argument.name] = argument.defaultValue
  }
  return { args, options }
}
