import { z } from 'zod'

/** 主动发送目标，包含平台、会话类型、ID 和可选机器人账号。 */
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

/** 将 platform[:selfId]:type:id 字符串解析为发送目标；格式无效时抛错。 */
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

/** 将发送目标格式化为字符串；目标无效时抛错。 */
export function formatTarget(target: Target): string {
  const value = targetObjectSchema.parse(target)
  return [value.platform, ...(value.selfId === undefined ? [] : [value.selfId]), value.type, value.id].join(
    ':',
  )
}

/** 接受目标对象或字符串并转换为 Target 的 zod schema。 */
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
