import type { Scope } from '../dispatch/types.ts'
import { type Permission, type Rule, resolvePermission } from '../permission.ts'
import type { CooldownScope } from '../ratelimit.ts'
import { parseDuration } from '../utils/duration.ts'
import {
  type ArgumentDefinition,
  type ArgumentSettings,
  type Declaration,
  parseArgument,
  parseDeclaration,
} from './declaration.ts'
import type { CommandAction, CommandArgs, OptionValue } from './types.ts'

export interface OptionSettings<T = unknown> extends ArgumentSettings<T> {
  default?: T
}

export interface OptionDefinition {
  name: string
  flags: string[]
  argument?: ArgumentDefinition
  defaultValue?: unknown
  description?: string
  settings?: ArgumentSettings
}

export interface CommandDefinition extends Declaration {
  owner: string
  scope: Scope
  aliases: string[]
  description: string
  options: OptionDefinition[]
  permission?: Rule
  cooldown?: { duration: number; scope: CooldownScope }
  messageScope: 'all' | 'group' | 'private'
  hidden: boolean
  examples: string[]
  action?: CommandAction
}

export interface CommandRegistration {
  addAlias(command: CommandDefinition, alias: string): void
  dispose(command: CommandDefinition): void
}

function parseOption<T>(name: string, source: string, settings: OptionSettings<T>): OptionDefinition {
  if (!/^[\w-]+$/.test(name)) throw new Error(`无效的选项名：${name}`)
  const match = /^\s*((?:--?[\w-]+\s*,\s*)*--?[\w-]+)(?:\s+(<[^>]+>|\[[^\]]+\]))?\s*$/.exec(source)
  if (!match) throw new Error(`无效的选项声明：${source}`)
  const flags = (match[1] as string).split(/\s*,\s*/)
  if (new Set(flags).size !== flags.length) throw new Error(`重复的选项标志：${source}`)
  const argument = match[2] === undefined ? undefined : parseArgument(match[2])
  if (argument?.type === 'rest') throw new Error('选项不支持 rest 类型')
  let defaultValue = settings.default !== undefined ? settings.default : argument?.defaultValue
  if (defaultValue !== undefined) {
    if (argument === undefined) {
      if (typeof defaultValue !== 'boolean') throw new Error(`选项 ${name} 的默认值应为布尔值`)
    } else {
      const type = argument.type
      const valid =
        type === 'string' || type === 'user' || type.includes('|')
          ? typeof defaultValue === 'string' &&
            (type !== 'user' || (defaultValue.length > 0 && !/\s/.test(defaultValue))) &&
            (!type.includes('|') || type.split('|').includes(defaultValue))
          : type === 'date'
            ? defaultValue instanceof Date && !Number.isNaN(defaultValue.getTime())
            : type === 'number' ||
                type === 'integer' ||
                type === 'posint' ||
                type === 'natural' ||
                type === 'duration'
              ? typeof defaultValue === 'number' &&
                Number.isFinite(defaultValue) &&
                (!['integer', 'posint', 'natural'].includes(type) || Number.isSafeInteger(defaultValue)) &&
                (!['natural', 'duration'].includes(type) || defaultValue >= 0) &&
                (type !== 'posint' || defaultValue > 0)
              : type === 'boolean'
                ? typeof defaultValue === 'boolean'
                : typeof defaultValue === 'object' &&
                  defaultValue !== null &&
                  'type' in defaultValue &&
                  defaultValue.type === 'image' &&
                  'data' in defaultValue &&
                  typeof defaultValue.data === 'object' &&
                  defaultValue.data !== null &&
                  'file' in defaultValue.data &&
                  typeof defaultValue.data.file === 'string'
      if (!valid) throw new Error(`选项 ${name} 的默认值类型无效`)
    }
  } else if (argument === undefined) {
    defaultValue = false
  }
  return {
    name,
    flags,
    ...(argument === undefined ? {} : { argument }),
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(settings.description === undefined ? {} : { description: settings.description }),
    settings: settings as ArgumentSettings,
  }
}

export class CommandBuilder<Decl extends string = string, Options = object> {
  readonly definition: CommandDefinition
  private readonly registration: CommandRegistration

  constructor(scope: Scope, declaration: Decl, registration: CommandRegistration) {
    this.registration = registration
    this.definition = {
      ...parseDeclaration(declaration),
      owner: scope.owner,
      scope,
      aliases: [],
      description: '',
      options: [],
      messageScope: 'all',
      hidden: false,
      examples: [],
    }
  }

  alias(name: string): this {
    // The alias is a full command path (may contain spaces); the registration validates and normalizes it.
    this.registration.addAlias(this.definition, name)
    this.definition.aliases.push(name.trim().split(/\s+/).join(' '))
    return this
  }

  description(text: string): this {
    this.definition.description = text
    return this
  }

  arg<const Name extends keyof CommandArgs<Decl> & string>(
    name: Name,
    settings: ArgumentSettings<CommandArgs<Decl>[Name]>,
  ): this {
    const argument = this.definition.arguments.find((item) => item.name === name)
    if (!argument) throw new Error(`未声明的参数：${name}`)
    argument.settings = settings as ArgumentSettings
    return this
  }

  option<const Name extends string, const Spec extends string>(
    name: Name,
    spec: Spec,
    settings: OptionSettings<OptionValue<Spec>> & { default: OptionValue<Spec> },
  ): CommandBuilder<Decl, Options & Record<Name, OptionValue<Spec>>>
  option<const Name extends string, const Spec extends string>(
    name: Name,
    spec: Spec,
    settings?: OptionSettings<OptionValue<Spec>> & { default?: never },
  ): CommandBuilder<
    Decl,
    Options &
      Record<
        Name,
        | OptionValue<Spec>
        | (Spec extends `${string}<${string}>${string}` | `${string}[${string}]${string}` ? undefined : never)
      >
  >
  option<T>(name: string, spec: string, settings: OptionSettings<T> = {}): CommandBuilder<Decl, Options> {
    const option = parseOption(name, spec, settings)
    if (
      this.definition.options.some(
        (item) => item.name === name || item.flags.some((flag) => option.flags.includes(flag)),
      )
    ) {
      throw new Error(`选项名或标志冲突：${name}`)
    }
    this.definition.options.push(option)
    return this
  }

  permission(rule: Permission): this {
    this.definition.permission = resolvePermission(rule)
    return this
  }
  cooldown(duration: string | number, options: { scope?: CooldownScope } = {}): this {
    this.definition.cooldown = { duration: parseDuration(duration), scope: options.scope ?? 'user' }
    return this
  }
  scope(scope: 'group' | 'private' | 'all'): this {
    this.definition.messageScope = scope
    return this
  }
  hidden(value = true): this {
    this.definition.hidden = value
    return this
  }
  example(text: string): this {
    this.definition.examples.push(text)
    return this
  }
  action(handler: CommandAction<CommandArgs<Decl>, Options>): this {
    this.definition.action = handler as CommandAction
    return this
  }
  dispose(): void {
    this.registration.dispose(this.definition)
  }
}
