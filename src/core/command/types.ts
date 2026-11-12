import type { Session } from '../event/index.ts'
import type { KnownSegment, Message, Sendable } from '../message/index.ts'

type EnumValues<T extends string> = T extends `${infer First}|${infer Rest}` ? First | EnumValues<Rest> : T

export type ArgumentValue<T extends string> = T extends
  | 'number'
  | 'integer'
  | 'posint'
  | 'natural'
  | 'duration'
  ? number
  : T extends 'boolean'
    ? boolean
    : T extends 'date'
      ? Date
      : T extends 'image'
        ? Extract<KnownSegment, { type: 'image' }>
        : T extends 'rest'
          ? Message
          : T extends `${string}|${string}`
            ? EnumValues<T>
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
/** 从命令声明推导出的参数名称和值类型。 */
export type CommandArgs<S extends string> = string extends S ? Record<string, unknown> : ParseParts<S>
/** 从选项声明推导出的值类型。 */
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

/** 命令处理函数接收的 Session、参数、选项和取消信号。 */
export interface CommandContext<Args = Record<string, unknown>, Options = Record<string, unknown>> {
  session: Session
  args: Args
  options: Options
  signal: AbortSignal
}

/** 处理命令的回调；返回消息时由框架自动发送。 */
export type CommandAction<Args = Record<string, unknown>, Options = Record<string, unknown>> = (
  context: CommandContext<Args, Options>,
) => Sendable | void | Promise<Sendable | undefined> | Promise<void>
