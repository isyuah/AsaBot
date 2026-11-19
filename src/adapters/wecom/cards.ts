import { randomUUID } from 'node:crypto'
import type { TemplateCard } from '@wecom/aibot-node-sdk'
import { z } from 'zod'

const cardType = z.enum([
  'text_notice',
  'news_notice',
  'button_interaction',
  'vote_interaction',
  'multiple_interaction',
])
export const feedbackIdSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= 256, '反馈 ID 不能超过 256 字节')
export const cardSchema = z.looseObject({
  card_type: cardType,
  task_id: z
    .string()
    .regex(/^[\w@-]{1,128}$/)
    .optional(),
  feedback: z.object({ id: feedbackIdSchema }).optional(),
})
export type WecomTemplateCard = Omit<TemplateCard, 'card_type'> & { card_type: z.output<typeof cardType> }
export type WecomCardSegment = { type: 'wecom:card'; data: { card: z.output<typeof cardSchema> } }

export function cardForSend(card: z.output<typeof cardSchema>): z.output<typeof cardSchema> {
  const interactive = card.card_type !== 'text_notice' && card.card_type !== 'news_notice'
  return !card.task_id && (interactive || card.action_menu) ? { ...card, task_id: randomUUID() } : card
}

export const wecom = {
  card(card: WecomTemplateCard): WecomCardSegment {
    return { type: 'wecom:card', data: { card: cardSchema.parse(card) } }
  },
}
