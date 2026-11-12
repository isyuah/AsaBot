import { z } from 'zod'

const segment = z
  .object({ type: z.string().min(1), data: z.record(z.string(), z.unknown()) })
  .superRefine((value, context) => {
    const required: Record<string, string> = {
      text: 'text',
      at: 'qq',
      face: 'id',
      image: 'file',
      record: 'file',
      video: 'file',
      reply: 'id',
      file: 'file',
      json: 'data',
      forward: 'id',
    }
    const field = required[value.type]
    if (field && typeof value.data[field] !== 'string') {
      context.addIssue({ code: 'custom', path: ['data', field], message: 'Expected string' })
    }
  })

export const sendSchema = z.object({
  platform: z.string().min(1).optional(),
  selfId: z.string().min(1).optional(),
  target: z.object({ type: z.enum(['group', 'private']), id: z.string().min(1) }),
  message: z.union([z.string(), z.array(segment)]),
})

export const playgroundSchema = z
  .object({
    text: z.string().optional(),
    message: z.array(segment).optional(),
    user: z.object({
      id: z.string().min(1),
      nickname: z.string().optional(),
      role: z.enum(['owner', 'admin', 'member']).optional(),
      superuser: z.boolean().optional(),
    }),
    group: z.string().min(1).nullable().optional(),
  })
  .refine((value) => value.text !== undefined || value.message !== undefined, {
    message: 'text or message is required',
  })

export const accessSchema = z.object({
  list: z.enum(['block', 'allow']),
  subject: z.enum(['user', 'group']),
  key: z.string().regex(/^[^:\s]+:[^\s]+$/, 'Expected platform:id'),
})
