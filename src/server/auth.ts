import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const sessionLifetime = 7 * 24 * 60 * 60 * 1_000
const attemptWindow = 60_000

export function constantTimeEqual(actual: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(actual), digest(expected))
}

export class PanelAuth {
  private readonly sessions = new Map<string, number>()
  private readonly attempts = new Map<string, number[]>()

  attempt(ip: string): boolean {
    const now = Date.now()
    for (const [key, timestamps] of this.attempts) {
      if ((timestamps.at(-1) ?? 0) <= now - attemptWindow) this.attempts.delete(key)
    }
    const recent = (this.attempts.get(ip) ?? []).filter((time) => time > now - attemptWindow)
    if (recent.length >= 10) return false
    recent.push(now)
    this.attempts.set(ip, recent)
    return true
  }

  create(): string {
    const now = Date.now()
    for (const [token, expires] of this.sessions) if (expires <= now) this.sessions.delete(token)
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(token, now + sessionLifetime)
    return token
  }

  authenticated(cookie: string | undefined): boolean {
    const token = this.token(cookie)
    if (!token) return false
    const expires = this.sessions.get(token)
    if (expires === undefined) return false
    if (expires <= Date.now()) {
      this.sessions.delete(token)
      return false
    }
    return true
  }

  remove(cookie: string | undefined): void {
    const token = this.token(cookie)
    if (token) this.sessions.delete(token)
  }

  private token(cookie: string | undefined): string | undefined {
    return cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('asabot_session='))
      ?.slice('asabot_session='.length)
  }
}
