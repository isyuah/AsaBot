import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import type { z } from 'zod'
import { createApp } from '../bootstrap.ts'
import type { App } from '../core/app.ts'
import { configSchema } from '../core/config/schema.ts'
import type { AnyEvent } from '../core/event/index.ts'
import type { Message } from '../core/message/index.ts'
import { plainText } from '../core/message/index.ts'
import type { PluginDefinition } from '../core/plugin/definition.ts'
import { MockOneBot } from './mock-onebot.ts'

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
  mock: MockOneBot
  say(message: string | Message, options?: SayOptions): Promise<(string | Message)[]>
  dispose(): Promise<void>
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const dataDir = await mkdtemp(join(tmpdir(), 'asabot-test-'))
  const mock = new MockOneBot()
  let app: App | undefined
  try {
    await mock.ready
    const config = configSchema.parse({
      ...options.config,
      dataDir,
      pluginLoader: {
        hotReload: false,
        ...options.config?.pluginLoader,
        dirs: options.pluginDirs ?? options.config?.pluginLoader?.dirs ?? [],
      },
      onebot11: { ...options.config?.onebot11, connections: [{ type: 'forward', url: mock.url }] },
    })
    app = createApp(config, { logger: pino({ level: 'silent' }) })
    for (const plugin of options.plugins ?? []) app.plugins.register(plugin)
    const activeApp = app
    const online = new Promise<void>((resolve) => {
      const off = activeApp.events.on('bot.online', () => {
        off()
        resolve()
      })
    })
    await activeApp.start()
    await online
    await activeApp.whenIdle()

    let queue: Promise<unknown> = Promise.resolve()
    let notify: ((event: AnyEvent) => void) | undefined
    const emit = activeApp.emit.bind(activeApp)
    activeApp.emit = (event) => {
      emit(event)
      notify?.(event)
    }
    const say = (message: string | Message, input: SayOptions = {}): Promise<(string | Message)[]> => {
      const run = async (): Promise<(string | Message)[]> => {
        const user = input.user ?? '20'
        const group = input.group === null ? undefined : (input.group ?? '10')
        const alreadySuperuser = config.superusers.includes(user)
        if (input.superuser && !alreadySuperuser) config.superusers.push(user)
        const start = mock.calls.length
        try {
          const received = new Promise<void>((resolve) => {
            notify = (event) => {
              if (event.kind === 'message' && event.userId === user && event.groupId === group) {
                notify = undefined
                resolve()
              }
            }
          })
          if (group === undefined) mock.emitPrivateMessage({ userId: user, message })
          else mock.emitGroupMessage({ groupId: group, userId: user, message, role: input.role })
          await received
          await activeApp.whenIdle()
          return mock.calls
            .slice(start)
            .filter((call) => call.action === 'send_group_msg' || call.action === 'send_private_msg')
            .map((call) => {
              const segments = call.params.message as Message
              return segments.every((segment) => segment.type === 'text') ? plainText(segments) : segments
            })
        } finally {
          notify = undefined
          if (input.superuser && !alreadySuperuser)
            config.superusers.splice(config.superusers.indexOf(user), 1)
        }
      }
      const result = queue.then(run)
      queue = result.catch((error: unknown) => {
        activeApp.logger.debug({ err: error }, 'Test message failed')
      })
      return result
    }
    return {
      app: activeApp,
      mock,
      say,
      async dispose() {
        await activeApp.stop()
        await mock.close()
        await rm(dataDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await app?.stop()
    await mock.close()
    await rm(dataDir, { recursive: true, force: true })
    throw error
  }
}
