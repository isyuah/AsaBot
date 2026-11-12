import { z } from 'zod'
import { durationSchema } from '../../core/config/schema.ts'

const connectionSchema = z
  .object({
    type: z.literal('forward').meta({ title: '连接类型', description: '使用正向 WebSocket 连接。' }),
    url: z.url().meta({ title: '连接地址', description: '填写 OneBot 实现的 WebSocket 地址。' }),
    accessToken: z.string().optional().meta({
      title: '访问令牌',
      description: `填写访问令牌，也可以写 \${环境变量} 引用。`,
    }),
  })
  .strict()
  .meta({ title: '正向连接', description: '配置一个 OneBot 正向连接。' })

/** 校验并规范化 OneBot 11 适配器配置的 zod schema。 */
export const onebot11Schema = z
  .object({
    apiTimeout: durationSchema
      .prefault(30_000)
      .meta({ title: 'API 超时', description: '设置 API 请求的超时时间。' }),
    reconnect: z
      .object({
        minDelay: durationSchema
          .prefault(1_000)
          .meta({ title: '最短重连间隔', description: '设置重连等待时间的下限。' }),
        maxDelay: durationSchema
          .prefault(60_000)
          .meta({ title: '最长重连间隔', description: '设置重连等待时间的上限。' }),
      })
      .strict()
      .prefault(() => ({ minDelay: 1_000, maxDelay: 60_000 }))
      .meta({ title: '重连', description: '设置断线后的重连间隔。' }),
    connections: z
      .array(connectionSchema)
      .default([])
      .meta({ title: '正向连接', description: '配置主动连接的 OneBot 服务。' }),
    reverse: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .meta({ title: '启用反向连接', description: '允许 OneBot 实现主动连接。' }),
        accessToken: z.string().default('').meta({
          title: '访问令牌',
          description: `填写访问令牌，也可以写 \${环境变量} 引用。`,
        }),
      })
      .strict()
      .default(() => ({ enabled: false, accessToken: '' }))
      .meta({ title: '反向连接', description: '设置 OneBot 反向 WebSocket 接入。' }),
    sendQueue: z
      .object({
        interval: durationSchema
          .prefault(500)
          .meta({ title: '发送间隔', description: '设置消息发送的最短间隔。' }),
        jitter: durationSchema
          .prefault(300)
          .meta({ title: '随机延迟', description: '设置发送间隔附加的随机延迟。' }),
        maxPending: z
          .number()
          .int()
          .nonnegative()
          .default(100)
          .meta({ title: '队列容量', description: '设置等待发送的消息数量上限。' }),
      })
      .strict()
      .prefault(() => ({ interval: 500, jitter: 300, maxPending: 100 }))
      .meta({ title: '发送队列', description: '设置消息发送速率和队列容量。' }),
  })
  .strict()
  .meta({ title: 'OneBot 11', description: '配置 OneBot 11 连接和消息发送。' })
