import type { AnyEvent, Session } from '../event/index.ts'
import type { Sendable } from '../message/index.ts'
import type { PluginStateEvent } from '../plugin/types.ts'

/** 可由分发器处理的聊天或插件状态事件。 */
export type DispatchEvent = AnyEvent | PluginStateEvent

/** 处理器所属插件及可选取消信号和事件过滤条件。 */
export interface Scope {
  owner: string
  signal?: AbortSignal
  filter?: (event: DispatchEvent) => boolean
}

/** 由平台和群 ID 生成群标识；没有群 ID 时返回 undefined。 */
export function groupKeyOf(event: { platform: string; selfId: string; groupId: string }): string
export function groupKeyOf(event: { platform: string; selfId: string; groupId?: string }): string | undefined
export function groupKeyOf(event: {
  platform: string
  selfId: string
  groupId?: string
}): string | undefined {
  return event.groupId === undefined ? undefined : `${event.platform}:${event.selfId}:group:${event.groupId}`
}

/** 调用后注销对应资源的函数。 */
export type Disposer = () => void
/** 消息中间件；调用 next 才继续执行后续管线。 */
export type Middleware = (
  session: Session,
  next: () => Promise<void>,
  signal: AbortSignal,
) => void | Promise<void>
/** 消息匹配器支持的字符串、正则或会话判断函数。 */
export type MatchPattern = string | RegExp | ((session: Session) => boolean)
/** 消息匹配成功后的处理函数，可返回消息自动发送。 */
export type MatchHandler = (context: {
  session: Session
  signal: AbortSignal
  match?: RegExpExecArray
}) => Sendable | void | Promise<Sendable | undefined> | Promise<void>
/** 判断事件是否通过访问控制的函数。 */
export type AccessFilter = (event: DispatchEvent) => boolean
/** 判断插件是否可处理指定事件的函数。 */
export type EnabledFilter = (owner: string, event: DispatchEvent) => boolean
