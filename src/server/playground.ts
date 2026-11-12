import type { z } from 'zod'
import { VirtualAdapter } from '../adapters/virtual/index.ts'
import type { App } from '../core/app.ts'
import type { Message } from '../core/message/index.ts'
import { plainText } from '../core/message/index.ts'
import type { playgroundSchema } from './schemas.ts'

interface Reply {
  message: Message
  text: string
}

export class Playground {
  private readonly virtual: VirtualAdapter

  constructor(app: App) {
    this.virtual = new VirtualAdapter(app, { selfId: 'playground' })
    app.excludeBotFromStats(this.virtual.bot)
  }

  async run(input: z.output<typeof playgroundSchema>): Promise<{ replies: Reply[] }> {
    const sent = await this.virtual.receive(input.message ?? input.text ?? '', {
      user: input.user.id,
      nickname: input.user.nickname,
      role: input.user.role,
      superuser: input.user.superuser ?? false,
      group: input.group,
    })
    return { replies: sent.map(({ message }) => ({ message, text: plainText(message) })) }
  }
}
