import { z } from 'zod'

export const botIdentitySchema = z
  .object({
    platform: z
      .string()
      .min(1)
      .regex(/^[^:\s]+$/)
      .meta({ title: '平台' }),
    selfId: z
      .string()
      .min(1)
      .regex(/^[^:\s]+$/)
      .meta({ title: '机器人 ID' }),
  })
  .strict()
export const actorIdentitySchema = botIdentitySchema
  .extend({
    userId: z.string().min(1).meta({ title: '用户 ID' }),
  })
  .strict()
export type BotIdentity = z.infer<typeof botIdentitySchema>
export type ActorIdentity = z.infer<typeof actorIdentitySchema>
export const botKey = (bot: BotIdentity): string => JSON.stringify([bot.platform, bot.selfId])
export const sameBot = (a: BotIdentity, b: BotIdentity): boolean =>
  a.platform === b.platform && a.selfId === b.selfId

/** 群规则始终隶属于一台机器人。 */
export function groupIdentity(key: string): BotIdentity & { groupId: string } {
  const match = /^([^:\s]+):([^:\s]+):group:(\S+)$/.exec(key)
  if (!match) throw new Error('Invalid bot-scoped group key')
  return botIdentitySchema
    .extend({ groupId: z.string().min(1) })
    .parse({ platform: match[1], selfId: match[2], groupId: match[3] })
}
