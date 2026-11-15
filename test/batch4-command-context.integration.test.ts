import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/bootstrap.ts'
import { loadConfig } from '../src/core/config/load.ts'
import { definePlugin, groupKeyOf, z } from '../src/index.ts'
import { createTestApp } from '../src/testing/create-test-app.ts'
import { dispatchFixture } from '../src/testing/dispatch-fixture.ts'

const password = 'batch4-panel-password'

async function panel(app: { server?: { address(): { port: number } | null } }) {
  const url = `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
  const response = await fetch(`${url}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('Missing cookie')
  return (path: string, method = 'GET', value?: unknown) =>
    fetch(`${url}${path}`, {
      method,
      headers: { cookie, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(value) }),
    })
}

describe('filtered contexts and group configuration', () => {
  it('filters all stages, help and suggestions, and disposes registrations with the plugin', async () => {
    const seen: string[] = []
    const plugin = definePlugin({
      name: 'filtered',
      setup(ctx) {
        const selected = ctx
          .platform('virtual')
          .filter((event) => groupKeyOf(event) === 'virtual:10000:group:10')
        selected.on('message', () => {
          seen.push('observer')
        })
        selected.middleware(async (_session, next) => {
          seen.push('middleware')
          await next()
        })
        selected
          .command('filtered [name]')
          .arg('name', { description: '名称' })
          .action(() => 'filtered result')
        selected.match('match-test', () => {
          seen.push('matcher')
        })
      },
    })
    const t = await createTestApp({ plugins: [plugin], config: { command: { suggest: 'always' } } })
    try {
      expect(await t.say('/filtered', { group: '10' })).toEqual(['filtered result'])
      expect((await t.say('/help filtered', { group: '10' }))[0]).toContain('/filtered')
      expect((await t.say('/help filtered', { group: '10' }))[0]).toContain('名称')
      const beforeOtherGroup = seen.length
      expect(await t.say('/filtered', { group: '11' })).toEqual([])
      expect((await t.say('/help filtered', { group: '11' }))[0]).toContain('未找到可用命令')
      expect(await t.say('/filtere', { group: '11' })).toEqual([])
      expect(seen).toHaveLength(beforeOtherGroup)
      const prior = [...seen]
      const foreignFixture = dispatchFixture()
      const foreign = { ...foreignFixture.session('/filtered'), platform: 'other' }
      await t.app.dispatcher.dispatch(foreign)
      expect(seen).toEqual(prior)
      expect(foreignFixture.bot.sends).toEqual([])
      expect(
        (await t.app.dispatcher.listCommands(foreign)).some((command) => command.owner === 'filtered'),
      ).toBe(false)
      await t.say('match-test', { group: '10' })
      expect(seen).toContain('matcher')
      const count = seen.length
      await t.app.plugins.disable('filtered')
      await t.say('match-test', { group: '10' })
      expect(seen).toHaveLength(count)
      expect(t.app.dispatcher.registeredCommands('filtered')).toEqual([])
    } finally {
      await t.dispose()
    }
  })

  it('merges nested raw configuration and rejects parent writes that invalidate a group', async () => {
    const plugin = definePlugin({
      name: 'groups',
      config: z
        .object({
          mode: z.enum(['a', 'b']),
          count: z.number().int(),
          nested: z.object({ x: z.number(), y: z.number().default(9) }),
        })
        .refine((value) => value.mode !== 'b' || value.count >= 4, {
          path: ['count'],
          message: 'count too small',
        }),
      setup(ctx) {
        ctx.command('config').action(({ session }) => JSON.stringify(ctx.configFor(session)))
      },
    })
    const t = await createTestApp({
      plugins: [plugin],
      config: {
        server: { port: 0, panelPassword: password },
        plugins: { groups: { config: { mode: 'a', count: 1, nested: { x: 1, y: 2 } } } },
      },
    })
    try {
      const request = await panel(t.app)
      const endpoint = '/plugins/groups/groups/virtual%3A10000%3Agroup%3A10'
      const invalid = await request(endpoint, 'PUT', { enabled: false, config: { count: 'wrong' } })
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toMatchObject({
        error: { issues: [{ path: 'plugins.groups.config.count' }] },
      })
      expect(await (await request('/plugins/groups/groups')).json()).toEqual([])
      expect((await request(endpoint, 'PUT', { config: { count: 2, nested: { x: 8 } } })).status).toBe(200)
      expect(await (await request('/plugins/groups/groups')).json()).toEqual([
        { groupKey: 'virtual:10000:group:10', config: { count: 2, nested: { x: 8 } } },
      ])
      expect((await request(endpoint, 'PUT', { enabled: true })).status).toBe(200)
      expect(await (await request('/plugins/groups/groups')).json()).toEqual([
        { groupKey: 'virtual:10000:group:10', enabled: true, config: { count: 2, nested: { x: 8 } } },
      ])
      expect(
        (await request('/plugins/status/groups/virtual%3A10000%3Agroup%3A10', 'PUT', { config: {} })).status,
      ).toBe(400)
      expect(await t.say('/config', { group: '10' })).toEqual([
        '{"mode":"a","count":2,"nested":{"x":8,"y":2}}',
      ])
      expect(await t.say('/config', { group: null })).toEqual([
        '{"mode":"a","count":1,"nested":{"x":1,"y":2}}',
      ])
      await expect(
        t.app.plugins.updateConfig('groups', { mode: 'b', count: 5, nested: { x: 3 } }),
      ).rejects.toThrow('count too small')
      expect(await t.say('/config', { group: '10' })).toEqual([
        '{"mode":"a","count":2,"nested":{"x":8,"y":2}}',
      ])
      expect((await request(endpoint, 'PUT', { config: null })).status).toBe(200)
      expect(await (await request('/plugins/groups/groups')).json()).toEqual([
        { groupKey: 'virtual:10000:group:10', enabled: true },
      ])
    } finally {
      await t.dispose()
    }
  })
})

