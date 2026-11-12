import { describe, expect, it } from 'vitest'
import { configSchema } from '../config/schema.ts'
import { MessageStats } from './stats.ts'

describe('message statistics timezone', () => {
  it('starts today at midnight in the configured timezone', () => {
    const stats = new MessageStats('Asia/Shanghai')
    const before = Date.parse('2026-01-01T15:59:00Z')
    const after = Date.parse('2026-01-01T16:30:00Z')
    stats.record('received', before)
    expect(stats.today(before)).toEqual({ received: 1, sent: 0 })
    expect(stats.today(after)).toEqual({ received: 0, sent: 0 })
    stats.record('sent', after)
    expect(stats.today(after)).toEqual({ received: 0, sent: 1 })
    expect(stats.range('24h', after).reduce((sum, point) => sum + point.received + point.sent, 0)).toBe(2)
    expect(configSchema.safeParse({ timezone: 'Not/A_Timezone' }).success).toBe(false)
  })
})
