import { z } from 'zod'
import type { MessageTarget } from './bot.ts'

/** 主动发送目标，包含平台、会话类型、ID 和可选机器人账号。 */
export interface Target extends MessageTarget {
  platform: string
  selfId?: string
}

export const threadSchema = z.object({ id: z.string().min(1), rootMessageId: z.string().min(1) })
export const messageTargetSchema = z.object({
  type: z.enum(['group', 'private']),
  id: z.string().min(1),
  thread: threadSchema.optional(),
})
const targetObjectSchema = messageTargetSchema.extend({
  platform: z
    .string()
    .min(1)
    .regex(/^[^:]+$/),
  selfId: z
    .string()
    .min(1)
    .regex(/^[^:]+$/)
    .optional(),
})
const targetKinds = new Set(['group', 'private', 'group-thread', 'private-thread'])

/** 解析普通会话或话题的发送目标；格式无效时抛错。 */
export function parseTarget(text: string): Target {
  const parts = text.split(':')
  const platform = parts.shift()
  const second = parts.shift()
  const selfId = second !== undefined && targetKinds.has(second) ? undefined : second
  const type = selfId === undefined ? second : parts.shift()
  if (type === 'group-thread' || type === 'private-thread') {
    const [id, threadId, rootMessageId] = z.tuple([z.string(), z.string(), z.string()]).parse(parts)
    return targetObjectSchema.parse({
      platform,
      selfId,
      type: type === 'group-thread' ? 'group' : 'private',
      id: decodeURIComponent(id),
      thread: { id: decodeURIComponent(threadId), rootMessageId: decodeURIComponent(rootMessageId) },
    })
  }
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
  const bot = value.selfId === undefined ? value.platform : `${value.platform}:${value.selfId}`
  const thread = value.thread
  if (!thread) return `${bot}:${value.type}:${value.id}`
  const ids = [value.id, thread.id, thread.rootMessageId].map(encodeURIComponent)
  return [bot, `${value.type}-thread`, ...ids].join(':')
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
