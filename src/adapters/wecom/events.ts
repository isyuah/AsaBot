import { z } from 'zod'
import type { SendResult } from '../../core/bot.ts'
import type { AnyEvent, PlatformNoticeEvent } from '../../core/event/index.ts'
import type { Target } from '../../core/target.ts'
import type { WecomBot } from './bot.ts'
import type { WecomTemplateCard } from './cards.ts'
import { platform } from './config.ts'
import { frameHeader, groupChat, inboundFields } from './message.ts'

const selectedItems = z.object({
  selected_item: z.array(
    z.object({
      question_key: z.string(),
      option_ids: z.object({ option_id: z.array(z.string()) }),
    }),
  ),
})

export const eventFrame = frameHeader.extend({
  body: inboundFields
    .extend({
      msgtype: z.literal('event'),
      event: z.discriminatedUnion('eventtype', [
        z.object({ eventtype: z.literal('enter_chat') }),
        z.object({
          eventtype: z.literal('template_card_event'),
          template_card_event: z.object({
            card_type: z.string().min(1),
            event_key: z.string(),
            task_id: z.string().min(1),
            selected_items: selectedItems.optional(),
          }),
        }),
        z.object({
          eventtype: z.literal('feedback_event'),
          feedback_event: z.object({
            id: z.string().min(1),
            type: z.literal([1, 2, 3]),
            content: z.string().optional(),
            inaccurate_reason_list: z.array(z.number().int()).default([]),
          }),
        }),
      ]),
    })
    .and(
      z.discriminatedUnion('chattype', [groupChat, z.object({ chattype: z.literal('single').optional() })]),
    ),
})

interface WecomNotice extends PlatformNoticeEvent {
  readonly platform: typeof platform
  readonly bot: WecomBot
  readonly userId: string
  readonly corpId?: string
  readonly messageId: string
  readonly target: Target & { selfId: string }
}

export interface WecomEnterChatEvent extends WecomNotice {
  readonly name: 'notice.wecom.enter_chat'
  readonly platformType: 'enter_chat'
  replyWelcome(content: string | WecomTemplateCard): Promise<SendResult>
}

export interface WecomCardActionEvent extends WecomNotice {
  readonly name: 'notice.wecom.card.action'
  readonly platformType: 'template_card_event'
  readonly cardType: string
  readonly eventKey: string
  readonly taskId: string
  readonly selectedItems: readonly { questionKey: string; optionIds: readonly string[] }[]
  updateCard(card: WecomTemplateCard, userIds?: string[]): Promise<SendResult>
}

export interface WecomFeedbackEvent extends WecomNotice {
  readonly name: 'notice.wecom.feedback'
  readonly platformType: 'feedback_event'
  readonly feedbackId: string
  readonly feedbackType: 1 | 2 | 3
  readonly content?: string
  readonly inaccurateReasons: readonly number[]
}

export function isWecomEnterChat(event: AnyEvent): event is WecomEnterChatEvent {
  return event.platform === platform && event.name === 'notice.wecom.enter_chat' && 'replyWelcome' in event
}

export function isWecomCardAction(event: AnyEvent): event is WecomCardActionEvent {
  return event.platform === platform && event.name === 'notice.wecom.card.action' && 'updateCard' in event
}

export function isWecomFeedback(event: AnyEvent): event is WecomFeedbackEvent {
  return event.platform === platform && event.name === 'notice.wecom.feedback' && 'feedbackId' in event
}
