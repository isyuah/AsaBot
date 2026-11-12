import type { Logger } from 'pino'
import type { Bot } from './bot.ts'
import type { AnyEvent, SessionServices } from './event/index.ts'

export interface Adapter {
  readonly platform: string
  start(): Promise<void>
  stop(): Promise<void>
}

export interface BotConnectionInfo {
  connection: 'forward' | 'reverse'
  url?: string
}

export interface AdapterHost {
  readonly logger: Logger
  readonly sessionServices: SessionServices
  emit(event: AnyEvent): void
  registerBot(bot: Bot, connection?: BotConnectionInfo): void
  unregisterBot(bot: Bot): void
  isSuperuser(userId: string): boolean
}
