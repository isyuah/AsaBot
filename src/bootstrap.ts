import type { Logger } from 'pino'
import { OneBotAdapter } from './adapters/onebot11/adapter.ts'
import { App } from './core/app.ts'
import type { Config } from './core/config/schema.ts'
import { createLogger } from './core/logger.ts'

export interface CreateAppOptions {
  logger?: Logger
  configPath?: string
}

export function createApp(config: Config, options: CreateAppOptions = {}): App {
  const app = new App(config, options.logger ?? createLogger({ level: config.logLevel }), {
    configPath: options.configPath,
  })
  if (config.onebot11.connections.length > 0) {
    app.useAdapter(
      new OneBotAdapter(config.onebot11, app, {
        logger: app.logger,
        ignoreSelf: config.dispatch.ignoreSelf,
      }),
    )
  }
  return app
}
