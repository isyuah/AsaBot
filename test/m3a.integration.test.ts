import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createApp } from '../src/bootstrap.ts'
import { loadConfig } from '../src/core/config/load.ts'
import { writeConfigValue } from '../src/core/config/write.ts'
import type { Context } from '../src/core/plugin/context.ts'
import { definePlugin } from '../src/core/plugin/definition.ts'
import { Storage } from '../src/core/storage/index.ts'
import { createTestApp, type TestApp } from '../src/testing/index.ts'

const apps: TestApp[] = []
const directories: string[] = []
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asabot-m3a-'))
  directories.push(dir)
  return dir
}
async function testApp(options: Parameters<typeof createTestApp>[0]): Promise<TestApp> {
  const app = await createTestApp(options)
  apps.push(app)
  return app
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('plugins through the virtual adapter', () => {
  it('runs multiple prompt rounds without sleeping, including middleware', async () => {
    const plugin = definePlugin({
      name: 'dialog',
      setup(ctx) {
        ctx.middleware(async (_session, next) => {
          await next()
        })
        ctx.command('ask').action(async ({ session }) => {
          const name = await session.prompt('name?')
          if (!name) return
          const color = await name.prompt('color?')
          if (color) return `${name.text}:${color.text}`
        })
      },
    })
    const t = await testApp({ plugins: [plugin] })
    expect(await t.say('/ask')).toEqual(['name?'])
    expect(await t.say('Alice')).toEqual(['color?'])
    expect(await t.say('blue')).toEqual(['Alice:blue'])
    expect(await t.say('nobody')).toEqual([])
  })

  it('waits for unrelated active observers while a handler is blocked in prompt', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const plugin = definePlugin({
      name: 'waiting',
      setup(ctx) {
        ctx.on('message.group', async () => {
          await gate
        })
        ctx.command('wait').action(async ({ session }) => {
          await session.prompt('ready')
        })
      },
    })
    const t = await testApp({ plugins: [plugin] })
    let finished = false
    const pending = t.say('/wait').then((result) => {
      finished = true
      return result
    })
    await vi.waitFor(() => expect(t.mock.bot.sends).toHaveLength(1))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(finished).toBe(false)
    release()
    expect(await pending).toEqual(['ready'])
  })

  it('keeps a handler active when it creates a prompt before awaiting other work', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const plugin = definePlugin({
      name: 'delayed-prompt',
      setup(ctx) {
        ctx.command('wait').action(async ({ session }) => {
          const answer = session.prompt('ready')
          await gate
          await answer
        })
      },
    })
    const t = await testApp({ plugins: [plugin] })
    let finished = false
    const pending = t.say('/wait').then((result) => {
      finished = true
      return result
    })
    await vi.waitFor(() => expect(t.mock.bot.sends).toHaveLength(1))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(finished).toBe(false)
    release()
    expect(await pending).toEqual(['ready'])
  })

  it('isolates failed setup, invalid configuration and command conflicts; disposes all resources', async () => {
    const cleanup: string[] = []
    let saved!: Context<undefined>
    let ticks = 0
    let observations = 0
    let middlewares = 0
    const good = definePlugin({
      name: 'good',
      setup(ctx) {
        ctx.command('good').action(() => 'ok')
      },
    })
    const disposable = definePlugin({
      name: 'disposable',
      setup(ctx) {
        saved = ctx
        ctx.onDispose(() => {
          cleanup.push('first')
        })
        ctx.onDispose(() => {
          cleanup.push('second')
          throw new Error('cleanup')
        })
        ctx.command('gone').action(() => 'gone')
        ctx.on('message.group', () => {
          observations++
        })
        ctx.middleware(async (_session, next) => {
          middlewares++
          await next()
        })
        ctx.interval(10, () => {
          ticks++
        })
      },
    })
    const bad = definePlugin({
      name: 'bad',
      setup(ctx) {
        ctx.command('leaked').action(() => 'leaked')
        ctx.on('message.group', () => {
          observations += 100
        })
        throw new Error('setup broke')
      },
    })
    const conflict = definePlugin({
      name: 'conflict',
      setup(ctx) {
        ctx.command('temporary')
        ctx.command('good')
      },
    })
    const invalid = definePlugin({ name: 'invalid', config: z.object({ required: z.string() }), setup() {} })
    const t = await testApp({ plugins: [good, disposable, bad, conflict, invalid] })
    expect(t.app.plugins.get('good')?.state).toBe('active')
    expect(t.app.plugins.get('bad')).toMatchObject({ state: 'failed', error: 'setup broke' })
    expect(t.app.plugins.get('conflict')?.error).toContain('good')
    expect(t.app.plugins.get('invalid')?.error).toContain('plugins.invalid.config.required')
    expect(await t.say('/good')).toEqual(['ok'])
    expect(await t.say('/leaked')).toEqual([])
    expect(await t.say('/temporary')).toEqual([])
    expect(await t.say('/gone')).toEqual(['gone'])
    await t.app.plugins.disable('disposable')
    const oldTicks = ticks
    const oldObservations = observations
    const oldMiddlewares = middlewares
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(ticks).toBe(oldTicks)
    expect(await t.say('/gone')).toEqual([])
    expect(observations).toBe(oldObservations)
    expect(middlewares).toBe(oldMiddlewares)
    expect(cleanup).toEqual(['second', 'first'])
    expect(() => saved.command('late')).toThrow('disposed')
    expect(() => saved.store.get('x')).toThrow('disposed')
    expect(await t.say('/good')).toEqual(['ok'])
  })

  it('reconciles dependencies in order, handles cycles and restores dependents', async () => {
    const calls: string[] = []
    const base = definePlugin({
      name: 'base',
      setup(ctx) {
        calls.push('base+')
        ctx.onDispose(() => {
          calls.push('base-')
        })
      },
    })
    const child = definePlugin({
      name: 'child',
      depends: ['base'],
      setup(ctx) {
        calls.push('child+')
        ctx.onDispose(() => {
          calls.push('child-')
        })
      },
    })
    const missing = definePlugin({ name: 'missing', depends: ['absent'], setup() {} })
    const cycleA = definePlugin({ name: 'cycle-a', depends: ['cycle-b'], setup() {} })
    const cycleB = definePlugin({ name: 'cycle-b', depends: ['cycle-a'], setup() {} })
    const t = await testApp({ plugins: [child, base, missing, cycleA, cycleB] })
    expect(calls).toEqual(['base+', 'child+'])
    expect(t.app.plugins.get('missing')?.error).toContain('absent')
    expect(t.app.plugins.get('cycle-a')?.error).toContain('cycle')
    await t.app.plugins.disable('base')
    expect(calls.slice(-2)).toEqual(['child-', 'base-'])
    expect(t.app.plugins.get('child')).toMatchObject({ state: 'failed', error: '依赖 base 未激活' })
    await t.app.plugins.enable('base')
    expect(calls.slice(-2)).toEqual(['base+', 'child+'])
    expect(t.app.plugins.get('child')?.state).toBe('active')
  })

  it('validates config before writing and reloads with the parsed output', async () => {
    const plugin = definePlugin({
      name: 'configurable',
      config: z.object({ amount: z.coerce.number().default(3) }),
      setup(ctx) {
        const amount: number = ctx.config.amount
        ctx.command('amount').action(() => String(amount))
      },
    })
    const t = await testApp({ plugins: [plugin] })
    expect(await t.say('/amount')).toEqual(['3'])
    expect(t.app.plugins.get('configurable')?.configSchema).toMatchObject({ type: 'object' })
    await expect(t.app.plugins.updateConfig('configurable', { amount: 'bad' })).rejects.toThrow(
      'config.amount',
    )
    expect(await t.say('/amount')).toEqual(['3'])
    await t.app.plugins.updateConfig('configurable', { amount: '7' })
    expect(await t.say('/amount')).toEqual(['7'])
  })

  it('applies group switches and independent allow/block dimensions while superusers bypass access rules', async () => {
    let observed = 0
    let middlewareRuns = 0
    const plugin = definePlugin({
      name: 'guarded',
      setup(ctx) {
        ctx.on('message.group', () => {
          observed++
        })
        ctx.middleware(async (_session, next) => {
          middlewareRuns++
          await next()
        })
        ctx.command('guarded').action(() => 'allowed')
        ctx.match('match-trigger', () => 'matched')
      },
    })
    const t = await testApp({ plugins: [plugin] })
    t.app.plugins.setGroupEnabled('guarded', 'virtual:10', false)
    expect(await t.say('/guarded')).toEqual([])
    expect(observed).toBe(0)
    expect(middlewareRuns).toBe(0)
    expect(await t.say('match-trigger')).toEqual([])
    expect(await t.say('/guarded', { group: '11' })).toEqual(['allowed'])
    expect(await t.say('match-trigger', { group: '11' })).toEqual(['matched'])
    t.app.plugins.setGroupEnabled('guarded', 'virtual:10', true)
    const access = t.app.storage.access
    access.add('allow', 'user', 'virtual:20')
    access.add('allow', 'group', 'virtual:10')
    expect(await t.say('/guarded', { user: '21' })).toEqual([])
    expect(await t.say('/guarded', { group: '11' })).toEqual([])
    expect(await t.say('/guarded', { group: null })).toEqual(['allowed'])
    expect(await t.say('/guarded')).toEqual(['allowed'])
    access.add('block', 'group', 'virtual:10')
    expect(await t.say('/guarded')).toEqual([])
    expect(await t.say('/guarded', { user: '99', superuser: true })).toEqual(['allowed'])
    access.remove('block', 'group', 'virtual:10')
    expect(access.list('allow', 'group')).toEqual([{ list: 'allow', subject: 'group', key: 'virtual:10' }])
  })

  it('isolates timer errors, skips overlap and stops on unload', async () => {
    let runs = 0
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const plugin = definePlugin({
      name: 'timer',
      setup(ctx) {
        ctx.interval(10, async () => {
          runs++
          await blocked
          throw new Error('timer error')
        })
      },
    })
    const t = await testApp({ plugins: [plugin] })
    await new Promise((resolve) => setTimeout(resolve, 55))
    expect(runs).toBe(1)
    release()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(runs).toBeGreaterThan(1)
    await t.app.plugins.disable('timer')
    const stopped = runs
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(runs).toBe(stopped)
  })

  it('reports invalid cron registrations as plugin failures without affecting other plugins', async () => {
    const bad = definePlugin({
      name: 'bad-cron',
      setup(ctx) {
        ctx.cron('not cron', () => {})
      },
    })
    const good = definePlugin({
      name: 'other',
      setup(ctx) {
        ctx.command('still').action(() => 'yes')
      },
    })
    const t = await testApp({ plugins: [bad, good] })
    expect(t.app.plugins.get('bad-cron')?.error).toContain('Invalid cron expression')
    expect(await t.say('/still')).toEqual(['yes'])
  })

  it('marks a plugin failed and rolls back all of its migrations on error', async () => {
    const broken = definePlugin({
      name: 'broken-migration',
      setup(ctx) {
        ctx.migrate(['CREATE TABLE p_broken_migration_test (value TEXT)', 'invalid SQL'])
      },
    })
    const t = await testApp({ plugins: [broken] })
    expect(t.app.plugins.get('broken-migration')?.state).toBe('failed')
    expect(
      t.app.storage.db.prepare("SELECT name FROM sqlite_master WHERE name = 'p_broken_migration_test'").get(),
    ).toBeUndefined()
  })
})

