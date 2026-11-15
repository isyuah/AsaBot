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

interface ConnectionView {
  id: string
  name: string
  adapter: string
  enabled: boolean
  state: string
  config: { type: string; url?: string; accessToken?: string; apiTimeout?: unknown }
}

describe('panel settings and connection management', () => {
  it('preserves secret references, hidden values and YAML comments in dedicated connection APIs', async () => {
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
        'connections:',
        '  - id: first',
        '    name: First',
        '    adapter: onebot11',
        '    enabled: false',
        '    config:',
        '      type: forward',
        '      url: ws://127.0.0.1:1 # retained connection comment',
        `      accessToken: \${ASABOT_BATCH3_REFERENCE}`,
        '  - id: second',
        '    name: Second',
        '    adapter: onebot11',
        '    enabled: false',
        '    config:',
        '      type: forward',
        '      url: ws://127.0.0.1:2',
        `      accessToken: ${JSON.stringify(literal)}`,
        '',
      ].join('\n'),
    )
    const app = createApp(await loadConfig(path), { configPath: path, logger: pino({ level: 'silent' }) })
    try {
      await app.start()
      const url = `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
      const cookie = await login(url, password)
      const records = (await (await request(`${url}/connections`, cookie)).json()) as ConnectionView[]
      expect(records[0]?.config.accessToken).toBe(`\${ASABOT_BATCH3_REFERENCE}`)
      expect(records[1]?.config.accessToken).toBe('********')
      expect(JSON.stringify(records)).not.toContain(literal)
      expect(JSON.stringify(records)).not.toContain(envSecret)
      const second = records[1]
      if (!second) throw new Error('Missing connection')
      expect(
        (
          await request(`${url}/connections/second`, cookie, 'PUT', {
            name: second.name,
            adapter: second.adapter,
            enabled: second.enabled,
            config: second.config,
          })
        ).status,
      ).toBe(200)
      const updated = await request(`${url}/settings`, cookie, 'PUT', { timezone: 'Asia/Shanghai' })
      expect((await updated.json()).restartRequired).toEqual(['timezone'])
      const source = await readFile(path, 'utf8')
      for (const comment of [
        '# retained root comment',
        '# retained timezone comment',
        '# retained connection comment',
      ])
        expect(source).toContain(comment)
      const raw = parse(source) as { connections: { config: { accessToken: string } }[] }
      expect(raw.connections[0]?.config.accessToken).toBe(`\${ASABOT_BATCH3_REFERENCE}`)
      expect(raw.connections[1]?.config.accessToken).toBe(literal)
      for (const config of [
        { type: 'forward', url: 'bad' },
        { ...second.config, apiTimeout: `\${ASABOT_BATCH3_REFERENCE}` },
      ]) {
        const invalid = await request(`${url}/connections/second`, cookie, 'PUT', {
          name: second.name,
          adapter: second.adapter,
          enabled: false,
          config,
        })
        expect(invalid.status).toBe(400)
        expect(await invalid.text()).not.toContain(envSecret)
        expect(await readFile(path, 'utf8')).toBe(source)
      }
      const restored = await request(`${url}/settings`, cookie, 'PUT', { timezone: 'UTC' })
      expect((await restored.json()).restartRequired).toEqual([])
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
        superusers: [{ platform: 'virtual', selfId: '10000', userId: '42' }],
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

  it('reconfigures one connection, disables it and creates an independent reverse listener', async () => {
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
        connections: [
          {
            id: 'first',
            name: 'First',
            adapter: 'onebot11',
            config: { type: 'forward', url: `${first.url}/?token=${queryToken}`, sendQueue: { interval: 0 } },
          },
        ],
      }),
      { logger: createLogger({ level: 'debug', destination: { write: () => true } }) },
    )
    try {
      await app.start()
      await vi.waitFor(() => expect(app.bots.get('onebot11', '10000')?.status).toBe('online'))
      expect(JSON.stringify(getRecentLogs())).not.toContain(queryToken)
      const bot = app.bots.get('onebot11', '10000')
      const url = `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
      const cookie = await login(url, password)
      const input = {
        name: 'First',
        adapter: 'onebot11',
        enabled: true,
        config: { type: 'forward', url: second.url, sendQueue: { interval: 0 } },
      }
      expect((await request(`${url}/connections/first`, cookie, 'PUT', input)).status).toBe(200)
      await vi.waitFor(() => expect(app.bots.get('onebot11', '10000')?.status).toBe('online'))
      expect(app.bots.get('onebot11', '10000')).toBe(bot)
      await bot?.sendPrivate('42', 'outgoing')
      await second.waitForCall('send_private_msg')
      expect(
        (await request(`${url}/connections/first`, cookie, 'PUT', { ...input, enabled: false })).status,
      ).toBe(200)
      expect(app.bots.get('onebot11', '10000')).toBeUndefined()
      expect(app.connections.list()[0]?.state).toBe('disabled')
      expect(
        (
          await request(`${url}/connections`, cookie, 'POST', {
            id: 'listener',
            name: 'Listener',
            adapter: 'onebot11',
            config: { type: 'reverse', accessToken: 'test-token' },
          })
        ).status,
      ).toBe(201)
      expect(app.getUpgrade('/connections/listener/onebot/v11/ws')).toBeDefined()
      expect(app.connections.list().find((item) => item.id === 'listener')?.state).toBe('waiting')
      expect((await request(`${url}/connections/listener`, cookie, 'DELETE', {})).status).toBe(200)
      expect(app.getUpgrade('/connections/listener/onebot/v11/ws')).toBeUndefined()
    } finally {
      await app.stop()
      await Promise.all([first.close(), second.close()])
      await rm(dir, { recursive: true, force: true })
    }
  })
})