describe('command overrides', () => {
  it('applies permissions, aliases, conflicts and group switches without changing declarations', async () => {
    const plugin = definePlugin({
      name: 'override-test',
      setup(ctx) {
        ctx
          .command('locked')
          .permission('superuser')
          .action(() => 'locked')
        ctx.command('public').action(() => 'public')
        ctx.command('other').action(() => 'other')
        ctx.match('/locked', () => 'matcher')
      },
    })
    const t = await createTestApp({
      plugins: [plugin],
      config: { server: { port: 0, panelPassword: password } },
    })
    try {
      const request = await panel(t.app)
      const set = (path: string, override: unknown) =>
        request('/commands/override', 'PUT', { path, override })
      await set('locked', { enabled: false })
      expect(await t.say('/locked')).toEqual(['matcher'])
      await set('locked', { permission: 'everyone', aliases: ['shortcut', 'other'] })
      expect(await t.say('/locked')).toEqual(['locked'])
      expect(await t.say('/shortcut')).toEqual(['locked'])
      expect(await t.say('/other')).toEqual(['other'])
      const view = (await (await request('/commands')).json()).find(
        (entry: { path: string }) => entry.path === 'locked',
      )
      expect(view).toMatchObject({
        aliases: [],
        permission: true,
        hidden: false,
        override: { permission: 'everyone', aliases: ['shortcut', 'other'] },
        disabledGroups: [],
        overrideIssues: [expect.stringContaining('other')],
      })
      expect(t.app.plugins.get('override-test')?.state).toBe('active')
      await set('public', { permission: 'superuser' })
      expect(await t.say('/public')).toEqual(['权限不足'])
      expect(await t.say('/public', { superuser: true })).toEqual(['public'])
      await set('public', { cooldown: { duration: '30s' } })
      expect(await t.say('/public')).toEqual(['public'])
      expect((await t.say('/public'))[0]).toContain('冷却中')
      await set('public', { cooldown: false, hidden: true })
      expect(await t.say('/public')).toEqual(['public'])
      expect((await t.say('/help public'))[0]).toContain('未找到可用命令')
      await request('/commands/groups', 'PUT', {
        path: 'locked',
        groupKey: 'virtual:10000:group:10',
        enabled: false,
      })
      expect(await t.say('/locked', { group: '10' })).toEqual(['matcher'])
      expect(await t.say('/locked', { group: '11' })).toEqual(['locked'])
      const settings = await (await request('/settings')).json()
      expect(settings.command).not.toHaveProperty('overrides')
      expect(settings.command.suggest).toBe('direct')
      await request('/settings', 'PUT', { command: { suggest: 'off' } })
      expect((await (await request('/settings')).json()).command.suggest).toBe('off')
      expect(t.app.config.command.overrides.locked?.permission).toBe('everyone')
    } finally {
      await t.dispose()
    }
  })

  it('writes YAML overrides and preserves comments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asabot-override-'))
    const path = join(dir, 'config.yaml')
    await writeFile(
      path,
      `# keep root comment\ndataDir: ${JSON.stringify(dir)}\npluginLoader: { dirs: [], hotReload: false }\nserver: { port: 0, panelPassword: ${JSON.stringify(password)} }\ncommand:\n  prefixes: ['/'] # keep prefix comment\n  overrides:\n    'yaml command': { enabled: true } # keep override comment\n`,
    )
    const app = createApp(await loadConfig(path), { configPath: path, logger: pino({ level: 'silent' }) })
    app.plugins.register(
      definePlugin({
        name: 'yaml-test',
        setup(ctx) {
          ctx.command('yaml command').action(() => 'ok')
        },
      }),
    )
    try {
      await app.start()
      const request = await panel(app)
      const response = await request('/commands/override', 'PUT', {
        path: 'yaml command',
        override: { permission: 'superuser', cooldown: { duration: '30s', scope: 'group' } },
      })
      expect(response.status).toBe(200)
      const source = await readFile(path, 'utf8')
      expect(source).toContain('# keep root comment')
      expect(source).toContain('# keep prefix comment')
      expect(source).toContain('# keep override comment')
      expect(source).toContain('yaml command')
      expect((await loadConfig(path)).command.overrides['yaml command']).toMatchObject({
        permission: 'superuser',
        cooldown: { duration: 30000, scope: 'group' },
      })
      expect(
        (await request('/commands/override', 'PUT', { path: 'yaml command', override: null })).status,
      ).toBe(200)
      expect((await loadConfig(path)).command.overrides['yaml command']).toBeUndefined()
    } finally {
      await app.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
