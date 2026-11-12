import { createHash, timingSafeEqual } from 'node:crypto'

export function constantTimeEqual(actual: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(actual), digest(expected))
}
