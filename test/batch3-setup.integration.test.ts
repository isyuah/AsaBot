import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { createApp } from '../src/bootstrap.ts'
import { loadMainConfig } from '../src/cli.ts'
import type { App } from '../src/core/app.ts'
import { createLogger, getRecentLogs } from '../src/core/logger.ts'

interface RunningMain {
  app: App
  code: string
  port: number
}

async function startMain(dir: string): Promise<RunningMain> {
  const path = join(dir, 'config.yaml')
  let stderr = ''
  const output = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  vi.stubEnv('ASABOT_HOST', '127.0.0.1')
  vi.stubEnv('ASABOT_PORT', '0')
  let prepared: Awaited<ReturnType<typeof loadMainConfig>>
  try {
    prepared = await loadMainConfig(path)
  } finally {
    output.mockRestore()
    vi.unstubAllEnvs()
  }
  if (!prepared.setupCode) throw new Error('Setup code was not generated')
  expect(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(prepared.setupCode)).toBe(true)
  expect(stderr.includes(prepared.setupCode)).toBe(true)
  prepared.config.dataDir = join(dir, 'data')
  prepared.config.pluginLoader.dirs = []
  prepared.config.pluginLoader.hotReload = false
  const app = createApp(prepared.config, {
    configPath: path,
    setupCode: prepared.setupCode,
    logger: createLogger({ destination: { write: () => true } }),
  })
  await app.start()
  const port = app.server?.address()?.port
  if (port === undefined) throw new Error('Setup server did not start')
  return { app, code: prepared.setupCode, port }
}

function post(url: string, value: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
}

describe('first-run setup', () => {
  it('generates configuration, prints a code outside the log and completes setup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asabot-setup-'))
    let running: RunningMain | undefined
    try {
      running = await startMain(dir)
      const url = `http://127.0.0.1:${running.port}/api/panel`
      const session = await (await fetch(`${url}/session`)).json()
      expect(session).toEqual({ authenticated: false, setup: true })
      expect((await fetch(`${url}/overview`)).status).toBe(401)
      expect((await post(`${url}/login`, { password: randomBytes(12).toString('hex') })).status).toBe(401)
      const password = randomBytes(18).toString('base64url')
      const wrong = await post(`${url}/setup`, {
        code: 'INVALID',
        password,
        superusers: [{ platform: 'virtual', selfId: '10000', userId: '42' }],
      })
      expect(wrong.status).toBe(401)
      const response = await post(`${url}/setup`, {
        code: running.code,
        password,
        superusers: [{ platform: 'virtual', selfId: '10000', userId: '42' }],
        adapters: { onebot11: { reverse: { enabled: true } } },
      })
      expect(response.status).toBe(200)
      expect(running.app.getUpgrade('/onebot/v11/ws')).toBeDefined()
      expect(await response.json()).toEqual({ ok: true })
      const cookie = response.headers.get('set-cookie')?.split(';')[0]
      if (!cookie) throw new Error('Missing session cookie')
      const settings = await fetch(`${url}/settings`, { headers: { cookie } })
      expect(settings.status).toBe(200)
      const view = (await settings.json()) as {
        superusers: { platform: string; selfId: string; userId: string }[]
      }
      expect(view.superusers).toEqual([{ platform: 'virtual', selfId: '10000', userId: '42' }])
      const logs = await (await fetch(`${url}/logs`, { headers: { cookie } })).text()
      expect(logs.includes(running.code)).toBe(false)
      expect(logs.includes(password)).toBe(false)
      expect(JSON.stringify(getRecentLogs()).includes(running.code)).toBe(false)
      const source = await readFile(join(dir, 'config.yaml'), 'utf8')
      expect(source.includes('asabot.config.example.yaml')).toBe(true)
      const saved = parse(source) as { server: { host: string; port: number; panelPassword: string } }
      expect(saved.server.host).toBe('127.0.0.1')
      expect(saved.server.port).toBe(0)
      expect(saved.server.panelPassword === password).toBe(true)
    } finally {
      await running?.app.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocks public APIs and counts failed setup codes against login rate limits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asabot-setup-limit-'))
    const apiToken = randomBytes(18).toString('base64url')
    await writeFile(
      join(dir, 'config.yaml'),
      stringify({
        superusers: [],
        adapters: {},
        server: { host: '127.0.0.1', port: 0, panelPassword: '', apiToken },
      }),
    )
    let running: RunningMain | undefined
    try {
      running = await startMain(dir)
      const base = `http://127.0.0.1:${running.port}`
      expect(
        (await fetch(`${base}/api/v1/bots`, { headers: { authorization: `Bearer ${apiToken}` } })).status,
      ).toBe(401)
      const input = { code: 'INVALID', password: randomBytes(18).toString('base64url'), superusers: [] }
      for (let i = 0; i < 10; i++) expect((await post(`${base}/api/panel/setup`, input)).status).toBe(401)
      expect((await post(`${base}/api/panel/setup`, input)).status).toBe(429)
    } finally {
      await running?.app.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
