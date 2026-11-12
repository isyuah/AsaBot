import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { MockOneBot } from '../src/adapters/onebot11/mock-onebot.ts'
import { createApp } from '../src/bootstrap.ts'
import { loadConfig } from '../src/core/config/load.ts'
import { configSchema } from '../src/core/config/schema.ts'
import { createLogger, getRecentLogs } from '../src/core/logger.ts'
import { definePlugin } from '../src/index.ts'
import { createTestApp } from '../src/testing/create-test-app.ts'

const secret = () => randomBytes(18).toString('base64url')

async function login(url: string, password: string): Promise<string> {
  const response = await fetch(`${url}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('Missing session cookie')
  return cookie
}

function request(url: string, cookie: string, method = 'GET', data?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { cookie, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
}

interface SettingsView {
  superusers: string[]
  timezone: string
  restartRequired: string[]
  adapters: Record<
    string,
    {
      value: { connections: { type: string; url: string; accessToken: string }[] }
      schema: Record<string, unknown>
    }
  >
}

describe('batch 3 panel settings', () => {
  it('preserves references, hidden values, validation paths and YAML comments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asabot-settings-'))
    const path = join(dir, 'config.yaml')
    const password = secret()
    const literal = secret()
    const envSecret = secret()
    const previous = process.env.ASABOT_BATCH3_REFERENCE
    process.env.ASABOT_BATCH3_REFERENCE = envSecret
    await writeFile(
      path,
      [
        '# retained root comment',
        `dataDir: ${JSON.stringify(dir)}`,
        'pluginLoader: { dirs: [], hotReload: false }',
        `server: { port: 0, panelPassword: ${JSON.stringify(password)} }`,
        'timezone: UTC # retained timezone comment',
        'adapters:',
        '  onebot11:',
        '    connections:',
        '      - type: forward',
        '        url: ws://127.0.0.1:1 # retained connection comment',
        `        accessToken: \${ASABOT_BATCH3_REFERENCE}`,
        '      - type: forward',
        '        url: ws://127.0.0.1:2',
        `        accessToken: ${JSON.stringify(literal)}`,
        '',
      ].join('\n'),
    )
    const app = createApp(await loadConfig(path), { configPath: path, logger: pino({ level: 'silent' }) })
    try {
      await app.start()
      const url = `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
      const cookie = await login(url, password)
      const view = (await (await request(`${url}/settings`, cookie)).json()) as SettingsView
      const onebot = view.adapters.onebot11
      if (!onebot) throw new Error('Missing adapter settings')
      expect(onebot.value.connections[0]?.accessToken).toBe(`\${ASABOT_BATCH3_REFERENCE}`)
      expect(onebot.value.connections[1]?.accessToken).toBe('********')
      expect(JSON.stringify(view).includes(literal)).toBe(false)
      expect(JSON.stringify(view).includes(envSecret)).toBe(false)
      const properties = onebot.schema.properties as Record<string, Record<string, unknown>>
      for (const key of ['apiTimeout', 'reconnect', 'connections', 'reverse', 'sendQueue']) {
        expect(typeof properties[key]?.title).toBe('string')
        expect(typeof properties[key]?.description).toBe('string')
        expect(Object.hasOwn(properties[key] ?? {}, 'default')).toBe(true)
      }
      const reconnect = properties.reconnect?.properties as Record<string, Record<string, unknown>>
      expect(reconnect.minDelay?.default).toBe(1000)
      expect(reconnect.maxDelay?.default).toBe(60_000)
      const reverse = properties.reverse?.properties as Record<string, Record<string, unknown>>
      expect(reverse.enabled?.default).toBe(false)
      expect(reverse.accessToken?.default).toBe('')
      const queue = properties.sendQueue?.properties as Record<string, Record<string, unknown>>
      expect(queue.interval?.default).toBe(500)
      expect(queue.jitter?.default).toBe(300)
      expect(queue.maxPending?.default).toBe(100)
      const items = properties.connections?.items as { properties: Record<string, Record<string, unknown>> }
      for (const field of Object.values(items.properties)) {
        expect(typeof field.title).toBe('string')
        expect(typeof field.description).toBe('string')
      }
      expect(typeof items.properties.accessToken?.description).toBe('string')
      expect(String(items.properties.accessToken?.description).includes(`\${环境变量}`)).toBe(true)
      const updated = await request(`${url}/settings`, cookie, 'PUT', {
        timezone: 'Asia/Shanghai',
        adapters: { onebot11: onebot.value },
      })
      expect(updated.status).toBe(200)
      const after = (await updated.json()) as SettingsView
      expect(after.restartRequired).toEqual(['timezone'])
      const source = await readFile(path, 'utf8')
      expect(source.includes('# retained root comment')).toBe(true)
      expect(source.includes('# retained timezone comment')).toBe(true)
      expect(source.includes('# retained connection comment')).toBe(true)
      const raw = parse(source) as { adapters: { onebot11: { connections: { accessToken: string }[] } } }
      expect(raw.adapters.onebot11.connections[0]?.accessToken).toBe(`\${ASABOT_BATCH3_REFERENCE}`)
      expect(raw.adapters.onebot11.connections[1]?.accessToken === literal).toBe(true)
      const invalid = await request(`${url}/settings`, cookie, 'PUT', {
        adapters: { onebot11: { connections: [{ type: 'forward', url: 'bad' }] } },
      })
      expect(invalid.status).toBe(400)
      const failure = (await invalid.json()) as { error: { code: string; issues: { path: string }[] } }
      expect(failure.error.code).toBe('BAD_REQUEST')
      expect(
        failure.error.issues.some((issue) => issue.path === 'adapters.onebot11.connections[0].url'),
      ).toBe(true)
      expect((await readFile(path, 'utf8')) === source).toBe(true)
      const invalidDuration = await request(`${url}/settings`, cookie, 'PUT', {
        adapters: { onebot11: { apiTimeout: `\${ASABOT_BATCH3_REFERENCE}` } },
      })
      expect(invalidDuration.status).toBe(400)
      expect((await invalidDuration.text()).includes(envSecret)).toBe(false)
      const restored = await request(`${url}/settings`, cookie, 'PUT', { timezone: 'UTC' })
      expect(((await restored.json()) as SettingsView).restartRequired).toEqual([])
    } finally {
      await app.stop()
      if (previous === undefined) delete process.env.ASABOT_BATCH3_REFERENCE
      else process.env.ASABOT_BATCH3_REFERENCE = previous
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('applies superusers and command prefixes immediately to messages', async () => {
    const password = secret()
    const plugin = definePlugin({
      name: 'settings-check',
      setup(ctx) {
        ctx
          .command('protected')
          .permission('superuser')
          .action(() => 'allowed')
      },
    })
    const t = await createTestApp({
      plugins: [plugin],
      config: { command: { privateRequirePrefix: true }, server: { port: 0, panelPassword: password } },
    })
    try {
      const url = `http://127.0.0.1:${t.app.server?.address()?.port}/api/panel`
      const cookie = await login(url, password)
      expect((await t.say('/protected', { user: '42', group: null })).includes('allowed')).toBe(false)
      const response = await request(`${url}/settings`, cookie, 'PUT', {
        superusers: ['42'],
        command: { prefixes: ['!'] },
      })
      expect(response.status).toBe(200)
      expect(await t.say('!protected', { user: '42', group: null })).toEqual(['allowed'])
      expect(await t.say('/protected', { user: '42', group: null })).toEqual([
        '没有这个命令，你是不是想用 !protected？',
      ])
    } finally {
      await t.dispose()
    }
  })

  it('reconnects to a new endpoint without replacing the bot and removes a platform', async () => {
    const first = new MockOneBot()
    const second = new MockOneBot()
    const dir = await mkdtemp(join(tmpdir(), 'asabot-reconfigure-'))
    const password = secret()
    const queryToken = secret()
    await Promise.all([first.ready, second.ready])
    const app = createApp(
      configSchema.parse({
        dataDir: dir,
        pluginLoader: { dirs: [], hotReload: false },
        server: { port: 0, panelPassword: password },
        adapters: {
          onebot11: {
            connections: [{ type: 'forward', url: `${first.url}/?token=${queryToken}` }],
            sendQueue: { interval: 0 },
          },
        },
      }),
      { logger: createLogger({ level: 'debug', destination: { write: () => true } }) },
    )
    const events: string[] = []
    app.events.on('bot.offline', () => {
      events.push('offline')
    })
    app.events.on('bot.online', () => {
      events.push('online')
    })
    app.plugins.register(
      definePlugin({
        name: 'reconfigure-check',
        setup(ctx) {
          ctx.command('check').action(() => 'response')
        },
      }),
    )
    try {
      await app.start()
      await vi.waitFor(() => expect(app.bots.get('onebot11', '10000')?.status).toBe('online'))
      expect(JSON.stringify(getRecentLogs()).includes(queryToken)).toBe(false)
      const bot = app.bots.get('onebot11', '10000')
      if (!bot) throw new Error('Bot did not connect')
      events.length = 0
      const url = `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
      const cookie = await login(url, password)
      const response = await request(`${url}/settings`, cookie, 'PUT', {
        adapters: { onebot11: { connections: [{ type: 'forward', url: second.url }] } },
      })
      expect(response.status).toBe(200)
      await vi.waitFor(() => expect(bot.status).toBe('online'))
      expect(app.bots.get('onebot11', '10000') === bot).toBe(true)
      await vi.waitFor(() => expect(events).toEqual(['offline', 'online']))
      await bot.sendPrivate('42', 'outgoing')
      await second.waitForCall('send_private_msg')
      second.emitPrivateMessage({ userId: '42', message: '/check' })
      await vi.waitFor(() =>
        expect(
          second.calls.some(
            (call) => call.action === 'send_private_msg' && JSON.stringify(call.params).includes('response'),
          ),
        ).toBe(true),
      )
      expect((await request(`${url}/settings`, cookie, 'PUT', { adapters: { onebot11: null } })).status).toBe(
        200,
      )
      expect(app.bots.get('onebot11', '10000')).toBeUndefined()
      expect(
        (await request(`${url}/settings`, cookie, 'PUT', { adapters: { onebot11: { connections: [] } } }))
          .status,
      ).toBe(200)
      expect(
        (
          await request(`${url}/settings`, cookie, 'PUT', {
            adapters: { onebot11: { reverse: { enabled: true } } },
          })
        ).status,
      ).toBe(200)
      expect(app.getUpgrade('/onebot/v11/ws')).toBeDefined()
      expect(
        (
          await request(`${url}/settings`, cookie, 'PUT', {
            adapters: { onebot11: { reverse: { enabled: false } } },
          })
        ).status,
      ).toBe(200)
      expect(app.getUpgrade('/onebot/v11/ws')).toBeUndefined()
    } finally {
      await app.stop()
      await Promise.all([first.close(), second.close()])
      await rm(dir, { recursive: true, force: true })
    }
  })
})
