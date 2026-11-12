import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import type { z } from 'zod'
import { VirtualAdapter } from '../adapters/virtual/index.ts'
import { createApp } from '../bootstrap.ts'
import type { App } from '../core/app.ts'
import { configSchema } from '../core/config/schema.ts'
import type { Message } from '../core/message/index.ts'
import { plainText } from '../core/message/index.ts'
import type { PluginDefinition } from '../core/plugin/definition.ts'

type DeepPartial<T> = T extends readonly (infer Item)[]
  ? DeepPartial<Item>[]
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> }
    : T

export interface TestAppOptions {
  plugins?: PluginDefinition[]
  pluginDirs?: string[]
  config?: DeepPartial<z.input<typeof configSchema>>
}

export interface SayOptions {
  group?: string | null
  user?: string
  role?: 'owner' | 'admin' | 'member'
  superuser?: boolean
}

export interface TestApp {
  app: App
  mock: VirtualAdapter
  say(message: string | Message, options?: SayOptions): Promise<(string | Message)[]>
  dispose(): Promise<void>
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const dataDir = await mkdtemp(join(tmpdir(), 'asabot-test-'))
  let app: App | undefined
  try {
    if (options.config?.adapters && Object.keys(options.config.adapters).length > 0) {
      throw new Error('createTestApp uses the virtual adapter; external adapters cannot be configured')
    }
    const config = configSchema.parse({
      ...options.config,
      dataDir,
      adapters: {},
      pluginLoader: {
        hotReload: false,
        ...options.config?.pluginLoader,
        dirs: options.pluginDirs ?? options.config?.pluginLoader?.dirs ?? [],
      },
    })
    app = createApp(config, { logger: pino({ level: 'silent' }) })
    const mock = new VirtualAdapter(app)
    app.useAdapter(mock)
    for (const plugin of options.plugins ?? []) app.plugins.register(plugin)
    await app.start()
    await app.whenIdle()
    const activeApp = app
    return {
      app: activeApp,
      mock,
      async say(message, input = {}) {
        const sends = await mock.receive(message, {
          user: input.user ?? '20',
          group: input.group === null ? null : (input.group ?? '10'),
          role: input.role,
          superuser: input.superuser || undefined,
        })
        return sends.map(({ message: sent }) =>
          sent.every((segment) => segment.type === 'text') ? plainText(sent) : sent,
        )
      },
      async dispose() {
        await activeApp.stop()
        await rm(dataDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await app?.stop()
    await rm(dataDir, { recursive: true, force: true })
    throw error
  }
}
