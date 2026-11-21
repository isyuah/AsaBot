import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/bootstrap.ts'
import { configSchema } from '../src/core/config/schema.ts'

describe('package market', () => {
  it('sorts and pages a cached registry search, and caches complete package information', async () => {
    const iconUrl = 'https://assets.example.test/market.svg'
    const keywords = ['asabot-plugin', `asabot-icon:${iconUrl}`]
    const dir = await mkdtemp(join(tmpdir(), 'asabot-market-'))
    const packageDir = join(dir, 'packages')
    const installedDir = join(packageDir, 'node_modules', 'asabot-market-001')
    await mkdir(installedDir, { recursive: true })
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({ dependencies: { 'asabot-market-001': '1.0.0' } }),
    )
    await writeFile(
      join(installedDir, 'package.json'),
      JSON.stringify({
        name: 'asabot-market-001',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
        keywords,
        peerDependencies: { '@asabot/core': '^0.2.0' },
      }),
    )
    await writeFile(join(installedDir, 'index.js'), "export default { name: 'market-fixture', setup() {} }")
    await writeFile(join(installedDir, 'ReadMe.MD'), '# Installed v1.0.0')
    const searchRequests: URL[] = []
    const metadataAccept: string[] = []
    const objects = Array.from({ length: 250 }, (_, index) => {
      const id = 250 - index
      return {
        package: {
          name: `asabot-market-${String(id).padStart(3, '0')}`,
          version: '1.0.0',
          ...(id === 1 ? { keywords } : {}),
          ...(id === 2
            ? { keywords: ['asabot-plugin', 'asabot-icon:http://assets.example.test/icon.png'] }
            : {}),
          date: new Date(Date.UTC(2024, 0, id)).toISOString(),
          links: { npm: 'https://example.test' },
        },
      }
    })
    const versions = Object.fromEntries(
      Array.from({ length: 52 }, (_, index) => [
        `1.0.${index}`,
        {
          name: 'asabot-market-001',
          version: `1.0.${index}`,
          keywords: index === 51 || index === 0 ? keywords : ['asabot-plugin'],
          peerDependencies: { '@asabot/core': index === 51 ? '^0.2.0' : '^9.0.0' },
          ...(index === 50 ? { deprecated: 'obsolete' } : {}),
        },
      ]),
    )
    const packument = {
      name: 'asabot-market-001',
      description: '示例插件',
      license: 'MIT',
      homepage: 'https://example.test',
      repository: { url: 'https://example.test/repo' },
      'dist-tags': { latest: '1.0.51' },
      versions,
      time: { '1.0.51': '2025-01-01T00:00:00.000Z' },
      readme: `${'a'.repeat(200 * 1024 - 1)}😀`,
    }
    const registry = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      res.setHeader('content-type', 'application/json')
      if (url.pathname === '/-/v1/search') {
        searchRequests.push(url)
        res.end(JSON.stringify({ total: 300, objects }))
      } else {
        metadataAccept.push(req.headers.accept ?? '')
        res.end(JSON.stringify(packument))
      }
    })
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve))
    const registryPort = (registry.address() as AddressInfo).port
    const password = randomBytes(18).toString('base64url')
    const app = createApp(
      configSchema.parse({
        dataDir: dir,
        pluginLoader: { dirs: [], hotReload: false },
        packages: { dir: packageDir, registry: `http://127.0.0.1:${registryPort}` },
        server: { port: 0, panelPassword: password },
      }),
      { logger: pino({ level: 'silent' }) },
    )
    app.plugins.register({ name: 'local-icon', iconUrl, setup() {} })
    try {
      await app.start()
      const base = `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
      const login = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      if (!cookie) throw new Error('Missing session cookie')
      const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie } })
      type Search = {
        total: number
        items: { name: string; installed: boolean; installedVersion?: string }[]
      }
      const relevance = (await (await get('/packages/search?q=market')).json()) as Search
      expect(relevance.total).toBe(250)
      expect(relevance.items).toHaveLength(20)
      expect(relevance.items[0]?.name).toBe('asabot-market-250')
      const named = (await (await get('/packages/search?q=market&sort=name')).json()) as Search
      expect(named.items[0]).toMatchObject({
        name: 'asabot-market-001',
        installed: true,
        installedVersion: '1.0.0',
        iconUrl,
      })
      expect(named.items[1]).not.toHaveProperty('iconUrl')
      expect(named.items[2]).not.toHaveProperty('iconUrl')
      const second = (await (await get('/packages/search?q=market&sort=name&from=20')).json()) as Search
      expect(second.items[0]?.name).toBe('asabot-market-021')
      const updated = (await (await get('/packages/search?q=market&sort=updated&from=230')).json()) as Search
      expect(updated.items.at(-1)?.name).toBe('asabot-market-001')
      expect((await get('/packages/search?sort=invalid')).status).toBe(400)
      expect(searchRequests).toHaveLength(1)
      expect(searchRequests[0]?.searchParams.get('size')).toBe('250')
      expect(searchRequests[0]?.searchParams.get('from')).toBe('0')
      expect(await (await get('/plugins')).json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'market-fixture', iconUrl }),
          expect.objectContaining({ name: 'local-icon', iconUrl }),
        ]),
      )
      const installedReadme = await get('/plugins/market-fixture/readme')
      expect(installedReadme.status).toBe(200)
      expect(await installedReadme.json()).toEqual({ readme: '# Installed v1.0.0' })
      const info = (await (await get('/packages/info?name=asabot-market-001')).json()) as {
        latest: string
        installed: string
        readme: string
        versions: { version: string; compatible: boolean; deprecated?: string; date?: string }[]
      }
      expect(info.latest).toBe('1.0.51')
      expect(info.installed).toBe('1.0.0')
      expect(info.versions).toHaveLength(50)
      expect(info.versions[0]).toMatchObject({
        version: '1.0.51',
        compatible: true,
        date: '2025-01-01T00:00:00.000Z',
        iconUrl,
      })
      expect(info.versions[1]).toMatchObject({ version: '1.0.50', compatible: false, deprecated: 'obsolete' })
      expect(info.versions[1]).not.toHaveProperty('iconUrl')
      expect(Buffer.byteLength(info.readme)).toBeLessThanOrEqual(200 * 1024)
      expect(info.readme.endsWith('😀')).toBe(false)
      await get('/packages/info?name=asabot-market-001')
      expect(metadataAccept.filter((accept) => accept === 'application/json')).toHaveLength(1)
      const now = Date.now.bind(Date)
      const clock = vi.spyOn(Date, 'now')
      try {
        clock.mockImplementation(() => now() + 301_000)
        await get('/packages/search?q=market')
        await get('/packages/info?name=asabot-market-001')
        expect(searchRequests).toHaveLength(2)
        expect(metadataAccept.filter((accept) => accept === 'application/json')).toHaveLength(1)
        clock.mockImplementation(() => now() + 601_000)
        await get('/packages/info?name=asabot-market-001')
        expect(metadataAccept.filter((accept) => accept === 'application/json')).toHaveLength(2)
      } finally {
        clock.mockRestore()
      }
    } finally {
      await app.stop()
      await new Promise<void>((resolve, reject) =>
        registry.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(dir, { recursive: true, force: true })
    }
  })
})
