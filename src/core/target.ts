import { z } from 'zod'

export interface Target {
  platform: string
  selfId?: string
  type: 'group' | 'private'
  id: string
}

const targetObjectSchema = z.object({
  platform: z
    .string()
    .min(1)
    .regex(/^[^:]+$/),
  selfId: z
    .string()
    .min(1)
    .regex(/^[^:]+$/)
    .optional(),
  type: z.enum(['group', 'private']),
  id: z.string().min(1),
})

export function parseTarget(text: string): Target {
  const parts = text.split(':')
  const platform = parts.shift()
  const second = parts.shift()
  const selfId = second === 'group' || second === 'private' ? undefined : second
  const type = selfId === undefined ? second : parts.shift()
  return targetObjectSchema.parse({
    platform,
    ...(selfId === undefined ? {} : { selfId }),
    type,
    id: parts.join(':'),
  })
}

export function formatTarget(target: Target): string {
  const value = targetObjectSchema.parse(target)
  return [value.platform, ...(value.selfId === undefined ? [] : [value.selfId]), value.type, value.id].join(
    ':',
  )
}

export const targetSchema = z.union([
  targetObjectSchema,
  z.string().transform((text, context) => {
    try {
      return parseTarget(text)
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid target' })
      return z.NEVER
    }
  }),
])
