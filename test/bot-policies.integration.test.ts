import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { VirtualAdapter } from '../src/adapters/virtual/index.ts'
import {
  type App,
  type Context,
  compatibility,
  createApp,
  createSession,
  definePlugin,
  loadConfig,
  plainText,
  seg,
  z,
} from '../src/index.ts'
import { createTestApp, FakeBot } from '../src/testing/index.ts'

async function panel(app: App) {
  const base = `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'panel-secret' }),
  })
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('Panel login failed')
  return (path: string, value?: unknown) =>
    fetch(`${base}${path}`, {
      method: value === undefined ? 'GET' : 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    })
}

async function runCommand(app: App, bot: FakeBot, command: string) {
  const offset = bot.sends.length
  const id = randomUUID()
  await app.events.emit(
    createSession(
      {
        id,
        messageId: id,
        time: Date.now(),
        platform: bot.platform,
        selfId: bot.selfId,
        bot,
        userId: '20',
        sender: { userId: '20', nickname: 'Tester' },
        isSuperuser: false,
        isBotAdmin: false,
        messageType: 'private',
        message: [seg.text(command)],
        raw: null,
      },
      app.sessionServices,
    ),
  )
  return bot.sends.slice(offset).map(({ message }) => plainText(message))
}

describe('bot policies', () => {
  it('captures defaults on first registration, persists them, and respects global and bot switches', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'asabot-bot-defaults-'))
    const configPath = join(dataDir, 'asabot.yaml')
    const pluginDir = join(dataDir, 'plugins')
    const automaticPath = join(pluginDir, 'automatic.js')
    const writeAutomatic = (enabled: boolean) =>
      writeFile(
        automaticPath,
        `export default {
          name: 'automatic',
          defaultOnNewBots: ${enabled},
          setup(ctx) { ctx.command('automatic').action(() => 'automatic') },
        }`,
      )
    const boot = async () => {
      const app = createApp(await loadConfig(configPath), { configPath, logger: pino({ level: 'silent' }) })
      app.plugins.register(
        definePlugin({
          name: 'manual',
          setup(ctx) {
            ctx.command('manual').action(() => 'manual')
          },
        }),
      )
      await app.start()
      return app
    }
    let app: App | undefined
    try {
      await mkdir(pluginDir)
      await writeFile(
        configPath,
        JSON.stringify({
          dataDir,
          pluginLoader: { dirs: [pluginDir], hotReload: false },
          server: { port: 0, panelPassword: 'panel-secret' },
        }),
      )
      app = await boot()
      const request = await panel(app)
      await writeAutomatic(true)
      await app.plugins.rescan()
      expect(await (await request('/plugins')).json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'automatic', defaultOnNewBots: true }),
          expect.objectContaining({ name: 'manual', defaultOnNewBots: false }),
        ]),
      )
      await writeAutomatic(false)
      await app.plugins.reload('automatic')
      const first = new FakeBot('first')
      app.registerBot(first)
      expect(await runCommand(app, first, '/automatic')).toEqual(['automatic'])
      expect(await runCommand(app, first, '/manual')).toEqual([])

      const manualDefault = '/plugins/manual/bot-default'
      expect((await request(manualDefault, { defaultOnNewBots: null })).status).toBe(400)
      expect(await (await request(manualDefault, { defaultOnNewBots: true })).json()).toMatchObject({
        defaultOnNewBots: true,
      })
      expect((await request('/plugins/automatic/bot-default', { defaultOnNewBots: false })).status).toBe(200)
      await app.plugins.disable('manual')
      const second = new FakeBot('second')
      app.registerBot(second)
      expect(await runCommand(app, second, '/automatic')).toEqual([])
      expect(await runCommand(app, second, '/manual')).toEqual([])
      expect(await (await request('/bots/fake/second')).json()).toMatchObject({
        plugins: expect.arrayContaining([
          expect.objectContaining({ name: 'manual', botDefaultEnabled: true, botEnabled: false }),
        ]),
      })
      await app.plugins.enable('manual')
      expect(await runCommand(app, first, '/manual')).toEqual([])
      expect(await runCommand(app, second, '/manual')).toEqual(['manual'])
      await app.plugins.disable('manual')
      expect(await runCommand(app, second, '/manual')).toEqual([])
      await app.plugins.enable('manual')
      expect(await runCommand(app, second, '/manual')).toEqual(['manual'])

      const firstPolicy = '/bots/fake/first/plugins/manual'
      expect((await request(firstPolicy, { enabled: true })).status).toBe(200)
      expect(await runCommand(app, first, '/manual')).toEqual(['manual'])
      expect((await request(firstPolicy, { enabled: null })).status).toBe(200)
      expect(await runCommand(app, first, '/manual')).toEqual([])

      await app.stop()
      await writeAutomatic(true)
      app = await boot()
      const reconnected = new FakeBot('first')
      app.registerBot(reconnected)
      expect(await runCommand(app, reconnected, '/automatic')).toEqual(['automatic'])
      expect(await runCommand(app, reconnected, '/manual')).toEqual([])
      const afterRestart = new FakeBot('third')
      app.registerBot(afterRestart)
      expect(await runCommand(app, afterRestart, '/manual')).toEqual(['manual'])
      expect(await runCommand(app, afterRestart, '/automatic')).toEqual([])

      const nextRequest = await panel(app)
      expect((await nextRequest(manualDefault, { defaultOnNewBots: false })).status).toBe(200)
      expect((await loadConfig(configPath)).plugins.manual?.defaultOnNewBots).toBe(false)
      const afterChange = new FakeBot('fourth')
      app.registerBot(afterChange)
      expect(await runCommand(app, afterChange, '/manual')).toEqual([])
      expect(await runCommand(app, afterRestart, '/manual')).toEqual(['manual'])
    } finally {
      await app?.stop()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('exposes isolated policies, capability hints and inherited configuration through the panel', async () => {
    const t = await createTestApp({
      config: { server: { port: 0, panelPassword: 'panel-secret' } },
      plugins: [
        definePlugin({
          name: 'panel-scope',
          config: z.object({ count: z.number().positive().default(1) }),
          capabilities: {
            required: { actions: ['missingAction'] },
            optional: { segments: ['example:card'] },
          },
          setup() {},
        }),
      ],
    })
    const second = new VirtualAdapter(t.app, { selfId: 'second' })
    await second.start()
    try {
      const request = await panel(t.app)
      const policyPath = '/bots/virtual/10000/plugins/panel-scope'
      expect((await request('/bots/virtual/10000/admins', { admins: ['20'] })).status).toBe(200)
      t.app.policies.load()
      expect(t.app.isBotAdmin({ platform: 'virtual', selfId: '10000', userId: '20' })).toBe(true)
      expect(t.app.isBotAdmin({ platform: 'virtual', selfId: 'second', userId: '20' })).toBe(false)
      expect((await request(policyPath, { enabled: false, config: { count: 0 } })).status).toBe(400)
      expect(t.app.plugins.isEnabledOnBot('panel-scope', t.mock.bot)).toBe(true)
      const updated = await request(policyPath, { enabled: false, config: { count: 2 } })
      expect(updated.status).toBe(200)
      expect(await updated.json()).toMatchObject({
        state: 'active',
        botEnabled: false,
        effectiveConfig: { count: 2 },
        configSources: { count: 'bot' },
        compatibility: {
          required: [{ kind: 'actions', name: 'missingAction' }],
          optional: [{ kind: 'segments', name: 'example:card' }],
        },
      })
      const applications = await (await request('/plugins/panel-scope/bots')).json()
      expect(applications).toContainEqual(
        expect.objectContaining({
          bot: expect.objectContaining({ selfId: 'second' }),
          application: expect.objectContaining({ botEnabled: true, effectiveConfig: { count: 1 } }),
        }),
      )
      const groupKey = encodeURIComponent('virtual:10000:group:10')
      expect(
        (await request(`/plugins/panel-scope/groups/${groupKey}`, { config: { count: 3 } })).status,
      ).toBe(200)
      const group = await (await request(`/groups/${groupKey}`)).json()
      expect(group.plugins).toContainEqual(
        expect.objectContaining({
          name: 'panel-scope',
          inheritedConfig: { count: 2 },
          effectiveConfig: { count: 3 },
          configSources: { count: 'group' },
        }),
      )
      expect(await (await request(policyPath, { enabled: null, config: null })).json()).toMatchObject({
        botEnabled: true,
        effectiveConfig: { count: 1 },
        configSources: { count: 'default' },
      })
    } finally {
      await second.stop()
      await t.dispose()
    }
  })

  it('isolates administrators, group rules and plugin callbacks for bots on the same platform', async () => {
    const plugin = definePlugin({
      name: 'scoped',
      capabilities: { required: { actions: ['missingAction'] } },
      setup(ctx) {
        ctx.command('scoped').action(() => 'ok')
      },
    })
    const t = await createTestApp({ plugins: [plugin] })
    const other = new VirtualAdapter(t.app, { selfId: 'second' })
    await other.start()
    try {
      const first = t.mock.bot
      const second = other.bot
      t.app.policies.setAdmins(first, ['20'])
      expect(t.app.isBotAdmin({ ...first, userId: '20' })).toBe(true)
      expect(t.app.isBotAdmin({ ...second, userId: '20' })).toBe(false)
      expect(t.app.isSuperuser({ ...first, userId: '20' })).toBe(false)
      expect(await t.say('/plugin disable scoped')).toEqual(['权限不足'])
      expect(await t.say('/bot plugin off scoped')).toEqual(['已在本机器人关闭插件 scoped'])
      expect(await t.say('/scoped')).not.toContain('ok')
      expect(await other.receive('/scoped', { user: '20', group: '10' })).toMatchObject([
        { message: [{ data: { text: 'ok' } }] },
      ])
      t.app.plugins.setBotEnabled('scoped', first, null)
      t.app.plugins.setGroupEnabled('scoped', 'virtual:10000:group:10', false)
      expect(await t.say('/scoped')).not.toContain('ok')
      expect(await other.receive('/scoped', { user: '20', group: '10' })).toHaveLength(1)
      expect(compatibility(plugin.capabilities, first.capabilities).required).toEqual([
        { kind: 'actions', name: 'missingAction' },
      ])
    } finally {
      await other.stop()
      await t.dispose()
    }
  })

  it('blocks plugin background sends to disabled bots and restores inherited configuration', async () => {
    let context: Context<unknown> | undefined
    const plugin = definePlugin({
      name: 'scoped',
      setup(ctx) {
        context = ctx
      },
    })
    const t = await createTestApp({ plugins: [plugin] })
    const other = new VirtualAdapter(t.app, { selfId: 'second' })
    await other.start()
    try {
      if (!context) throw new Error('Plugin did not load')
      t.app.plugins.setBotEnabled('scoped', t.mock.bot, false)
      await expect(context.send('virtual:10000:private:20', 'blocked')).rejects.toThrow('disabled')
      await expect(context.send('virtual:second:private:20', 'allowed')).resolves.toHaveProperty('messageId')
      expect(t.mock.bot.sends).toHaveLength(0)
      expect(other.bot.sends).toHaveLength(1)
    } finally {
      await other.stop()
      await t.dispose()
    }
  })

  it('merges raw global/bot/group objects, replaces arrays and rejects invalid parent saves atomically', async () => {
    const plugin = definePlugin({
      name: 'config-scope',
      config: z
        .object({
          mode: z.enum(['normal', 'large']).default('normal'),
          nested: z.object({ x: z.number().default(1), y: z.number().default(2) }),
          count: z.number().default(1),
          names: z.array(z.string()).default(['default']),
        })
        .refine((value) => value.mode !== 'large' || value.count >= 5, 'count too small'),
      setup() {},
    })
    const t = await createTestApp({
      plugins: [plugin],
      config: { plugins: { 'config-scope': { config: { nested: { x: 3, y: 4 }, names: ['a', 'b'] } } } },
    })
    try {
      const manager = t.app.plugins
      const bot = t.mock.bot
      manager.setBotConfig(plugin.name, bot, { nested: { x: 8 }, names: ['c'] })
      manager.setGroupConfig(plugin.name, 'virtual:10000:group:10', { count: 2, nested: { y: 9 } })
      expect(manager.configFor(plugin.name, { ...bot, groupId: '10' })).toEqual({
        mode: 'normal',
        nested: { x: 8, y: 9 },
        count: 2,
        names: ['c'],
      })
      await expect(
        manager.updateConfig(plugin.name, { mode: 'large', nested: {}, count: 5 }),
      ).rejects.toThrow('count too small')
      expect(manager.getConfig(plugin.name)).toMatchObject({ mode: 'normal' })
      expect(() => manager.setBotConfig(plugin.name, bot, { mode: 'large', count: 5 })).toThrow(
        'count too small',
      )
      manager.setGroupConfig(plugin.name, 'virtual:10000:group:10', null)
      manager.setBotConfig(plugin.name, bot, null)
      expect(manager.configFor(plugin.name, bot)).toMatchObject({ nested: { x: 3, y: 4 }, names: ['a', 'b'] })
    } finally {
      await t.dispose()
    }
  })
})
