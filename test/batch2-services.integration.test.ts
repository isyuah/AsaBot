import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { definePlugin } from '../src/index.ts'
import { createTestApp, type TestApp } from '../src/testing/index.ts'

declare module '@asabot/core' {
  interface Services {
    coins: { balance: number }
  }
}

let app: TestApp | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
})

describe('plugin services', () => {
  it('waits for a provider and cascades on disable, enable and reload', async () => {
    let loads = 0
    let cleanups = 0
    const consumer = definePlugin({
      name: 'shop',
      inject: ['coins'],
      setup(ctx) {
        const coins = ctx.inject('coins')
        expectTypeOf(coins).toEqualTypeOf<{ balance: number }>()
        expectTypeOf<ReturnType<typeof ctx.inject<'other'>>>().toEqualTypeOf<unknown>()
        loads++
        ctx.command('balance').action(() => String(coins.balance))
        ctx.onDispose(() => {
          cleanups++
        })
      },
    })
    const provider = definePlugin({
      name: 'wallet',
      setup(ctx) {
        ctx.provide('coins', { balance: 7 })
      },
    })
    app = await createTestApp({
      plugins: [consumer, provider],
      config: { plugins: { wallet: { enabled: false } } },
    })
    expect(app.app.plugins.get('shop')).toMatchObject({
      state: 'failed',
      error: '服务 coins 不可用',
      inject: [{ name: 'coins', optional: false }],
      provides: [],
    })
    await app.app.plugins.enable('wallet')
    expect(await app.say('/balance')).toEqual(['7'])
    expect(app.app.plugins.get('wallet')).toMatchObject({ state: 'active', provides: ['coins'], inject: [] })
    await app.app.plugins.disable('wallet')
    expect(app.app.plugins.get('shop')).toMatchObject({ state: 'failed', error: '服务 coins 不可用' })
    expect(cleanups).toBe(1)
    await app.app.plugins.enable('wallet')
    expect(await app.say('/balance')).toEqual(['7'])
    await app.app.plugins.reload('wallet')
    expect(await app.say('/balance')).toEqual(['7'])
    expect(loads).toBe(3)
    expect(cleanups).toBe(2)
  })

  it('fails conflicting providers and rejects undeclared service access', async () => {
    app = await createTestApp({
      plugins: [
        definePlugin({
          name: 'first',
          setup(ctx) {
            ctx.provide('coins', { balance: 1 })
          },
        }),
        definePlugin({
          name: 'second',
          setup(ctx) {
            ctx.provide('coins', { balance: 2 })
          },
        }),
        definePlugin({
          name: 'undeclared',
          setup(ctx) {
            ctx.inject('coins')
          },
        }),
        definePlugin({
          name: 'undeclared-optional',
          setup(ctx) {
            ctx.injectOptional('coins')
          },
        }),
      ],
    })
    expect(app.app.plugins.get('second')).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/coins.*first.*second/),
    })
    expect(app.app.plugins.get('undeclared')).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/未声明.*coins/),
    })
    expect(app.app.plugins.get('undeclared-optional')).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/未声明可选服务.*coins/),
    })
  })

  it('reconciles services registered or withdrawn after setup', async () => {
    let provide!: () => void
    let withdraw!: () => void
    app = await createTestApp({
      plugins: [
        definePlugin({
          name: 'late-shop',
          inject: ['coins'],
          setup(ctx) {
            ctx.inject('coins')
          },
        }),
        definePlugin({
          name: 'late-wallet',
          setup(ctx) {
            provide = () => {
              withdraw = ctx.provide('coins', { balance: 1 })
            }
          },
        }),
      ],
    })
    expect(app.app.plugins.get('late-shop')?.state).toBe('failed')
    provide()
    await vi.waitFor(() => expect(app?.app.plugins.get('late-shop')?.state).toBe('active'))
    withdraw()
    await vi.waitFor(() => expect(app?.app.plugins.get('late-shop')?.state).toBe('failed'))
  })

  it('reloads optional consumers when the service appears, reloads and disappears', async () => {
    const seen: (number | undefined)[] = []
    app = await createTestApp({
      plugins: [
        definePlugin({
          name: 'optional-shop',
          inject: { optional: ['coins'] },
          setup(ctx) {
            const coins = ctx.injectOptional('coins')
            expectTypeOf(coins).toEqualTypeOf<{ balance: number } | undefined>()
            seen.push(coins?.balance)
          },
        }),
        definePlugin({
          name: 'optional-wallet',
          setup(ctx) {
            ctx.provide('coins', { balance: 9 })
          },
        }),
      ],
      config: { plugins: { 'optional-wallet': { enabled: false } } },
    })
    expect(seen).toEqual([undefined])
    expect(app.app.plugins.get('optional-shop')).toMatchObject({
      state: 'active',
      inject: [{ name: 'coins', optional: true }],
    })
    await app.app.plugins.enable('optional-wallet')
    expect(seen).toEqual([undefined, 9])
    await app.app.plugins.reload('optional-wallet')
    expect(seen).toEqual([undefined, 9, 9])
    await app.app.plugins.disable('optional-wallet')
    expect(seen).toEqual([undefined, 9, 9, undefined])
  })
})
