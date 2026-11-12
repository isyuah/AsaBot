import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginStateEvent } from '../../src/core/plugin/types.ts'
import { createTestApp } from '../../src/testing/index.ts'

const dir = await mkdtemp(join(tmpdir(), 'asabot-hot-'))
const plugin = join(dir, 'hello')
const entry = join(plugin, 'index.ts')
const shared = join(plugin, 'shared.test.ts')
await mkdir(plugin)
for (const name of ['_ignored.ts', '.ignored.js', 'unused.test.ts', 'unused.spec.js', 'types.d.ts']) {
  await writeFile(join(dir, name), `export default { name: 'ignored', setup() {} }`)
}
for (const name of ['_hidden', '.private', 'example.test.dir']) {
  await mkdir(join(dir, name))
  await writeFile(join(dir, name, 'index.ts'), `export default { name: 'ignored', setup() {} }`)
}
await writeFile(
  entry,
  `import { definePlugin } from '@asabot/core'
import { answer } from './shared.test.ts'
export default definePlugin({ name: 'hello', setup(ctx) { ctx.command('hello').action(() => answer) } })\n`,
)
await writeFile(shared, `export const answer = 'first'\n`)
const t = await createTestApp({ pluginDirs: [dir], config: { pluginLoader: { hotReload: true } } })
function nextState(name: string, state: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error(`Timed out waiting for ${name}:${state}`))
    }, 5000)
    const off = t.app.events.on('plugin.state', (event: PluginStateEvent) => {
      if (event.plugin.name !== name || event.plugin.state !== state) return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
}
function assertEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
try {
  assertEqual(t.app.plugins.get('ignored'), undefined)
  await writeFile(join(dir, '_late.ts'), `export default { name: 'ignored', setup() {} }`)
  await writeFile(join(dir, 'late.spec.js'), `export default { name: 'ignored', setup() {} }`)
  assertEqual(await t.app.plugins.rescan(), { added: [], removed: [] })
  assertEqual(await t.say('/hello'), ['first'])
  let active = nextState('hello', 'active')
  await writeFile(shared, `export const answer = 'second'\n`)
  await active
  assertEqual(await t.say('/hello'), ['second'])
  active = nextState('hello', 'active')
  await writeFile(
    entry,
    `import { definePlugin } from '@asabot/core'
import { answer } from './shared.test.ts'
export default definePlugin({ name: 'hello', setup(ctx) { ctx.command('hello').action(() => answer + '!') } })\n`,
  )
  await active
  assertEqual(await t.say('/hello'), ['second!'])
  const failed = new Promise<void>((resolve, reject) => {
    const original = t.app.logger.error.bind(t.app.logger)
    const timer = setTimeout(() => {
      t.app.logger.error = original
      reject(new Error('Timed out waiting for import error'))
    }, 5000)
    t.app.logger.error = (...args: Parameters<typeof original>) => {
      original(...args)
      if (args.some((arg) => typeof arg === 'string' && arg.includes('Plugin import failed'))) {
        clearTimeout(timer)
        t.app.logger.error = original
        resolve()
      }
    }
  })
  await writeFile(entry, 'export default !!! syntax error')
  await failed
  assertEqual(await t.say('/hello'), ['second!'])
  active = nextState('hello', 'active')
  await writeFile(
    entry,
    `import { definePlugin } from '@asabot/core'
export default definePlugin({ name: 'hello', setup(ctx) { ctx.command('hello').action(() => 'fixed') } })\n`,
  )
  await active
  assertEqual(await t.say('/hello'), ['fixed'])
  const setupFailed = nextState('hello', 'failed')
  await writeFile(
    entry,
    `import { definePlugin } from '@asabot/core'
export default definePlugin({ name: 'hello', setup(ctx) { ctx.command('leaked'); throw new Error('new setup failed') } })\n`,
  )
  await setupFailed
  assertEqual(t.app.plugins.get('hello')?.error, 'new setup failed')
  assertEqual(await t.say('/hello'), [])
  assertEqual(await t.say('/leaked'), [])
  active = nextState('hello', 'active')
  await writeFile(
    entry,
    `import { definePlugin } from '@asabot/core'
export default definePlugin({ name: 'hello', setup(ctx) { ctx.command('hello').action(() => 'recovered') } })\n`,
  )
  await active
  assertEqual(await t.say('/hello'), ['recovered'])
  const dynamic = join(plugin, 'dynamic.ts')
  await writeFile(dynamic, `export const answer = 'lazy-one'\n`)
  active = nextState('hello', 'active')
  await writeFile(
    entry,
    `import { definePlugin } from '@asabot/core'
export default definePlugin({ name: 'hello', setup(ctx) { ctx.command('hello').action(async () => (await import('./dynamic.ts')).answer) } })\n`,
  )
  await active
  assertEqual(await t.say('/hello'), ['lazy-one'])
  active = nextState('hello', 'active')
  await writeFile(dynamic, `export const answer = 'lazy-two'\n`)
  await active
  assertEqual(await t.say('/hello'), ['lazy-two'])
  active = nextState('new-plugin', 'active')
  await writeFile(
    join(dir, 'new-plugin.ts'),
    `import { definePlugin } from '@asabot/core'
export default definePlugin({ name: 'new-plugin', setup(ctx) { ctx.command('new').action(() => 'new') } })\n`,
  )
  await active
  assertEqual(await t.say('/new'), ['new'])
  assertEqual(t.app.plugins.get('ignored'), undefined)
  active = nextState('consumer', 'active')
  await writeFile(
    join(dir, 'consumer.ts'),
    `import { definePlugin } from '@asabot/core'
export default definePlugin({ name: 'consumer', depends: ['hello'], setup(ctx) { ctx.command('consumer').action(() => 'ready') } })\n`,
  )
  await active
  assertEqual(await t.say('/consumer'), ['ready'])
  const dependentFailed = nextState('consumer', 'failed')
  await rm(entry)
  await dependentFailed
  // Queue behind the watcher so the removal has finished before examining the list.
  await t.app.plugins.enable('consumer')
  assertEqual(t.app.plugins.get('hello'), undefined)
  assertEqual(t.app.plugins.get('consumer')?.error, '依赖 hello 未激活')
  assertEqual(await t.say('/hello'), [])
  assertEqual(await t.say('/consumer'), [])
  active = nextState('hello', 'active')
  const dependentActive = nextState('consumer', 'active')
  await writeFile(
    entry,
    `import { definePlugin } from '@asabot/core'
export default definePlugin({ name: 'hello', setup(ctx) { ctx.command('hello').action(() => 'returned') } })\n`,
  )
  await Promise.all([active, dependentActive])
  assertEqual(await t.say('/hello'), ['returned'])
  assertEqual(await t.say('/consumer'), ['ready'])
  const result = 'HOT_RELOAD_OK first second second! retained fixed new deleted restored'
  if (process.argv[2]) await writeFile(process.argv[2], result)
  process.stdout.write(`${result}\n`)
} finally {
  await t.dispose()
  await rm(dir, { recursive: true, force: true })
}
