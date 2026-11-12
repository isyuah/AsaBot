import type { Logger } from 'pino'
import { adapters } from './adapters/index.ts'
import { App } from './core/app.ts'
import { formatIssuePath } from './core/config/load.ts'
import type { Config } from './core/config/schema.ts'
import { ConfigError } from './core/errors.ts'
import { createLogger } from './core/logger.ts'
import { createAdminPlugin } from './plugins/admin.ts'
import { createHelpPlugin } from './plugins/help.ts'
import { createStatusPlugin } from './plugins/status.ts'
import { HttpServer } from './server/index.ts'

export interface CreateAppOptions {
  logger?: Logger
  configPath?: string
}

export function createApp(config: Config, options: CreateAppOptions = {}): App {
  const app = new App(config, options.logger ?? createLogger({ level: config.logLevel }), {
    configPath: options.configPath,
  })
  app.plugins.register(createHelpPlugin(app))
  app.plugins.register(createStatusPlugin(app))
  app.plugins.register(createAdminPlugin(app))
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
    app.useAdapter(definition.create(result.data, app))
  }
  app.configureServer(() => new HttpServer(app))
  return app
}
