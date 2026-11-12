import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { z } from 'zod'
import { adapters } from '../src/adapters/index.ts'
import { createApp } from '../src/bootstrap.ts'
import { configSchema } from '../src/core/config/schema.ts'

describe('adapter registration', () => {
  it('reports adapter configuration errors with their full paths', () => {
    const config = configSchema.parse({
      adapters: { onebot11: { connections: [{ type: 'reverse', url: 'bad' }] } },
    })
    expect(() => createApp(config)).toThrow(
      /adapters\.onebot11\.connections\[0\]\.type:.*\nadapters\.onebot11\.connections\[0\]\.url:/,
    )
  })

  it('reports unknown adapters and available names', () => {
    expect(() => createApp(configSchema.parse({ adapters: { unknown: {} } }))).toThrow(/unknown.*onebot11/i)
  })

  it('starts the server for an upgrade registered during adapter start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asabot-upgrade-'))
    adapters.custom = {
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
    }
    const app = createApp(
      configSchema.parse({
        adapters: { custom: {} },
        dataDir: directory,
        pluginLoader: { dirs: [], hotReload: false },
        server: { port: 0 },
      }),
      { logger: pino({ level: 'silent' }) },
    )
    try {
      await app.start()
      const port = app.server?.address()?.port
      expect(port).toBeDefined()
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/custom/ws`)
        client.once('unexpected-response', (_request, response) => {
          response.resume()
          resolve(response.statusCode)
        })
        client.once('error', reject)
      })
      expect(status).toBe(418)
    } finally {
      await app.stop()
      delete adapters.custom
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
})
