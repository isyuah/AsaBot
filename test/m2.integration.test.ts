import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/bootstrap.ts'
import { configSchema } from '../src/core/config/schema.ts'
import { MockOneBot } from '../src/testing/mock-onebot.ts'

describe('M2 through OneBot', () => {
  it('executes commands and a prompt, delivering unknown commands to matchers', async () => {
    const mock = new MockOneBot()
    await mock.ready
    const app = createApp(
      configSchema.parse({ onebot11: { connections: [{ type: 'forward', url: mock.url }] } }),
      { logger: pino({ level: 'silent' }) },
    )
    try {
      const online = new Promise<void>((resolve) => app.events.on('bot.online', () => resolve()))
      app.dispatcher.command({ owner: 'echo' }, 'echo <text:rest>').action(({ args }) => args.text)
      app.dispatcher.command({ owner: 'ask' }, 'ask').action(async ({ session }) => {
        const answer = await session.prompt('你的名字？')
        return answer === null ? undefined : `你好，${answer.text}`
      })
      const unknown = new Promise<void>((resolve) =>
        app.dispatcher.match({ owner: 'test' }, '/nope', () => resolve()),
      )
      await app.start()
      await online
      mock.emitGroupMessage({ groupId: '200', userId: '300', message: '/echo hi' })
      await mock.waitForCall('send_group_msg', (call) => JSON.stringify(call.params.message).includes('hi'))
      mock.emitGroupMessage({ groupId: '200', userId: '300', message: '/ask' })
      await mock.waitForCall('send_group_msg', (call) =>
        JSON.stringify(call.params.message).includes('你的名字'),
      )
      mock.emitGroupMessage({ groupId: '200', userId: '300', message: 'Alice' })
      await mock.waitForCall('send_group_msg', (call) =>
        JSON.stringify(call.params.message).includes('你好，Alice'),
      )
      mock.emitGroupMessage({ groupId: '200', userId: '300', message: '/nope' })
      await unknown
      expect(
        mock.calls.filter((call) => call.action === 'send_group_msg').map((call) => call.params.message),
      ).toEqual([
        [{ type: 'text', data: { text: 'hi' } }],
        [{ type: 'text', data: { text: '你的名字？' } }],
        [{ type: 'text', data: { text: '你好，Alice' } }],
      ])
    } finally {
      await app.stop()
      await mock.close()
    }
  })
})
