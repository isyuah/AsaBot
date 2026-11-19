import { describe, expect, it, vi } from 'vitest'
import { dispatchFixture } from '../../testing/dispatch-fixture.ts'

describe('session.prompt', () => {
  it('gives a message to the user-scoped prompt before a channel-scoped one', async () => {
    const { session, say } = dispatchFixture()
    const channel = session('start', { user: '2' }).prompt(undefined, { scope: 'channel', timeout: '1s' })
    const user = session('start', { user: '1' }).prompt(undefined, { timeout: '1s' })
    await say('mine', { user: '1' })
    await expect(user).resolves.toMatchObject({ text: 'mine' })
    await say('anyone', { user: '3' })
    await expect(channel).resolves.toMatchObject({ text: 'anyone' })
  })

  it('uses the default timeout, caps requested timeouts, and cleans up after expiration', async () => {
    vi.useFakeTimers()
    try {
      const { app, session, say } = dispatchFixture({ dispatch: { promptTimeout: 20, maxPromptTimeout: 30 } })
      const first = session('start').prompt()
      await vi.advanceTimersByTimeAsync(20)
      await expect(first).resolves.toBeNull()
      const second = session('start').prompt(undefined, { timeout: '1m' })
      await vi.advanceTimersByTimeAsync(30)
      await expect(second).resolves.toBeNull()
      const matched = vi.fn()
      app.dispatcher.match({ owner: 'test' }, '', matched)
      await say('later')
      expect(matched).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors timeouts longer than Node’s maximum individual timer delay', async () => {
    vi.useFakeTimers()
    try {
      const { session } = dispatchFixture({ dispatch: { maxPromptTimeout: '30d' } })
      const waiting = session('start').prompt(undefined, { timeout: '30d' })
      let finished = false
      void waiting.then(() => {
        finished = true
      })
      await vi.advanceTimersByTimeAsync(2_147_483_647)
      expect(finished).toBe(false)
      await vi.advanceTimersByTimeAsync(2_592_000_000 - 2_147_483_647)
      await expect(waiting).resolves.toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('filters answers, replaces the same scope, and allows any channel member when requested', async () => {
    const { session, say } = dispatchFixture()
    const original = session('start', { user: '1' })
    const old = original.prompt()
    const current = original.prompt(undefined, { filter: (answer) => answer.text === 'yes' })
    await expect(old).resolves.toBeNull()
    await say('no', { user: '1' })
    await say('yes', { user: '2' })
    await say('yes', { user: '1' })
    expect((await current)?.text).toBe('yes')
    const channel = original.prompt(undefined, { scope: 'channel' })
    await say('anyone', { user: '2', group: '11' })
    await say('anyone', { user: '2', group: '10' })
    expect((await channel)?.userId).toBe('2')
  })

  it('rejects with the scope abort reason without logging an error', async () => {
    const { app, say } = dispatchFixture()
    const controller = new AbortController()
    const reason = new DOMException('unloaded', 'AbortError')
    const error = vi.spyOn(app.logger, 'error')
    let rejectReason: unknown
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    app.dispatcher
      .command({ owner: 'plugin', signal: controller.signal }, 'wait')
      .action(async ({ session }) => {
        const prompt = session.prompt()
        started()
        try {
          await prompt
        } catch (caught) {
          rejectReason = caught
          throw caught
        }
      })
    const handling = say('/wait')
    await ready
    controller.abort(reason)
    await handling
    expect(rejectReason).toBe(reason)
    expect(error).not.toHaveBeenCalled()
    const matched = vi.fn()
    app.dispatcher.match({ owner: 'other' }, '', matched)
    await say('answer')
    expect(matched).toHaveBeenCalledOnce()
  })

  it('ends pending prompts when the app stops', async () => {
    const { app, session } = dispatchFixture()
    await app.start()
    const prompt = session('start').prompt()
    const rejection = expect(prompt).rejects.toMatchObject({ name: 'AbortError' })
    await app.stop()
    await rejection
  })

  it('cleans up a waiter when sending the question fails', async () => {
    const { app, bot, session, say } = dispatchFixture()
    vi.spyOn(bot, 'sendGroup').mockRejectedValueOnce(new Error('send failed'))
    await expect(session('start').prompt('question')).rejects.toMatchObject({
      code: 'DELIVERY_UNCONFIRMED',
      outcome: 'unknown',
    })
    const matched = vi.fn()
    app.dispatcher.match({ owner: 'test' }, '', matched)
    await say('answer')
    expect(matched).toHaveBeenCalledOnce()
  })

  it('stops a command awaiting a prompt without an error log', async () => {
    const { app, say } = dispatchFixture()
    const error = vi.spyOn(app.logger, 'error')
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    app.dispatcher.command({ owner: 'plugin' }, 'wait').action(async ({ session }) => {
      const answer = session.prompt()
      started()
      await answer
    })
    await app.start()
    const handling = say('/wait')
    await ready
    await app.stop()
    await handling
    expect(error).not.toHaveBeenCalled()
  })
})
