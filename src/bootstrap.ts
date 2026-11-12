import type { Logger } from 'pino'
import { OneBotAdapter } from './adapters/onebot11/adapter.ts'
import type { AdapterHost } from './core/adapter.ts'
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
  for (const connection of config.onebot11.connections) {
    const url = new URL(connection.url)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    const host: AdapterHost = {
      logger: app.logger,
      sessionServices: app.sessionServices,
      emit: (event) => app.emit(event),
      registerBot: (bot) => {
        app.registerBot(bot)
        app.setBotConnection(bot, { connection: 'forward', url: url.toString() })
      },
      unregisterBot: (bot) => app.unregisterBot(bot),
      isSuperuser: (userId) => app.isSuperuser(userId),
    }
    app.useAdapter(
      new OneBotAdapter({ ...config.onebot11, connections: [connection] }, host, {
        logger: app.logger,
        ignoreSelf: config.dispatch.ignoreSelf,
      }),
    )
  }
  if (config.server.panelPassword || config.server.apiToken) app.useServer(new HttpServer(app))
  return app
}
