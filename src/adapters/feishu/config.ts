import { z } from 'zod'
import { durationSchema } from '../../core/config/schema.ts'

export const feishuSchema = z
  .object({
    accounts: z
      .array(
        z
          .object({
            appId: z
              .string()
              .regex(/^cli_[0-9a-fA-F]{16}$/)
              .meta({ title: 'App ID' }),
            appSecret: z.string().min(1).meta({ title: 'App Secret' }),
          })
          .strict(),
      )
      .default([])
      .refine((accounts) => new Set(accounts.map((a) => a.appId)).size === accounts.length, 'App ID 不能重复')
      .meta({ title: '企业自建应用' }),
    apiTimeout: durationSchema
      .refine((n) => n > 0 && n <= 2_147_483_647)
      .default(30_000)
      .meta({ title: 'API / 媒体超时' }),
    mediaMaxBytes: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024)
      .default(20 * 1024 * 1024)
      .meta({ title: '媒体大小上限（字节）' }),
    dedupCapacity: z.number().int().positive().default(10_000).meta({ title: '事件去重容量' }),
    dedupTtl: durationSchema
      .refine((n) => n > 0)
      .default(600_000)
      .meta({ title: '事件去重有效期' }),
  })
  .strict()
  .meta({ title: '飞书', description: '企业自建应用，通过长连接接收事件与卡片回调。' })

export type FeishuConfig = z.output<typeof feishuSchema>
export type FeishuAccountConfig = FeishuConfig['accounts'][number]
