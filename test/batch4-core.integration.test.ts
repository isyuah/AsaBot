import { afterEach, describe, expect, it } from 'vitest'
import {
  type Context,
  definePlugin,
  formatTarget,
  type Message,
  NoBotOnlineError,
  parseTarget,
  plainText,
  seg,
  supports,
  type Target,
  targetSchema,
  UnsupportedError,
} from '../src/index.ts'
import { createTestApp, type TestApp, VirtualAdapter } from '../src/testing/index.ts'

let app: TestApp | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
})

describe('batch 4 core', () => {
  it('lowers plugin output and nested hook sends for a text-only bot', async () => {
    let sentEvent: Message = []
    app = await createTestApp({
      capabilities: { segments: ['text'], textStyles: [] },
      plugins: [
        definePlugin({
          name: 'rich',
          setup(ctx) {
            ctx.beforeSend(async ({ bot, message }) => {
              if (plainText(message) === 'outer') await bot.sendGroup('10', seg.image('nested'))
            })
            ctx
              .command('rich')
              .action(() => [
                seg.image('image-id'),
                seg.markdown('**hello**'),
                seg.button('run', { command: '/go' }),
              ])
          },
        }),
      ],
    })
    app.app.events.on('bot.message.sent', (event) => {
      sentEvent = event.message
    })
    expect(supports(app.mock.bot, 'image')).toBe(false)
    expect(supports(app.mock.bot, 'sendGroup')).toBe(true)
    expect(await app.say('/rich')).toEqual(['[图片]hellorun：发送 /go'])
    expect(sentEvent).toEqual([seg.text('[图片]hellorun：发送 /go')])
    await app.mock.bot.sendGroup('10', 'outer')
    expect(app.mock.bot.sends.slice(-2).map((send) => plainText(send.message))).toEqual(['[图片]', 'outer'])
  })

  it('rejects actions omitted from virtual bot capabilities', async () => {
    app = await createTestApp({ capabilities: { actions: ['sendGroup'] } })
    expect(supports(app.mock.bot, 'sendPrivate')).toBe(false)
    await expect(app.mock.bot.sendPrivate('20', 'hello')).rejects.toBeInstanceOf(UnsupportedError)
    await expect(app.mock.bot.sendGroup('10', 'hello')).resolves.toEqual({ messageId: '1' })
  })

  it('returns hook sent results without sending the original or remaining forward nodes', async () => {
    app = await createTestApp({
      plugins: [
        definePlugin({
          name: 'replacement',
          setup(ctx) {
            ctx.beforeSend(({ bot }) => ({ deliver: () => bot.sendPrivate('20', 'replacement') }))
            ctx.beforeSend(
              () => {
                throw new Error('must not run')
              },
              { priority: -1 },
            )
          },
        }),
      ],
    })
    const first = await app.mock.bot.sendGroup('10', 'original')
    const second = await app.mock.bot.sendForward({ type: 'group', id: '10' }, [
      { userId: '20', nickname: 'test', message: 'node' },
    ])
    expect(first).toEqual({ messageId: '1' })
    expect(second).toEqual({ messageId: '2' })
    expect(app.mock.bot.sends.map(({ type, message }) => [type, plainText(message)])).toEqual([
      ['private', 'replacement'],
      ['private', 'replacement'],
    ])
  })

  it('round trips targets and isolates broadcast failures', async () => {
    const targets: Target[] = [
      { platform: 'virtual', type: 'group', id: 'room:part' },
      { platform: 'virtual', selfId: '10000', type: 'private', id: 'user:part:2' },
    ]
    for (const target of targets) {
      expect(parseTarget(formatTarget(target))).toEqual(target)
      expect(targetSchema.parse(formatTarget(target))).toEqual(target)
    }
    let context!: Context
    app = await createTestApp({
      plugins: [
        definePlugin({
          name: 'sender',
          setup(ctx) {
            context = ctx
          },
        }),
      ],
    })
    const backup = new VirtualAdapter(app.app, { selfId: 'other' })
    await backup.start()
    app.mock.bot.status = 'offline'
    await expect(context.send('virtual:10000:group:10', 'x')).rejects.toBeInstanceOf(NoBotOnlineError)
    app.mock.bot.status = 'online'
    await backup.stop()
    const results = await context.broadcast(
      ['virtual:group:1', 'virtual:offline:group:2', 'virtual:private:3'],
      'hi',
    )
    expect(results.map((item) => item.error?.name ?? item.result?.messageId)).toEqual([
      '1',
      'NoBotOnlineError',
      '2',
    ])
    expect(app.mock.bot.sends.map((send) => send.target)).toEqual(['1', '3'])
    let sessionTarget: Target | undefined
    app.app.events.on('message', (session) => {
      sessionTarget = session.target
    })
    await app.say('hello')
    expect(sessionTarget).toEqual({ platform: 'virtual', selfId: '10000', type: 'group', id: '10' })
  })

  it('intercepts in priority order, changes calls and results, mocks, skips recursion, and disposes', async () => {
    const order: string[] = []
    app = await createTestApp({
      plugins: [
        definePlugin({
          name: 'interceptor',
          setup(ctx) {
            ctx.interceptApi(
              async (call, next) => {
                order.push(`high:${call.method}`)
                if (call.method === 'sendGroup') {
                  await call.bot.sendPrivate('inside', 'nested')
                  call.args[0] = 'changed'
                  const result = (await next()) as { messageId: string }
                  return { messageId: `modified-${result.messageId}` }
                }
                if (call.method === 'getGroupList') return [{ groupId: 'mock', groupName: 'mock' }]
                return next()
              },
              { priority: 10 },
            )
            ctx.interceptApi(async (call, next) => {
              order.push(`low:${call.method}`)
              return next()
            })
          },
        }),
      ],
    })
    expect(await app.mock.bot.sendGroup('10', 'hello')).toEqual({ messageId: 'modified-2' })
    expect(app.mock.bot.sends.map((send) => send.target)).toEqual(['inside', 'changed'])
    expect(await app.mock.bot.getGroupList()).toEqual([{ groupId: 'mock', groupName: 'mock' }])
    expect(order).toEqual(['high:sendGroup', 'low:sendGroup', 'high:getGroupList'])
    await app.app.plugins.disable('interceptor')
    expect(await app.mock.bot.sendGroup('10', 'after')).toEqual({ messageId: '3' })
    expect(order).toHaveLength(3)
  })
})
