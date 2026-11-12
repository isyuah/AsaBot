import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createApp } from '../src/bootstrap.ts'
import { configSchema } from '../src/core/config/schema.ts'
import type { Packument, RegistryClient } from '../src/core/plugin/packages.ts'

describe('plugin package update information', () => {
  it('returns cached views immediately and pushes a refreshed version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asabot-latest-'))
    const packageDir = join(dir, 'packages')
    const pluginDir = join(packageDir, 'node_modules', 'asabot-latest')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({ dependencies: { 'asabot-latest': '1.0.0' } }),
    )
    await writeFile(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'asabot-latest',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
        keywords: ['asabot-plugin'],
        peerDependencies: { asabot: '^0.1.0' },
      }),
    )
    await writeFile(join(pluginDir, 'index.js'), `export default { name: 'latest', setup() {} }`)
    const metadata = Promise.withResolvers<Packument>()
    const registry: RegistryClient = {
      metadata: () => metadata.promise,
      async search() {
        return { total: 0, items: [] }
      },
    }
    const config = configSchema.parse({
      dataDir: dir,
      packages: { dir: packageDir },
      pluginLoader: { dirs: [], hotReload: false },
      server: { port: 0, panelPassword: 'secret' },
    })
    const app = createApp(config, { logger: pino({ level: 'silent' }), packages: { registry } })
    let socket: WebSocket | undefined
    try {
      await app.start()
      const url = `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
      const login = await fetch(`${url}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'secret' }),
      })
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      if (!cookie) throw new Error('Missing panel cookie')
      socket = new WebSocket(`${url.replace('http:', 'ws:')}/ws`, { headers: { Cookie: cookie } })
      const updated = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Missing plugin update frame')), 3000)
        socket?.on('message', (data) => {
          const frame = JSON.parse(data.toString()) as {
            type: string
            plugin?: { name: string; package?: { latest?: string } }
          }
          if (
            frame.type === 'plugin' &&
            frame.plugin?.name === 'latest' &&
            frame.plugin.package?.latest === '2.0.0'
          ) {
            clearTimeout(timer)
            resolve()
          }
        })
        socket?.once('error', reject)
      })
      await new Promise<void>((resolve, reject) => {
        socket?.once('open', resolve)
        socket?.once('error', reject)
      })
      const response = await fetch(`${url}/plugins`, {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(2000),
      })
      const plugins = (await response.json()) as { name: string; package?: { latest?: string } }[]
      expect(plugins.find((item) => item.name === 'latest')?.package?.latest).toBeUndefined()
      metadata.resolve({ name: 'asabot-latest', 'dist-tags': { latest: '2.0.0' }, versions: {} })
      await updated
      const refreshed = (await (
        await fetch(`${url}/plugins`, { headers: { Cookie: cookie } })
      ).json()) as typeof plugins
      expect(refreshed.find((item) => item.name === 'latest')?.package?.latest).toBe('2.0.0')
    } finally {
      socket?.terminate()
      await app.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
