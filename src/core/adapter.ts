import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from 'pino'
import type { Bot, MessageTarget, SendResult } from './bot.ts'
import type { ApiCall } from './dispatch/api.ts'
import type { AnyEvent, SessionServices } from './event/index.ts'
import type { Message } from './message/index.ts'

export interface OutgoingMessage {
  bot: Bot
  target: MessageTarget
  message: Message
}

/**
 * A hook takes over delivery (e.g. as a merged forward or several messages). `deliver` runs after the hook chain,
 * outside the hook timeout; sends inside it skip the hooks but are still lowered to the bot's capabilities.
 */
export interface Delivery {
  deliver: () => Promise<SendResult>
}
/** What an adapter sends: the final message, or the result of a delivery a hook already performed. */
export type PreparedOutgoing = Message | { sent: SendResult }
export type BeforeSend = (
  input: OutgoingMessage,
) => Message | Delivery | false | undefined | Promise<Message | Delivery | false | undefined>

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
  prepareOutgoing(input: OutgoingMessage): Promise<PreparedOutgoing>
  invokeApi(call: ApiCall, execute: (args: unknown[]) => Promise<unknown>): Promise<unknown>
}

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void