describe('storage and YAML', () => {
  it('rolls back migrations, runs them once and persists KV, access and group state', async () => {
    const dir = await directory()
    const storage = new Storage(dir)
    storage.open()
    try {
      expect(() =>
        storage.migrate('example', ['CREATE TABLE p_example_x (value TEXT)', 'invalid SQL']),
      ).toThrow()
      expect(
        storage.db.prepare("SELECT name FROM sqlite_master WHERE name = 'p_example_x'").get(),
      ).toBeUndefined()
      const steps = ['CREATE TABLE p_example_x (value TEXT)', "INSERT INTO p_example_x VALUES ('ok')"]
      storage.migrate('example', steps)
      storage.migrate('example', steps)
      expect(storage.db.prepare('SELECT count(*) AS count FROM p_example_x').get()?.count).toBe(1)
      storage.store('example').set('value', { answer: 42 })
      storage.store('example').set('expired', 1, { ttl: 0 })
      expect(storage.store('example').get('expired')).toBeUndefined()
      storage.access.add('allow', 'user', 'virtual:1')
      storage.setGroupEnabled('example', 'virtual:2', false)
    } finally {
      storage.close()
    }
    const reopened = new Storage(dir)
    reopened.open()
    try {
      expect(reopened.store('example').get('value')).toEqual({ answer: 42 })
      expect(reopened.store('example').keys()).toEqual(['value'])
      expect(reopened.access.list()).toHaveLength(1)
      expect(reopened.isGroupEnabled('example', 'virtual:2')).toBe(false)
    } finally {
      reopened.close()
    }
  })

  it('preserves comments and interpolation and leaves the original intact on failure', async () => {
    const dir = await directory()
    const path = join(dir, 'config.yaml')
    const placeholder = '$' + '{TOKEN:-original}'
    await writeFile(
      path,
      `# keep comment\ntoken: ${placeholder}\nplugins:\n  hello:\n    enabled: true # keep switch\n`,
    )
    await writeConfigValue(path, ['plugins', 'hello', 'enabled'], false)
    const source = await readFile(path, 'utf8')
    expect(source).toContain('# keep comment')
    expect(source).toContain(placeholder)
    expect(source).toContain('# keep switch')
    await expect(writeConfigValue(path, ['token', 'invalid'], true)).rejects.toThrow(path)
    expect(await readFile(path, 'utf8')).toBe(source)
  })

  it('persists manager changes and keeps memory unchanged when writing fails', async () => {
    const dir = await directory()
    const configPath = join(dir, 'config.yaml')
    const dataDir = join(dir, 'data')
    const placeholder = '$' + '{TOKEN:-hello}'
    await writeFile(
      configPath,
      `# retained\ndataDir: ${JSON.stringify(dataDir)}\npluginLoader:\n  dirs: []\n  hotReload: false\nplugins:\n  configurable:\n    enabled: true # retained\n    config:\n      message: "${placeholder}" # message comment\n      count: 1 # count comment\n`,
    )
    const config = await loadConfig(configPath)
    const app = createApp(config, { configPath, logger: pino({ level: 'silent' }) })
    app.plugins.register(
      definePlugin({
        name: 'configurable',
        config: z.object({ message: z.string(), count: z.number() }),
        setup() {},
      }),
    )
    try {
      await app.start()
      await app.plugins.disable('configurable')
      let source = await readFile(configPath, 'utf8')
      expect(source).toContain(placeholder)
      expect(source).toContain('# retained')
      expect(source).toContain('enabled: false')
      const message = z.object({ message: z.string() }).parse(config.plugins.configurable?.config).message
      await app.plugins.updateConfig('configurable', { message, count: 2 })
      source = await readFile(configPath, 'utf8')
      expect(source).toContain(placeholder)
      expect(source).toContain('message comment')
      expect(source).toContain('count: 2 # count comment')
      const before = app.plugins.get('configurable')
      await rm(configPath)
      await expect(app.plugins.enable('configurable')).rejects.toThrow(configPath)
      expect(app.plugins.get('configurable')).toEqual(before)
      expect(config.plugins.configurable?.enabled).toBe(false)
    } finally {
      await app.stop()
    }
  })
})
