import { z } from 'zod'
import { durationSchema } from '../../core/config/schema.ts'

const connectionSchema = z
  .object({
    type: z.literal('forward'),
    url: z.url(),
    accessToken: z.string().optional(),
  })
  .strict()

export const onebot11Schema = z
  .object({
    apiTimeout: durationSchema.default(30_000),
    reconnect: z
      .object({
        minDelay: durationSchema.default(1_000),
        maxDelay: durationSchema.default(60_000),
      })
      .strict()
      .default(() => ({ minDelay: 1_000, maxDelay: 60_000 })),
    connections: z.array(connectionSchema).default([]),
    reverse: z
      .object({ accessToken: z.string().default('') })
      .strict()
      .optional(),
    sendQueue: z
      .object({
        interval: durationSchema.default(500),
        jitter: durationSchema.default(300),
        maxPending: z.number().int().nonnegative().default(100),
      })
      .strict()
      .default(() => ({ interval: 500, jitter: 300, maxPending: 100 })),
  })
  .strict()
