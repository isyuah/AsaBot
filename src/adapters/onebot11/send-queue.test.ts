import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { SendQueue } from './send-queue.ts'

describe('OneBot send queue', () => {
  it('sends messages in order at least one interval apart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    try {
      const interval = 40
      const queue = new SendQueue({ interval, jitter: 0, maxPending: 10 }, pino({ level: 'silent' }), '10000')
      const sent: string[] = []
      const sends = ['one', 'two', 'three'].map((message) =>
        queue.send(() => {
          sent.push(message)
          return Promise.resolve(message)
        }),
      )

      expect(sent).toEqual(['one'])
      vi.advanceTimersByTime(interval - 1)
      expect(sent).toEqual(['one'])
      vi.advanceTimersByTime(1)
      expect(sent).toEqual(['one', 'two'])
      vi.advanceTimersByTime(interval - 1)
      expect(sent).toEqual(['one', 'two'])
      vi.advanceTimersByTime(1)
      expect(sent).toEqual(['one', 'two', 'three'])
      await expect(Promise.all(sends)).resolves.toEqual(['one', 'two', 'three'])
    } finally {
      vi.useRealTimers()
    }
  })
})
