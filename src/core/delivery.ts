import type { MessageTarget, SendResult } from './bot.ts'
import {
  ApiTimeoutError,
  NotConnectedError,
  PluginError,
  SendBlockedError,
  SendQueueFullError,
  UnsupportedError,
} from './errors.ts'
import type { BotIdentity } from './identity.ts'
import type { Target } from './target.ts'
import { redactText } from './utils/redact.ts'

const messages = {
  NO_BOT_ONLINE: '没有匹配的在线机器人',
  RATE_LIMITED: '发送受限，请稍后重试',
  CONVERSATION_UNAVAILABLE: '目标会话不可用',
  DELIVERY_TIMEOUT: '等待发送回执超时，消息可能已送达',
  DELIVERY_UNCONFIRMED: '未能确认消息是否送达',
  DELIVERY_REJECTED: '平台拒绝了消息',
  DELIVERY_UNSUPPORTED: '此机器人不支持该发送方式',
  DELIVERY_BLOCKED: '消息被发送规则拦截',
  DELIVERY_PREPARATION_FAILED: '消息准备失败，请检查内容或附件',
} as const

export type DeliveryCode = keyof typeof messages
export type DeliveryOutcome = 'not_sent' | 'unknown' | 'partial'
export interface DeliveryFailure {
  code: DeliveryCode
  outcome: DeliveryOutcome
  target: Target
  platformCode?: number
  confirmedMessageIds?: readonly string[]
}

interface DeliveryIssue {
  code: DeliveryCode
  outcome?: DeliveryOutcome
  /** For adapter-authored guidance only; never pass a raw platform response. */
  message?: string
  platformCode?: number
  confirmedMessageIds?: readonly string[]
}

/** A failed send with enough information to decide whether repeating it is safe. */
export class DeliveryError extends Error implements DeliveryFailure {
  readonly code: DeliveryCode
  readonly outcome: DeliveryOutcome
  readonly target: Target
  readonly platformCode?: number
  readonly confirmedMessageIds?: readonly string[]

  constructor(target: Target, issue: DeliveryIssue) {
    super(
      issue.outcome === 'partial'
        ? '消息已部分送达，请核对后再重试'
        : (issue.message ?? messages[issue.code]),
    )
    this.name = 'DeliveryError'
    this.code = issue.code
    this.outcome =
      issue.outcome ??
      (issue.code === 'DELIVERY_TIMEOUT' || issue.code === 'DELIVERY_UNCONFIRMED' ? 'unknown' : 'not_sent')
    this.target = {
      platform: target.platform,
      selfId: target.selfId,
      type: target.type,
      id: target.id,
      thread: target.thread,
    }
    this.platformCode = issue.platformCode
    this.confirmedMessageIds = issue.confirmedMessageIds
  }

  failure(): DeliveryFailure {
    const { code, outcome, target, platformCode, confirmedMessageIds } = this
    return { code, outcome, target, platformCode, confirmedMessageIds }
  }

  publicFailure(config: unknown): DeliveryFailure {
    const { platform, selfId, id, type, thread } = this.target
    const redact = (value: string) => redactText(value, config)
    return {
      ...this.failure(),
      target: {
        platform: redact(platform),
        selfId: selfId === undefined ? undefined : redact(selfId),
        id: redact(id),
        type,
        thread: thread && { id: redact(thread.id), rootMessageId: redact(thread.rootMessageId) },
      },
      confirmedMessageIds: this.confirmedMessageIds?.map(redact),
    }
  }
}

function commonIssue(error: unknown): DeliveryIssue | undefined {
  if (error instanceof NotConnectedError) return { code: 'NO_BOT_ONLINE' }
  if (error instanceof ApiTimeoutError) return { code: 'DELIVERY_TIMEOUT' }
  if (error instanceof SendQueueFullError) return { code: 'RATE_LIMITED' }
  if (error instanceof SendBlockedError) return { code: 'DELIVERY_BLOCKED' }
  if (error instanceof UnsupportedError) return { code: 'DELIVERY_UNSUPPORTED' }
}

/** Tracks confirmations within one logical send, including sends split by an adapter or hook. */
export class DeliveryAttempt {
  readonly target: Target
  private readonly confirmed: string[] = []

  constructor(bot: BotIdentity, target: MessageTarget) {
    this.target = { ...target, platform: bot.platform, selfId: bot.selfId }
  }

  confirm<T extends SendResult>(sent: T): T {
    this.confirmed.push(sent.messageId)
    return sent
  }

  async run<T>(work: () => Promise<T>, fallback: DeliveryCode = 'DELIVERY_PREPARATION_FAILED'): Promise<T> {
    try {
      return await work()
    } catch (error) {
      // A plugin policy failure is independent of delivery, unless earlier parts have already been sent.
      if (!this.confirmed.length && error instanceof PluginError) throw error
      const failure =
        error instanceof DeliveryError
          ? error
          : new DeliveryError(this.target, commonIssue(error) ?? { code: fallback })
      if (!this.confirmed.length) throw failure
      throw new DeliveryError(failure.target, {
        ...failure.failure(),
        message: failure.message,
        outcome: 'partial',
        confirmedMessageIds: [...new Set([...this.confirmed, ...(failure.confirmedMessageIds ?? [])])],
      })
    }
  }

  /** Protocol boundary: an unclassified failure after starting a request has an unknown result. */
  async request<T>(
    work: () => Promise<T>,
    classify?: (error: unknown) => DeliveryIssue | undefined,
  ): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof DeliveryError || error instanceof PluginError) throw error
      throw new DeliveryError(
        this.target,
        classify?.(error) ?? commonIssue(error) ?? { code: 'DELIVERY_UNCONFIRMED' },
      )
    }
  }
}
