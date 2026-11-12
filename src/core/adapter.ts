import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from 'pino'
import type { Bot, MessageTarget } from './bot.ts'
import type { AnyEvent, SessionServices } from './event/index.ts'
import type { Message } from './message/index.ts'

export interface OutgoingMessage {
  bot: Bot
  target: MessageTarget
  message: Message
}

export type BeforeSend = (
  input: OutgoingMessage,
) => Message | false | undefined | Promise<Message | false | undefined>

export interface Adapter {
  readonly platform: string
  start(): Promise<void>
  stop(): Promise<void>
  reconfigure(config: unknown): Promise<void>
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
  registerUpgrade(path: string, handler: UpgradeHandler): () => void
  setBotInfo(bot: Bot, info: BotInfo): void
  whenIdle(): Promise<void>
  isSuperuser(userId: string): boolean
  prepareOutgoing(input: OutgoingMessage): Promise<Message>
}

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void
