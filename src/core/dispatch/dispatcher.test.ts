import { describe, expect, it, vi } from 'vitest'
import { dispatchFixture } from '../../testing/dispatch-fixture.ts'
import { seg } from '../message/index.ts'

const scope = { owner: 'example' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('dispatcher pipeline', () => {
  it('runs observers concurrently and honors middleware that does not call next', async () => {
    const { app, bot, say } = dispatchFixture()
    const gate = deferred<void>()
    const started = deferred<void>()
    const calls: string[] = []
    app.dispatcher.on(scope, 'message', async () => {
      calls.push('observer')
      await gate.promise
    })
    app.dispatcher.middleware(scope, () => {
      calls.push('middleware')
      started.resolve()
    })
    app.dispatcher.command(scope, 'ping').action(() => {
      calls.push('command')
      return 'pong'
    })
    app.dispatcher.match(scope, '', () => {
      calls.push('matcher')
    })
    let finished = false
    const dispatch = say('/ping').then(() => {
      finished = true
    })
    await started.promise
    expect(calls).toEqual(['observer', 'middleware'])
    expect(finished).toBe(false)
    gate.resolve()
    await dispatch
    expect(bot.sends).toEqual([])
  })

  it('consumes prompt answers after middleware while still notifying observers', async () => {
    const { app, bot, say } = dispatchFixture()
    const ready = deferred<void>()
    const seen: string[] = []
    app.dispatcher.on(scope, 'message', (session) => {
      if (session.kind === 'message') seen.push(`on:${session.text}`)
    })
    app.dispatcher.middleware(scope, async (session, next) => {
      seen.push(`mid:${session.text}`)
      await next()
    })
    app.dispatcher.command(scope, 'ask').action(async ({ session }) => {
      const answer = session.prompt('name?')
      ready.resolve()
      const result = await answer
      return result?.text
    })
    app.dispatcher.command(scope, 'echo <text:rest>').action(() => {
      seen.push('echo')
      return 'wrong'
    })
    app.dispatcher.match(scope, '', () => {
      seen.push('match')
    })
    const asking = say('/ask')
    await ready.promise
    await say('/echo answer')
    await asking
    expect(seen).toEqual(['on:/ask', 'mid:/ask', 'on:/echo answer', 'mid:/echo answer'])
    expect(bot.sends.map((send) => send.message)).toEqual([[seg.text('name?')], [seg.text('/echo answer')]])
  })

  it('orders matchers by priority, preserving registration order and blocking by default', async () => {
    const { app, say } = dispatchFixture()
    const calls: string[] = []
    app.dispatcher.match(
      scope,
      'x',
      () => {
        calls.push('low')
      },
      { priority: -1 },
    )
    app.dispatcher.match(
      scope,
      /x/g,
      () => {
        calls.push('first')
      },
      { priority: 5, block: false },
    )
    app.dispatcher.match(
      scope,
      (session) => session.text === 'x',
      () => {
        calls.push('second')
      },
      { priority: 5 },
    )
    await say('x')
    await say('x')
    expect(calls).toEqual(['first', 'second', 'first', 'second'])
  })

  it('isolates handler failures and reports calling next twice', async () => {
    const { app, say } = dispatchFixture()
    const error = vi.spyOn(app.logger, 'error')
    const calls: string[] = []
    app.dispatcher.on({ owner: 'bad' }, 'message', () => {
      throw new Error('boom')
    })
    app.dispatcher.on(scope, 'message', () => {
      calls.push('observer')
    })
    app.dispatcher.middleware(scope, async (_session, next) => {
      await next()
      await next()
    })
    app.dispatcher.match(scope, '', () => {
      calls.push('matcher')
    })
    await say('hello')
    expect(calls).toEqual(['observer', 'matcher'])
    expect(error).toHaveBeenCalledTimes(2)
    expect(
      error.mock.calls.some(([fields]) =>
        String((fields as { err: Error }).err).includes('next() called more than once'),
      ),
    ).toBe(true)
  })

  it('continues to later nonblocking matchers when a handler throws', async () => {
    const { app, bot, say } = dispatchFixture()
    const error = vi.spyOn(app.logger, 'error')
    app.dispatcher.match(
      { owner: 'bad' },
      '',
      () => {
        throw new Error('failure')
      },
      { block: false },
    )
    app.dispatcher.match(scope, '', () => 'still works')
    await say('hello')
    expect(error).toHaveBeenCalledOnce()
    expect(bot.sends[0]?.message).toEqual([seg.text('still works')])
  })

  it('unregisters all owned resources on abort and rejects registrations after abort', async () => {
    const { app, say } = dispatchFixture()
    const controller = new AbortController()
    const owned = { owner: 'unloaded', signal: controller.signal }
    const calls: string[] = []
    app.dispatcher.on(owned, 'message', () => {
      calls.push('on')
    })
    app.dispatcher.middleware(owned, async (_session, next) => {
      calls.push('middleware')
      await next()
    })
    app.dispatcher.command(owned, 'test').action(() => {
      calls.push('command')
    })
    app.dispatcher.match(owned, '', () => {
      calls.push('match')
    })
    await say('/test')
    await say('other')
    expect(calls).toEqual(['on', 'middleware', 'command', 'on', 'middleware', 'match'])
    controller.abort()
    calls.length = 0
    await say('/test')
    await say('other')
    expect(calls).toEqual([])
    expect(() => app.dispatcher.command(owned, 'again')).toThrow()
    expect(() => app.dispatcher.on(owned, 'message', () => {})).toThrow()
    expect(() => app.dispatcher.middleware(owned, () => {})).toThrow()
    expect(() => app.dispatcher.match(owned, '', () => {})).toThrow()
  })

  it('applies access and enabled hooks, while superusers bypass access filtering', async () => {
    const { app, say } = dispatchFixture({ superusers: ['99'] })
    const calls: string[] = []
    const access = vi.fn(() => false)
    const enabled = vi.fn((owner: string) => owner !== 'off')
    app.dispatcher.accessFilter = access
    app.dispatcher.isEnabledFor = enabled
    app.dispatcher.on({ owner: 'off' }, 'message', () => {
      calls.push('off-on')
    })
    app.dispatcher.middleware({ owner: 'off' }, () => {
      calls.push('off-mid')
    })
    app.dispatcher.command({ owner: 'off' }, 'off').action(() => {
      calls.push('off-command')
    })
    app.dispatcher.match({ owner: 'off' }, '', () => {
      calls.push('off-match')
    })
    app.dispatcher.on(scope, 'message', () => {
      calls.push('on')
    })
    app.dispatcher.match(scope, '', () => {
      calls.push('match')
    })
    await say('/off')
    expect(access).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
    await say('/off', { user: '99' })
    expect(access).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['on', 'match'])
    expect(enabled).toHaveBeenCalledWith('off', expect.objectContaining({ userId: '99' }))
  })

  it('aborts a timed-out handler, warns once and leaves the pipeline usable', async () => {
    const { app, say } = dispatchFixture({ dispatch: { handlerTimeout: 20, promptTimeout: 1000 } })
    const warn = vi.spyOn(app.logger, 'warn')
    const error = vi.spyOn(app.logger, 'error')
    let signal: AbortSignal | undefined
    const seen: string[] = []
    app.dispatcher.command(scope, 'wait').action(async (context) => {
      signal = context.signal
      await context.session.prompt()
    })
    app.dispatcher.match(scope, '', () => {
      seen.push('match')
    })
    await say('/wait')
    expect(signal?.aborted).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'example', event: 'message.group' }),
      '处理器超时',
    )
    expect(error).not.toHaveBeenCalled()
    await say('after')
    expect(seen).toEqual(['match'])
  })

  it('does not start an action if its scope aborts during an async permission check', async () => {
    const { app, say } = dispatchFixture()
    const controller = new AbortController()
    const ready = deferred<void>()
    const permission = deferred<boolean>()
    const action = vi.fn()
    app.dispatcher
      .command({ owner: 'plugin', signal: controller.signal }, 'restricted')
      .permission(async () => {
        ready.resolve()
        return permission.promise
      })
      .action(action)
    const handling = say('/restricted')
    await ready.promise
    controller.abort()
    await handling
    permission.resolve(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(action).not.toHaveBeenCalled()
  })

  it('logs an unrelated error if a cancelled handler later fails', async () => {
    const { app, say } = dispatchFixture()
    const controller = new AbortController()
    const ready = deferred<void>()
    let reject!: (error: Error) => void
    const work = new Promise<void>((_resolve, fail) => {
      reject = fail
    })
    const error = vi.spyOn(app.logger, 'error')
    app.dispatcher.command({ owner: 'plugin', signal: controller.signal }, 'wait').action(async () => {
      ready.resolve()
      await work
    })
    const handling = say('/wait')
    await ready.promise
    controller.abort()
    await handling
    reject(new Error('late failure'))
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          plugin: 'plugin',
          err: expect.objectContaining({ message: 'late failure' }),
        }),
        'Command failed',
      ),
    )
  })
})
