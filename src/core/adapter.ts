import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from 'pino'
import type { z } from 'zod'
import type { Bot, BotCapabilities, MessageTarget, MessageThread, SendResult } from './bot.ts'
import type { ApiCall } from './dispatch/api.ts'
import type { AnyEvent, SessionServices } from './event/index.ts'
import type { ActorIdentity } from './identity.ts'
import type { Message, Sendable } from './message/index.ts'
import type { KVStore } from './storage/index.ts'

/** 发送前钩子接收的机器人、目标和消息。 */
export interface OutgoingMessage {
  bot: Bot
  target: MessageTarget
  message: Message
  /** 创建话题时，接管发送的钩子可用它发送首段并获取后续分段的目标。 */
  sendFirst?: (content: Sendable) => Promise<SendResult & { thread: MessageThread }>
  /** 接管发送的钩子可用它沿原回调通道发送每一段。 */
  sendPart?: (content: Sendable) => Promise<SendResult>
}

/**
 * A hook takes over delivery (e.g. as a merged forward or several messages). `deliver` runs after the hook chain,
 * outside the hook timeout; sends inside it skip the hooks but are still lowered to the bot's capabilities.
 */
/** 发送前钩子可返回的接管发送操作。 */
export interface Delivery {
  deliver: () => Promise<SendResult>
}
/** What an adapter sends: the final message, or the result of a delivery a hook already performed. */
/** 发送前处理后的消息，或钩子已完成的发送结果。 */
export type PreparedOutgoing = Message | { sent: SendResult }
/** 发送前钩子：可替换消息、接管发送、返回 false 拦截或返回 undefined 保持原样。 */
export type BeforeSend = (
  input: OutgoingMessage,
) => Message | Delivery | false | undefined | Promise<Message | Delivery | false | undefined>

/** 平台适配器的生命周期接口，负责连接、停止和重新配置。 */
export interface Adapter {
  readonly platform: string
  start(): Promise<void>
  stop(): Promise<void>
  reconfigure(config: unknown): Promise<void>
}

/** 适配器提供的机器人连接方式及可选地址。 */
export interface BotInfo {
  connection: string
  connectionId?: string
  url?: string
}

/** 框架提供给适配器的事件、机器人、发送和 API 服务。 */
export interface AdapterHost {
  readonly connection?: {
    id: string
    store: Pick<KVStore, 'get' | 'set'>
    update(state: {
      state: 'connecting' | 'waiting' | 'online' | 'retrying' | 'error' | 'offline' | 'reauthorize'
      error?: string
      nextRetryAt?: number
    }): void
  }
  readonly logger: Logger
  readonly sessionServices: SessionServices
  readonly ignoreSelf: boolean
  emit(event: AnyEvent): void
  registerBot(bot: Bot): void
  unregisterBot(bot: Bot): void
  registerUpgrade(path: string, handler: UpgradeHandler): () => void
  setBotInfo(bot: Bot, info: BotInfo): void
  whenIdle(): Promise<void>
  isSuperuser(actor: ActorIdentity): boolean
  isBotAdmin(actor: ActorIdentity): boolean
  prepareOutgoing(input: OutgoingMessage): Promise<PreparedOutgoing>
  invokeApi(call: ApiCall, execute: (args: unknown[]) => Promise<unknown>): Promise<unknown>
}

export type QrSetupUpdate =
  | { status: 'waiting' | 'scanned' | 'expired' | 'already-bound' }
  | { status: 'verification'; retry: boolean }
  | { status: 'authorized'; config: unknown; adminUserId?: string }

export interface QrSetupChallenge {
  content: string
  poll(verifyCode?: string): Promise<QrSetupUpdate>
}

export interface QrConnectionSetup {
  kind: 'qr'
  start(signal: AbortSignal): Promise<QrSetupChallenge>
}

interface AdapterMetadata {
  id: string
  platform: string
  name: string
  version: string
  description: string
  connectionTypes: string[]
  capabilities: BotCapabilities
}

type AdapterOptions<T> = AdapterMetadata & {
  configSchema: z.ZodType<T>
  create(config: T, host: AdapterHost): Adapter
} & (
    | { setup: QrConnectionSetup; accountId(config: T): string }
    | { setup?: undefined; accountId?(config: T): string }
  )

/** 独立适配器包的公开契约；配置由框架在创建连接前校验。 */
export type AdapterDefinition = AdapterOptions<unknown>

export function defineAdapter<T>(definition: AdapterOptions<T>): AdapterDefinition {
  const { setup, accountId, ...metadata } = definition
  const shared = {
    ...metadata,
    create: (config: unknown, host: AdapterHost) => definition.create(config as T, host),
  }
  if (setup) return { ...shared, setup, accountId: (config) => accountId(config as T) }
  return { ...shared, ...(accountId && { accountId: (config: unknown) => accountId(config as T) }) }
}

/** 处理 HTTP 升级请求的适配器回调。 */
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void
