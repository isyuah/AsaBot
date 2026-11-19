import type { MessageThread } from '../../core/bot.ts'
import type { AnyEvent, PlatformNoticeEvent } from '../../core/event/index.ts'

interface ReactionEventFields extends PlatformNoticeEvent {
  readonly name: 'notice.feishu.reaction.added' | 'notice.feishu.reaction.removed'
  readonly platformType: 'im.message.reaction.created_v1' | 'im.message.reaction.deleted_v1'
  readonly messageId: string
  readonly thread?: MessageThread
  readonly emoji: string
}

export type FeishuReactionEvent = ReactionEventFields &
  (
    | { readonly operatorType: 'user'; readonly userId: string }
    | { readonly operatorType: 'app'; readonly operatorAppId: string }
  )

export function isFeishuReaction(event: AnyEvent): event is FeishuReactionEvent {
  return (
    event.platform === 'feishu' &&
    (event.name === 'notice.feishu.reaction.added' || event.name === 'notice.feishu.reaction.removed') &&
    'operatorType' in event
  )
}

export interface FeishuMessageReadEvent extends PlatformNoticeEvent {
  readonly name: 'notice.feishu.message.read'
  readonly platformType: 'im.message.message_read_v1'
  readonly userId: string
  readonly messageIds: readonly string[]
}

export function isFeishuMessageRead(event: AnyEvent): event is FeishuMessageReadEvent {
  return event.platform === 'feishu' && event.name === 'notice.feishu.message.read' && 'messageIds' in event
}

export interface FeishuChatUpdatedEvent extends PlatformNoticeEvent {
  readonly name: 'notice.feishu.chat.updated'
  readonly platformType: 'im.chat.updated_v1'
  readonly groupId: string
  readonly before?: Record<string, unknown>
  readonly after?: Record<string, unknown>
}

export function isFeishuChatUpdated(event: AnyEvent): event is FeishuChatUpdatedEvent {
  return (
    event.platform === 'feishu' &&
    event.name === 'notice.feishu.chat.updated' &&
    'groupId' in event &&
    typeof event.groupId === 'string'
  )
}
