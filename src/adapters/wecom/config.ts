import { z } from 'zod'
import { botIdentitySchema } from '../../core/identity.ts'

export const platform = 'wecom'

export const wecomSchema = z
  .object({
    botId: botIdentitySchema.shape.selfId.meta({ title: 'BotID' }),
    secret: z.string().regex(/^\S+$/).meta({ title: 'Secret', writeOnly: true }),
    botName: z.string().trim().min(1).max(120).optional().meta({ title: '机器人显示名' }),
  })
  .strict()

export type WecomConfig = z.output<typeof wecomSchema>
