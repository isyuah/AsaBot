import type { Logger } from 'pino'
import type { Bot } from './bot.ts'
import type { AnyEvent } from './event/index.ts'

export interface Adapter {
  readonly platform: string
  start(): Promise<void>
  stop(): Promise<void>
}

export interface AdapterHost {
  readonly logger: Logger
  emit(event: AnyEvent): void
  registerBot(bot: Bot): void
  unregisterBot(bot: Bot): void
  isSuperuser(userId: string): boolean
}
