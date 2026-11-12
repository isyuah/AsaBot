import type { Logger } from 'pino'
import type { Config } from './config/schema.ts'
import { logger as defaultLogger } from './logger.ts'

type AppState = 'created' | 'running' | 'stopped'

export class App {
  readonly config: Config
  readonly logger: Logger
  private state: AppState = 'created'

  constructor(config: Config, logger: Logger = defaultLogger) {
    this.config = config
    this.logger = logger
  }

  async start(): Promise<void> {
    if (this.state === 'running') {
      return
    }
    if (this.state === 'stopped') {
      throw new Error('A stopped App cannot be restarted')
    }

    this.state = 'running'
    this.logger.info({ dataDir: this.config.dataDir }, 'AsaBot started')
  }

  async stop(): Promise<void> {
    if (this.state !== 'running') {
      return
    }

    this.state = 'stopped'
    this.logger.info('AsaBot stopped')
  }
}
