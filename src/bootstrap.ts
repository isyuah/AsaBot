import type { Logger } from 'pino'
import { OneBotAdapter } from './adapters/onebot11/adapter.ts'
import { App } from './core/app.ts'
import type { Config } from './core/config/schema.ts'
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
  const adapter = new OneBotAdapter(config.onebot11, app, {
    logger: app.logger,
    ignoreSelf: config.dispatch.ignoreSelf,
  })
  app.useAdapter(adapter)
  if (config.server.panelPassword || config.server.apiToken || config.onebot11.reverse !== undefined) {
    app.useServer(
      new HttpServer(app, {
        acceptReverse: (socket, selfId, remoteAddress) =>
          adapter.acceptReverse(socket, selfId, remoteAddress),
        closeReverseConnections: () => adapter.closeReverseConnections(),
      }),
    )
  }
  return app
}
