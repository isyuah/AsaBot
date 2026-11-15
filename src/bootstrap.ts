import type { Logger } from 'pino'
import { adapters } from './adapters/index.ts'
import type { AdapterDefinition } from './core/adapter.ts'
import { App } from './core/app.ts'
import type { Config } from './core/config/schema.ts'
import { createLogger } from './core/logger.ts'
import type { PackageOptions } from './core/plugin/packages.ts'
import { createAdminPlugin } from './plugins/admin.ts'
import { createHelpPlugin } from './plugins/help.ts'
import history from './plugins/history.ts'
import http from './plugins/http.ts'
import longMessage from './plugins/long-message.ts'
import { createStatusPlugin } from './plugins/status.ts'
import { HttpServer } from './server/index.ts'

export interface CreateAppOptions {
  logger?: Logger
  configPath?: string
  packages?: PackageOptions
  setupCode?: string
  adapters?: { definition: AdapterDefinition; source: string }[]
}

/** 根据已校验配置创建应用，注册内置插件和适配器；配置无效或适配器未知时抛出 ConfigError。 */
export function createApp(config: Config, options: CreateAppOptions = {}): App {
  const app = new App(config, options.logger ?? createLogger(config.log), {
    configPath: options.configPath,
    packages: options.packages,
    setupCode: options.setupCode,
  })
  app.plugins.register(createHelpPlugin(app))
  app.plugins.register(createStatusPlugin(app))
  app.plugins.register(createAdminPlugin(app))
  app.plugins.register(http)
  app.plugins.register(history)
  app.plugins.register(longMessage)
  for (const definition of adapters) app.connections.register(definition, 'builtin')
  for (const { definition, source } of options.adapters ?? []) app.connections.register(definition, source)
  app.connections.validate(config.connections)
  app.configureServer(() => new HttpServer(app))
  return app
}
