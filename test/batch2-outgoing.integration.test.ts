import { afterEach, describe, expect, it, vi } from 'vitest'
import { definePlugin, plainText, SendBlockedError, seg } from '../src/index.ts'
import { createTestApp, type TestApp } from '../src/testing/index.ts'

let app: TestApp | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
})

describe('outgoing messages', () => {
  it('continues after a hook exceeds three seconds', async () => {
    app = await createTestApp({
      plugins: [
        definePlugin({
          name: 'slow',
          setup(ctx) {
            ctx.beforeSend(() => new Promise(() => {}))
          },
        }),
      ],
    })
    const warn = vi.spyOn(app.app.logger, 'warn')
    vi.useFakeTimers()
    try {
      const sending = app.mock.bot.sendPrivate('20', 'hello')
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(sending).resolves.toMatchObject({ messageId: expect.any(String) })
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ plugin: 'slow' }),
        'Before-send hook timed out',
      )
      expect(plainText(app.mock.bot.sends[0]?.message ?? [])).toBe('hello')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rewrites in priority order, skips failing hooks, and prevents recursive sends', async () => {
    app = await createTestApp({
      plugins: [
        definePlugin({
          name: 'filters',
          setup(ctx) {
            ctx.beforeSend(
              async ({ bot, target, message }) => {
                const text = plainText(message)
                if (text === 'outer') {
                  await bot.sendGroup(target.id, 'nested')
                  return [seg.text('rewritten')]
                }
              },
              { priority: 10 },
            )
            ctx.beforeSend(
              ({ message }) => {
                message.splice(0, message.length, seg.text('discarded'))
                throw new Error('bad hook')
              },
              { priority: 5 },
            )
            ctx.beforeSend(({ message }) => [seg.text(`${plainText(message)}!`)])
          },
        }),
      ],
    })
    const error = vi.spyOn(app.app.logger, 'error')
    const sent: string[] = []
    app.app.events.on('bot.message.sent', (event) => {
      sent.push(plainText(event.message))
    })
    await app.mock.bot.sendGroup('10', 'outer')
    expect(app.mock.bot.sends.map((item) => plainText(item.message))).toEqual(['nested', 'rewritten!'])
    expect(sent).toEqual(['nested', 'rewritten!'])
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'filters' }),
      'Before-send hook failed',
    )
  })

  it('rejects blocked sends and logs a blocked handler at info level', async () => {
    app = await createTestApp({
      plugins: [
        definePlugin({
          name: 'blocker',
          setup(ctx) {
            ctx.beforeSend(({ message }) => (plainText(message) === 'blocked' ? false : undefined))
            ctx.command('blocked').action(() => 'blocked')
          },
        }),
      ],
    })
    const info = vi.spyOn(app.app.logger, 'info')
    const error = vi.spyOn(app.app.logger, 'error')
    await expect(app.mock.bot.sendPrivate('20', 'blocked')).rejects.toMatchObject({
      name: 'SendBlockedError',
      plugin: 'blocker',
    })
    await expect(
      app.mock.bot.sendForward({ type: 'group', id: '10' }, [
        { userId: '1', nickname: 'Alice', message: 'ok' },
        { userId: '2', nickname: 'Bob', message: 'blocked' },
      ]),
    ).rejects.toBeInstanceOf(SendBlockedError)
    expect(await app.say('/blocked')).toEqual([])
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin: 'blocker',
        deliveryFailure: expect.objectContaining({ code: 'DELIVERY_BLOCKED', outcome: 'not_sent' }),
      }),
      expect.any(String),
    )
    expect(error).not.toHaveBeenCalled()
    expect(app.mock.bot.sends).toEqual([])
  })

  it('records received and sent messages and exposes virtual group operations', async () => {
    app = await createTestApp()
    let incoming = ''
    app.app.events.on('message', (session) => {
      incoming = session.messageId
    })
    await app.say('hello')
    expect(await app.mock.bot.getMessage(incoming)).toMatchObject({
      userId: '20',
      message: [seg.text('hello')],
    })
    const sent = await app.mock.bot.sendPrivate('20', 'hi')
    expect(await app.mock.bot.getMessage(sent.messageId)).toMatchObject({
      userId: app.mock.bot.selfId,
      message: [seg.text('hi')],
    })
    await expect(app.mock.bot.getMessage('missing')).rejects.toThrow()
    await app.mock.bot.muteMember('10', '20', 1_500)
    await app.mock.bot.kickMember('10', '20', { rejectRequest: true })
    await app.mock.bot.setMemberCard('10', '20', 'name')
    expect(app.mock.bot.actions).toEqual([
      { action: 'muteMember', params: { groupId: '10', userId: '20', duration: 1_500 } },
      { action: 'kickMember', params: { groupId: '10', userId: '20', options: { rejectRequest: true } } },
      { action: 'setMemberCard', params: { groupId: '10', userId: '20', card: 'name' } },
    ])
  })

  it('sends and reads a forward in the current session', async () => {
    app = await createTestApp({
      plugins: [
        definePlugin({
          name: 'forwarder',
          setup(ctx) {
            ctx.command('forward').action(async ({ session }) => {
              await session.sendForward([{ userId: '20', nickname: 'Alice', message: 'hello' }])
            })
          },
        }),
      ],
    })
    const replies = await app.say('/forward')
    expect(replies).toEqual([[seg.forward('1')]])
    expect(await app.mock.bot.getForward('1')).toEqual([
      { userId: '20', nickname: 'Alice', message: [seg.text('hello')] },
    ])
  })
})
