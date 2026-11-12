import type { Session } from '../event/index.ts'
import type { Message, Segment, Sendable } from '../message/index.ts'

export type ArgumentValue<T extends string> = T extends 'number' | 'integer' | 'duration'
  ? number
  : T extends 'boolean'
    ? boolean
    : T extends 'image'
      ? Extract<Segment, { type: 'image' }>
      : T extends 'rest'
        ? Message
        : string

type ParameterParts<S extends string> = S extends `${infer Name}:${infer Type}` ? [Name, Type] : [S, 'string']
type Parameter<S extends string> =
  ParameterParts<S> extends [infer N extends string, infer T extends string]
    ? Record<N, ArgumentValue<T>>
    : never
type ArgumentPart<S extends string> = S extends `<${infer Inner}>`
  ? Parameter<Inner>
  : S extends `[${infer Inner}]`
    ? Inner extends `${infer Base}=${string}`
      ? Parameter<Base>
      : { [K in keyof Parameter<Inner>]: Parameter<Inner>[K] | undefined }
    : object
type ParseParts<S extends string> = S extends `${infer Head} ${infer Tail}`
  ? ArgumentPart<Head> & ParseParts<Tail>
  : ArgumentPart<S>
export type CommandArgs<S extends string> = string extends S ? Record<string, unknown> : ParseParts<S>
export type OptionValue<S extends string> = string extends S
  ? unknown
  : S extends `${string}<${infer Inner}>${string}`
    ? ParameterParts<Inner> extends [string, infer T extends string]
      ? ArgumentValue<T>
      : unknown
    : S extends `${string}[${infer Inner}]${string}`
      ? ParameterParts<Inner> extends [string, infer T extends string]
        ? ArgumentValue<T>
        : unknown
      : boolean

export interface CommandContext<Args = Record<string, unknown>, Options = Record<string, unknown>> {
  session: Session
  args: Args
  options: Options
  signal: AbortSignal
}

export type CommandAction<Args = Record<string, unknown>, Options = Record<string, unknown>> = (
  context: CommandContext<Args, Options>,
) => Sendable | void | Promise<Sendable | undefined> | Promise<void>
