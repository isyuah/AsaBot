import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configSchema } from '../src/core/config/schema.ts'
import { type Context, createApp, definePlugin, type TaskHandle } from '../src/index.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixture(setup: (ctx: Context) => void | Promise<void>, tasks = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'asabot-reliable-'))
  const app = createApp(
    configSchema.parse({ dataDir, tasks, pluginLoader: { dirs: [], hotReload: false } }),
    { logger: pino({ level: 'silent' }) },
  )
  app.plugins.register(definePlugin({ name: 'jobs', setup }))
  cleanup.push(async () => {
    await app.stop()
    await rm(dataDir, { recursive: true, force: true })
  })
  await app.start()
  return app
}

describe('task reliability', () => {
  it('keeps failed attempts and only retries automatically when opted in', async () => {
    let once!: TaskHandle<null>
    let retry!: TaskHandle<null>
    const app = await fixture((ctx) => {
      once = ctx.task('once', () => {
        throw new Error('token=private-value failure')
      })
      retry = ctx.task(
        'retry',
        (_, { attempt }) => {
          if (attempt < 3) throw new Error('try again')
        },
        { retry: { maxRetries: 2, delay: 5, maxDelay: 10 } },
      )
    })
    once.schedule(null, { delay: 0, key: 'a' })
    retry.schedule(null, { delay: 0, key: 'b' })
    await vi.waitFor(() => {
      expect(once.get('a')?.state).toBe('failed')
      expect(retry.get('b')?.state).toBe('succeeded')
    })
    expect(once.get('a')).toMatchObject({
      attempt: 1,
      failures: 1,
      canRetry: true,
      error: 'token=[Redacted] failure',
    })
    expect(retry.attempts('b').map((a) => a.outcome)).toEqual(['succeeded', 'failed', 'failed'])
    expect(app.tasks.query({ state: 'failed' }).total).toBe(1)
    expect(once.retry('a')).toBe(true)
    await vi.waitFor(() => expect(once.get('a')).toMatchObject({ attempt: 2, state: 'failed' }))
  })

  it('waits for a timed-out callback to settle and permits cancellation while timing out', async () => {
    const gate = Promise.withResolvers<void>()
    let task!: TaskHandle<null>
    let signal!: AbortSignal
    await fixture((ctx) => {
      task = ctx.task(
        'slow',
        async (_, context) => {
          signal = context.signal
          await gate.promise
        },
        { timeout: 10, retry: { maxRetries: 1, delay: 0 } },
      )
    })
    cleanup.push(async () => gate.resolve())
    task.schedule(null, { delay: 0, key: 'slow' })
    await vi.waitFor(() => expect(task.get('slow')?.state).toBe('cancelling'))
    expect(signal.aborted).toBe(true)
    await delay(20)
    expect(task.get('slow')?.attempt).toBe(1)
    expect(task.cancel('slow')).toBe(true)
    gate.resolve()
    await vi.waitFor(() => expect(task.get('slow')?.state).toBe('cancelled'))
    expect(task.attempts('slow').map((a) => a.outcome)).toEqual(['cancelled'])
  })

  it('records timeout attempts before retrying', async () => {
    let task!: TaskHandle<null>
    await fixture((ctx) => {
      task = ctx.task(
        'timeout',
        async (_, { attempt, signal }) => {
          if (attempt === 1)
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            )
        },
        { timeout: 10, retry: { maxRetries: 1, delay: 0 } },
      )
    })
    task.schedule(null, { delay: 0, key: 'a' })
    await vi.waitFor(() => expect(task.get('a')?.state).toBe('succeeded'))
    expect(task.attempts('a').map((a) => a.outcome)).toEqual(['succeeded', 'timeout'])
  })

  it('enforces global concurrency and retains pending work during history cleanup', async () => {
    const gate = Promise.withResolvers<void>()
    let task!: TaskHandle<number>
    const entered: number[] = []
    const app = await fixture(
      (ctx) => {
        task = ctx.task('limited', async (payload) => {
          entered.push(payload)
          await gate.promise
        })
      },
      { maxConcurrent: 2, maxHistory: 0 },
    )
    cleanup.push(async () => gate.resolve())
    for (let i = 0; i < 5; i++) task.schedule(i, { delay: 0, key: String(i) })
    await vi.waitFor(() => expect(entered).toHaveLength(2))
    app.tasks.clean(Date.now() + 1e9)
    expect(task.list()).toHaveLength(5)
    gate.resolve()
    await vi.waitFor(() => expect(task.list()).toEqual([]))
    app.tasks.clean()
    expect(app.tasks.query().total).toBe(0)
    expect(app.storage.db.prepare('SELECT count(*) AS n FROM task_attempts').get()?.n).toBe(0)
  })

  it('activates handlers after setup and fences callbacks across reload and purge', async () => {
    const gate = Promise.withResolvers<void>()
    let task!: TaskHandle<null>
    let setups = 0
    let runs = 0
    const app = await fixture(async (ctx) => {
      setups++
      task = ctx.task('reload', async () => {
        runs++
        if (runs === 1) await gate.promise
      })
      if (setups === 1) {
        task.schedule(null, { delay: 0, key: 'a' })
        await delay(10)
        expect(runs).toBe(0)
      }
    })
    cleanup.push(async () => gate.resolve())
    await vi.waitFor(() => expect(runs).toBe(1))
    await app.plugins.reload('jobs')
    expect(task.get('a')).toMatchObject({
      state: 'pending',
      failures: 0,
      blockedReason: '等待同键的上一次执行结束',
    })
    gate.resolve()
    await vi.waitFor(() => expect(task.get('a')?.state).toBe('succeeded'))
    expect(task.attempts('a').map((a) => a.outcome)).toEqual(['succeeded', 'interrupted'])
    await app.plugins.disable('jobs')
    app.storage.purgePlugin('jobs')
    expect(app.tasks.query().total).toBe(0)
  })
})
