import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from 'pino'
import type { Bot } from './bot.ts'
import type { AnyEvent, SessionServices } from './event/index.ts'

export interface Adapter {
  readonly platform: string
  start(): Promise<void>
  stop(): Promise<void>
}

export interface BotInfo {
  connection: string
  url?: string
}

export interface AdapterHost {
  readonly logger: Logger
  readonly sessionServices: SessionServices
  readonly ignoreSelf: boolean
  emit(event: AnyEvent): void
  registerBot(bot: Bot): void
  unregisterBot(bot: Bot): void
  registerUpgrade(path: string, handler: UpgradeHandler): void
  setBotInfo(bot: Bot, info: BotInfo): void
  whenIdle(): Promise<void>
  isSuperuser(userId: string): boolean
}

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void
