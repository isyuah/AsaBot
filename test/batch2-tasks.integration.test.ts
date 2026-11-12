import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { configSchema } from '../src/core/config/schema.ts'
import { createApp, definePlugin, type TaskHandle } from '../src/index.ts'

describe('persistent tasks', () => {
  it('restores future and missed tasks across restarts and cancels pending work', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'asabot-tasks-'))
    const config = configSchema.parse({ dataDir, pluginLoader: { dirs: [], hotReload: false } })
    const received: string[] = []
    let task!: TaskHandle<string>
    const plugin = definePlugin({
      name: 'reminders',
      setup(ctx) {
        task = ctx.task('remind', (payload) => {
          received.push(payload)
        })
      },
    })
    const makeApp = () => {
      const app = createApp(config, { logger: pino({ level: 'silent' }) })
      app.plugins.register(plugin)
      return app
    }
    const first = makeApp()
    let second: ReturnType<typeof makeApp> | undefined
    try {
      await first.start()
      task.schedule('missed', { delay: 80, key: 'missed' })
      task.schedule('future', { delay: 600, key: 'future' })
      task.schedule('cancelled', { delay: 80, key: 'cancelled' })
      expect(task.cancel('cancelled')).toBe(true)
      expect(task.cancel('cancelled')).toBe(false)
      expect(task.list().map((item) => item.key)).toEqual(['missed', 'future'])
      await first.stop()
      await delay(150)
      second = makeApp()
      await second.start()
      await vi.waitFor(() => expect(received).toEqual(['missed']))
      await vi.waitFor(() => expect(received).toEqual(['missed', 'future']), { timeout: 2_000 })
      expect(task.list()).toEqual([])
    } finally {
      await first.stop()
      await second?.stop()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps a replacement scheduled during execution and never runs the key concurrently', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'asabot-task-replace-'))
    const config = configSchema.parse({ dataDir, pluginLoader: { dirs: [], hotReload: false } })
    const gate = Promise.withResolvers<void>()
    const calls: string[] = []
    let task!: TaskHandle<string>
    const app = createApp(config, { logger: pino({ level: 'silent' }) })
    app.plugins.register(
      definePlugin({
        name: 'replace',
        setup(ctx) {
          task = ctx.task('job', async (payload) => {
            calls.push(payload)
            if (payload === 'first') await gate.promise
          })
        },
      }),
    )
    try {
      await app.start()
      task.schedule('first', { delay: 0, key: 'same' })
      await vi.waitFor(() => expect(calls).toEqual(['first']))
      task.schedule('second', { delay: 0, key: 'same' })
      await delay(25)
      expect(calls).toEqual(['first'])
      gate.resolve()
      await vi.waitFor(() => expect(calls).toEqual(['first', 'second']))
      await vi.waitFor(() => expect(task.list()).toEqual([]))
    } finally {
      gate.resolve()
      await app.stop()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('retains an interrupted task and runs it again after a restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'asabot-task-interrupted-'))
    const config = configSchema.parse({ dataDir, pluginLoader: { dirs: [], hotReload: false } })
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<AbortSignal>()
    let task!: TaskHandle<string>
    const received: string[] = []
    let runs = 0
    const plugin = definePlugin({
      name: 'interrupted',
      setup(ctx) {
        task = ctx.task('job', async (payload, { signal }) => {
          runs++
          if (runs === 1) {
            entered.resolve(signal)
            await gate.promise
          } else received.push(payload)
        })
      },
    })
    const makeApp = () => {
      const app = createApp(config, { logger: pino({ level: 'silent' }) })
      app.plugins.register(plugin)
      return app
    }
    const first = makeApp()
    let second: ReturnType<typeof makeApp> | undefined
    try {
      await first.start()
      task.schedule('resume', { delay: 0, key: 'one' })
      const signal = await entered.promise
      await first.stop()
      expect(signal.aborted).toBe(true)
      second = makeApp()
      await second.start()
      await vi.waitFor(() => expect(received).toEqual(['resume']))
      await vi.waitFor(() => expect(task.list()).toEqual([]))
      gate.resolve()
    } finally {
      gate.resolve()
      await first.stop()
      await second?.stop()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
