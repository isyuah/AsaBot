import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { z } from 'zod'
import { createApp } from '../src/bootstrap.ts'
import { defineAdapter } from '../src/core/adapter.ts'
import { configSchema } from '../src/core/config/schema.ts'

describe('adapter registration', () => {
  it('reports adapter configuration errors with their full paths', () => {
    const config = configSchema.parse({
      connections: [
        { id: 'primary', name: 'Primary', adapter: 'onebot11', config: { type: 'forward', url: 'bad' } },
      ],
    })
    expect(() => createApp(config)).toThrow(/connections.primary.config/)
  })

  it('reports unknown adapters', () => {
    expect(() =>
      createApp(
        configSchema.parse({
          connections: [{ id: 'unknown', name: 'Unknown', adapter: 'unknown', config: {} }],
        }),
      ),
    ).toThrow(/Unknown adapter/)
  })

  it('starts the server for an upgrade registered during adapter start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asabot-upgrade-'))
    const definition = defineAdapter({
      id: 'custom',
      platform: 'custom',
      name: 'Custom',
      version: '1.0.0',
      description: '',
      connectionTypes: ['custom'],
      capabilities: { segments: ['text'], textStyles: [], actions: [] },
      configSchema: z.object({}),
      create(_config, host) {
        return {
          platform: 'custom',
          async start() {
            host.registerUpgrade('/custom/ws', (_request, socket) => {
              socket.end('HTTP/1.1 418 Custom\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            })
          },
          async stop() {},
          async reconfigure() {},
        }
      },
    })
    const app = createApp(
      configSchema.parse({
        connections: [{ id: 'custom', name: 'Custom', adapter: 'custom', config: {} }],
        dataDir: directory,
        pluginLoader: { dirs: [], hotReload: false },
        server: { port: 0 },
      }),
      { logger: pino({ level: 'silent' }), adapters: [{ definition, source: 'custom-package' }] },
    )
    try {
      await app.start()
      const port = app.server?.address()?.port
      expect(port).toBeDefined()
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/connections/custom/custom/ws`)
        client.once('unexpected-response', (_request, response) => {
          response.resume()
          resolve(response.statusCode)
        })
        client.once('error', reject)
      })
      expect(status).toBe(418)
    } finally {
      await app.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('starts the server when an adapter is added after startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asabot-upgrade-'))
    const app = createApp(
      configSchema.parse({
        dataDir: directory,
        pluginLoader: { dirs: [], hotReload: false },
        server: { port: 0 },
      }),
      { logger: pino({ level: 'silent' }) },
    )
    try {
      await app.start()
      expect(app.server).toBeUndefined()
      app.useAdapter({
        platform: 'dynamic',
        async start() {
          app.registerUpgrade('/dynamic/ws', (_request, socket) => socket.end())
        },
        async stop() {},
        async reconfigure() {},
      })
      await vi.waitFor(() => expect(app.server?.address()?.port).toBeDefined())
    } finally {
      await app.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('loads an import-only adapter package from the user project', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'asabot-adapter-module-'))
    const pkg = join(cwd, 'node_modules', 'asabot-adapter-fixture')
    await mkdir(pkg, { recursive: true })
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'asabot-adapter-fixture', type: 'module', exports: { import: './index.js' } }),
    )
    await writeFile(
      join(pkg, 'index.js'),
      `import { z } from ${JSON.stringify(import.meta.resolve('zod'))}; export default {
      id: 'fixture', platform: 'fixture', name: 'Fixture', version: '1.0.0', description: '', connectionTypes: ['custom'],
      capabilities: { segments: ['text'], textStyles: [], actions: [] }, configSchema: z.object({}),
      accountId: () => 'fixture-bot',
      setup: { kind: 'qr', async start() { return { content: 'local-test', async poll() { return { status: 'expired' } } } } },
      create: () => ({ platform: 'fixture', async start() {}, async stop() {}, async reconfigure() {} }),
    }`,
    )
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { loadAdapterModules } from ${JSON.stringify(new URL('../src/adapters/loader.ts', import.meta.url).href)};
        const [item] = await loadAdapterModules(['asabot-adapter-fixture']);
        const challenge = await item.definition.setup.start(new AbortController().signal);
        console.log(JSON.stringify({ id: item.definition.id, source: item.source, setup: item.definition.setup.kind, status: (await challenge.poll()).status }));
      `,
        ],
        { cwd },
      )
      expect(JSON.parse(stdout)).toEqual({
        id: 'fixture',
        source: 'asabot-adapter-fixture',
        setup: 'qr',
        status: 'expired',
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('keeps a failed connection visible before login and masks schema-declared credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asabot-connection-state-'))
    const definition = defineAdapter({
      id: 'broken',
      platform: 'broken',
      name: 'Broken',
      version: '1',
      description: '',
      connectionTypes: ['custom'],
      capabilities: { segments: [], textStyles: [], actions: [] },
      configSchema: z.object({ pin: z.string().meta({ writeOnly: true }) }),
      create: (config) => ({
        platform: 'broken',
        async start() {
          throw new Error(`Login rejected ${config.pin}`)
        },
        async stop() {},
        async reconfigure() {},
      }),
    })
    const app = createApp(
      configSchema.parse({
        dataDir: directory,
        pluginLoader: { dirs: [], hotReload: false },
        connections: [
          { id: 'broken', name: 'Broken', adapter: 'broken', config: { pin: 'test-private-pin' } },
        ],
      }),
      { logger: pino({ level: 'silent' }), adapters: [{ definition, source: 'test' }] },
    )
    try {
      await app.start()
      expect(app.bots.list()).toEqual([])
      expect(app.connections.list()).toMatchObject([
        { id: 'broken', state: 'error', lastError: 'Login rejected [Redacted]' },
      ])
    } finally {
      await app.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
