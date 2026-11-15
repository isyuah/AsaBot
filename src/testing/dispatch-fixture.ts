import pino from 'pino'
import { App } from '../core/app.ts'
import { configSchema } from '../core/config/schema.ts'
import type { Session } from '../core/event/index.ts'
import { createSession } from '../core/event/index.ts'
import type { Message } from '../core/message/index.ts'
import { seg } from '../core/message/index.ts'
import { FakeBot } from './fake-bot.ts'

export interface FakeMessageOptions {
  user?: string
  group?: string | null
  role?: 'owner' | 'admin' | 'member'
  superuser?: boolean
}

export function dispatchFixture(config: unknown = {}) {
  const app = new App(configSchema.parse(config), pino({ level: 'silent' }))
  const bot = new FakeBot()
  let nextId = 0
  const session = (message: string | Message, options: FakeMessageOptions = {}): Session => {
    const userId = options.user ?? '1'
    const target =
      options.group === null
        ? { messageType: 'private' as const }
        : { messageType: 'group' as const, groupId: options.group ?? '10' }
    return createSession(
      {
        id: String(++nextId),
        platform: bot.platform,
        selfId: bot.selfId,
        time: Date.now(),
        raw: {},
        bot,
        ...target,
        messageId: String(nextId),
        userId,
        message: typeof message === 'string' ? [seg.text(message)] : message,
        sender: { userId, nickname: userId, ...(options.role === undefined ? {} : { role: options.role }) },
        isSuperuser:
          options.superuser ?? app.isSuperuser({ platform: bot.platform, selfId: bot.selfId, userId }),
        isBotAdmin: app.isBotAdmin({ platform: bot.platform, selfId: bot.selfId, userId }),
      },
      app.sessionServices,
    )
  }
  const say = (message: string | Message, options?: FakeMessageOptions) =>
    app.dispatcher.dispatch(session(message, options))
  return { app, bot, session, say }
}
