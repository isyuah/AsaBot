import type { AnyEvent, Session } from '../event/index.ts'
import type { Sendable } from '../message/index.ts'

export interface Scope {
  owner: string
  signal?: AbortSignal
}

export type Disposer = () => void
export type Middleware = (
  session: Session,
  next: () => Promise<void>,
  signal: AbortSignal,
) => void | Promise<void>
export type MatchPattern = string | RegExp | ((session: Session) => boolean)
export type MatchHandler = (
  session: Session,
  signal: AbortSignal,
) => Sendable | void | Promise<Sendable | undefined> | Promise<void>
export type AccessFilter = (event: AnyEvent) => boolean
export type EnabledFilter = (owner: string, event: AnyEvent) => boolean
