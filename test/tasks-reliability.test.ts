import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configSchema } from '../src/core/config/schema.ts'
import { Storage } from '../src/core/storage/index.ts'
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
  it('keeps a persisted outcome when its plugin unloads before execution cleanup', async () => {
    let context!: Context
    let task!: TaskHandle<null>
    const app = await fixture((ctx) => {
      context = ctx
      task = ctx.task('completed', () => {})
    })
    const disposed = Promise.withResolvers<void>()
    const prepare = app.storage.db.prepare.bind(app.storage.db)
    let queued = false
    const spy = vi.spyOn(app.storage.db, 'prepare').mockImplementation((sql) => {
      if (!queued && sql.startsWith('UPDATE task_attempts SET outcome = ?')) {
        queued = true
        queueMicrotask(() => {
          void context.dispose().then(disposed.resolve, disposed.reject)
        })
      }
      return prepare(sql)
    })
    try {
      task.schedule(null, { delay: 0, key: 'one' })
      await disposed.promise
      const record = app.tasks.query().items[0]
      expect(record).toMatchObject({ state: 'succeeded', attempt: 1 })
      expect(app.tasks.attempts(record?.id ?? '').map((a) => a.outcome)).toEqual(['succeeded'])
    } finally {
      spy.mockRestore()
    }
  })
  it('retries persisting results without rerunning callbacks or releasing concurrency', async () => {
    let task!: TaskHandle<number>
    const calls: number[] = []
    const app = await fixture(
      (ctx) => {
        task = ctx.task('durable-result', (value) => {
          calls.push(value)
        })
      },
      { maxConcurrent: 1 },
    )
    const db = app.storage.db
    const original = db.prepare.bind(db)
    let fail = true
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (fail && sql.startsWith('UPDATE task_attempts SET outcome = ?')) {
        fail = false
        throw new Error('database is busy')
      }
      return original(sql)
    })
    try {
      task.schedule(1, { delay: 0, key: 'first' })
      task.schedule(2, { delay: 0, key: 'second' })
      await vi.waitFor(() => expect(calls).toEqual([1]))
      expect(task.get('first')?.state).toBe('running')
      await vi.waitFor(() => expect(task.get('second')?.state).toBe('succeeded'), { timeout: 2500 })
      expect(calls).toEqual([1, 2])
      expect(task.get('first')).toMatchObject({ state: 'succeeded', attempt: 1 })
    } finally {
      spy.mockRestore()
    }
  })

  it('activates tasks registered after setup and blocks work from a failed setup', async () => {
    let context!: Context
    let fail = true
    let runs = 0
    const app = await fixture((ctx) => {
      context = ctx
      ctx
        .task('setup', () => {
          runs++
        })
        .schedule(null, { delay: 0, key: 'a' })
      if (fail) throw new Error('setup failed')
    })
    await delay(20)
    expect(runs).toBe(0)
    expect(app.tasks.query().items[0]).toMatchObject({ state: 'pending', blockedReason: '任务处理器未激活' })
    fail = false
    await app.plugins.reload('jobs')
    await vi.waitFor(() => expect(runs).toBe(1))
    const dynamic = context.task('dynamic', () => {
      runs++
    })
    dynamic.schedule(null, { delay: 0, key: 'b' })
    await vi.waitFor(() => expect(runs).toBe(2))
  })

  it('migrates legacy schedules and recovers interrupted attempts without consuming retries', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'asabot-task-migrate-'))
    const storage = new Storage(dataDir)
    storage.open()
    storage.close()
    const db = new DatabaseSync(join(dataDir, 'asabot.db'))
    db.exec(
      "DROP TABLE bot_admins; DROP TABLE plugin_bot_policy; DROP TABLE bot_plugin_defaults; DELETE FROM plugin_tables WHERE table_name IN ('bot_admins', 'plugin_bot_policy', 'bot_plugin_defaults'); DROP TABLE task_attempts; DROP TABLE tasks; DELETE FROM plugin_tables WHERE table_name IN ('tasks', 'task_attempts'); CREATE TABLE scheduled_tasks (plugin TEXT, name TEXT, key TEXT, run_at INTEGER, payload TEXT, PRIMARY KEY (plugin,name,key)); INSERT INTO plugin_tables VALUES ('core', 'scheduled_tasks'); UPDATE migrations SET version = 4 WHERE plugin = 'core';",
    )
    db.prepare('INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?, ?)').run(
      'jobs',
      'legacy',
      'one',
      Date.now() + 60_000,
      'null',
    )
    db.close()
    let task!: TaskHandle<null>
    const app = createApp(configSchema.parse({ dataDir, pluginLoader: { dirs: [], hotReload: false } }), {
      logger: pino({ level: 'silent' }),
    })
    app.plugins.register(
      definePlugin({
        name: 'jobs',
        setup(ctx) {
          task = ctx.task('legacy', () => {})
        },
      }),
    )
    cleanup.push(async () => {
      await app.stop()
      await rm(dataDir, { recursive: true, force: true })
    })
    await app.start()
    expect(task.get('one')).toMatchObject({ state: 'pending', attempt: 0, policy: { maxRetries: 0 } })
    expect(
      app.storage.db.prepare("SELECT name FROM sqlite_master WHERE name = 'scheduled_tasks'").get(),
    ).toBeUndefined()
    await app.stop()
    const crashed = new DatabaseSync(join(dataDir, 'asabot.db'))
    const id = String(crashed.prepare('SELECT id FROM tasks').get()?.id)
    crashed.prepare("UPDATE tasks SET state = 'running', attempt = 1 WHERE id = ?").run(id)
    crashed
      .prepare(
        "INSERT INTO task_attempts (id,task_id,plugin,attempt,started_at,outcome) VALUES ('interrupted',?,'jobs',1,?,'running')",
      )
      .run(id, Date.now())
    crashed.close()
    const resumed = createApp(configSchema.parse({ dataDir, pluginLoader: { dirs: [], hotReload: false } }), {
      logger: pino({ level: 'silent' }),
    })
    resumed.plugins.register(
      definePlugin({
        name: 'jobs',
        setup(ctx) {
          task = ctx.task('legacy', () => {})
        },
      }),
    )
    cleanup.push(async () => {
      await resumed.stop()
    })
    await resumed.start()
    await vi.waitFor(() => expect(task.get('one')?.state).toBe('succeeded'))
    expect(task.get('one')).toMatchObject({ attempt: 2, failures: 0 })
    expect(task.attempts('one').map((a) => a.outcome)).toEqual(['succeeded', 'interrupted'])
  })
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
