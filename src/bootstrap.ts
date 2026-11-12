import type { Logger } from 'pino'
import { adapters } from './adapters/index.ts'
import { App } from './core/app.ts'
import { formatIssuePath } from './core/config/load.ts'
import type { Config } from './core/config/schema.ts'
import { ConfigError } from './core/errors.ts'
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
  app.configureAdapters((name, value) => {
    const definition = adapters[name]
    if (!definition) throw new ConfigError(`Unknown adapter "${name}"`)
    return definition.create(value, app)
  })
  for (const [name, value] of Object.entries(config.adapters)) {
    const definition = Object.hasOwn(adapters, name) ? adapters[name] : undefined
    if (definition === undefined) {
      throw new ConfigError(
        `Unknown adapter "${name}". Available adapters: ${Object.keys(adapters).join(', ')}`,
      )
    }
    const result = definition.configSchema.safeParse(value)
    if (!result.success) {
      const issues = result.error.issues.map(
        (issue) => `${formatIssuePath(['adapters', name, ...issue.path])}: ${issue.message}`,
      )
      throw new ConfigError(`Configuration validation failed:\n${issues.join('\n')}`)
    }
    app.useConfiguredAdapter(definition.create(result.data, app), result.data)
  }
  app.configureServer(() => new HttpServer(app))
  return app
}
