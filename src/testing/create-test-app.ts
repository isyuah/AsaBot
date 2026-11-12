import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import type { z } from 'zod'
import { VirtualAdapter } from '../adapters/virtual/index.ts'
import { createApp } from '../bootstrap.ts'
import type { App } from '../core/app.ts'
import type { BotCapabilities } from '../core/bot.ts'
import { configSchema } from '../core/config/schema.ts'
import type { Message } from '../core/message/index.ts'
import { plainText } from '../core/message/index.ts'
import type { PluginDefinition } from '../core/plugin/definition.ts'

type DeepPartial<T> = T extends readonly (infer Item)[]
  ? DeepPartial<Item>[]
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> }
    : T

/** 测试应用的插件、插件目录、配置和虚拟机器人能力选项。 */
export interface TestAppOptions {
  capabilities?: Partial<BotCapabilities>
  plugins?: PluginDefinition[]
  pluginDirs?: string[]
  config?: DeepPartial<z.input<typeof configSchema>>
}

/** 模拟消息的群、用户、角色和超管状态；group 为 null 时使用私聊。 */
export interface SayOptions {
  group?: string | null
  user?: string
  role?: 'owner' | 'admin' | 'member'
  superuser?: boolean
}

/** 测试应用、虚拟适配器、模拟发言及资源释放入口。 */
export interface TestApp {
  /** 已启动的框架应用。 */
  app: App
  /** 用于模拟消息和事件的虚拟适配器。 */
  mock: VirtualAdapter
  /** 模拟发言并返回本次回复；默认是群 10 中用户 20 的消息，group 为 null 表示私聊。 */
  say(message: string | Message, options?: SayOptions): Promise<(string | Message)[]>
  /** 停止应用并删除临时数据目录。 */
  dispose(): Promise<void>
}

/**
 * 创建使用虚拟适配器和临时数据库的测试应用；配置外部适配器或启动失败时抛错，测试后须调用 dispose。
 * @example
 * const t = await createTestApp({ plugins: [plugin] })
 * try { await t.say('/hello') } finally { await t.dispose() }
 */
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
    const mock = new VirtualAdapter(app, { capabilities: options.capabilities })
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
