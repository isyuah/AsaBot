import { z } from 'zod'
import type { AnyEvent, PlatformNoticeEvent, Session } from '../../core/event/index.ts'
import type { Segment } from '../../core/message/index.ts'

export interface FeishuElement {
  tag: string
  [key: string]: unknown
}
export interface FeishuCard {
  schema: '2.0'
  body: { elements: FeishuElement[]; [key: string]: unknown }
  header?: Record<string, unknown>
  config?: Record<string, unknown>
  [key: string]: unknown
}
export interface FeishuCardResponse {
  toast?: { type: 'success' | 'info' | 'warning' | 'error'; content: string; i18n?: Record<string, string> }
  card?: { type: 'raw'; data: FeishuCard } | { type: 'template'; data: Record<string, unknown> }
}
export interface FeishuCardActionEvent extends PlatformNoticeEvent {
  readonly name: 'notice.feishu.card.action'
  readonly platformType: 'card.action.trigger'
  readonly userId: string
  readonly chatId: string
  readonly messageId: string
  readonly sender: Session['sender']
  readonly action: {
    tag: string
    name?: string
    value: Record<string, unknown>
    inputValue?: string
    option?: string
    options?: string[]
    formValue?: Record<string, unknown>
    timezone?: string
    raw: Record<string, unknown>
  }
  /** Accept the first response within two seconds; returns false after the deadline or shutdown. */
  respond(response: FeishuCardResponse): boolean
}

const record = z.record(z.string(), z.unknown())
export const cardSchema: z.ZodType<FeishuCard> = z
  .object({
    schema: z.literal('2.0'),
    body: z.object({ elements: z.array(z.object({ tag: z.string() }).passthrough()) }).passthrough(),
    header: record.optional(),
    config: record.optional(),
  })
  .passthrough()
export const cardResponseSchema: z.ZodType<FeishuCardResponse> = z
  .object({
    toast: z
      .object({
        type: z.enum(['success', 'info', 'warning', 'error']),
        content: z.string(),
        i18n: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
    card: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('raw'), data: cardSchema }),
        z.object({ type: z.literal('template'), data: record }),
      ])
      .optional(),
  })
  .strict()

export function isFeishuCardAction(event: AnyEvent): event is FeishuCardActionEvent {
  return event.platform === 'feishu' && event.name === 'notice.feishu.card.action' && 'respond' in event
}

const text = (content: string) => ({ tag: 'plain_text', content })

/** Small JSON 2.0 constructors; native fields can be added to the returned objects. */
export const feishu = {
  card(card: FeishuCard): Segment {
    return { type: 'feishu:card', data: { card: cardSchema.parse(card) } }
  },
  message(elements: FeishuElement[], title?: string): FeishuCard {
    return {
      schema: '2.0',
      config: { update_multi: true },
      ...(title ? { header: { title: text(title) } } : {}),
      body: { elements },
    }
  },
  markdown(content: string): FeishuElement {
    return { tag: 'markdown', content }
  },
  button(
    label: string,
    options: {
      name?: string
      value?: Record<string, unknown>
      link?: string
      type?: 'default' | 'primary' | 'danger'
    } = {},
  ): FeishuElement {
    return {
      tag: 'button',
      text: text(label),
      type: options.type ?? 'default',
      ...(options.name ? { name: options.name } : {}),
      behaviors: options.link
        ? [{ type: 'open_url', default_url: options.link }]
        : [{ type: 'callback', value: options.value ?? {} }],
    }
  },
  input(
    name: string,
    options: {
      placeholder?: string
      required?: boolean
      defaultValue?: string
      multiline?: boolean
      value?: Record<string, unknown>
    } = {},
  ): FeishuElement {
    return {
      tag: 'input',
      name,
      ...(options.placeholder ? { placeholder: text(options.placeholder) } : {}),
      ...(options.required === undefined ? {} : { required: options.required }),
      ...(options.defaultValue === undefined ? {} : { default_value: options.defaultValue }),
      ...(options.multiline ? { input_type: 'multiline_text' } : {}),
      behaviors: [{ type: 'callback', value: options.value ?? {} }],
    }
  },
  select(
    name: string,
    choices: { label: string; value: string }[],
    options: {
      placeholder?: string
      required?: boolean
      multiple?: boolean
      value?: Record<string, unknown>
    } = {},
  ): FeishuElement {
    return {
      tag: options.multiple ? 'multi_select_static' : 'select_static',
      name,
      options: choices.map((choice) => ({ text: text(choice.label), value: choice.value })),
      ...(options.placeholder ? { placeholder: text(options.placeholder) } : {}),
      ...(options.required === undefined ? {} : { required: options.required }),
      behaviors: [{ type: 'callback', value: options.value ?? {} }],
    }
  },
  form(name: string, elements: FeishuElement[]): FeishuElement {
    return { tag: 'form', name, elements }
  },
  submit(label: string, name: string, value?: Record<string, unknown>): FeishuElement {
    return {
      tag: 'button',
      text: text(label),
      type: 'primary',
      name,
      form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: value ?? {} }],
    }
  },
}
