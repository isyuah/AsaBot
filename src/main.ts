import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createApp } from './bootstrap.ts'
import type { App } from './core/app.ts'
import { loadConfig } from './core/config/load.ts'
import { ConfigError } from './core/errors.ts'
import { createLogger } from './core/logger.ts'

async function flushLogger(log: ReturnType<typeof createLogger>): Promise<void> {
  await new Promise<void>((resolveFlush) => log.flush(() => resolveFlush()))
}

function installProcessHandlers(app: App): void {
  const log = app.logger
  let shuttingDown = false
  let shutdownTimer: NodeJS.Timeout | undefined
  // A bot keeps running even with no active connections (reconnect loops, schedulers, HTTP server).
  const keepAliveTimer = setInterval(() => {}, 2_147_483_647)

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) {
      log.fatal({ reason }, 'Forced exit after a second shutdown signal')
      process.exit(1)
    }

    shuttingDown = true
    log.info({ reason }, 'Graceful shutdown started')
    shutdownTimer = setTimeout(() => {
      log.fatal({ reason }, 'Shutdown exceeded the 5 second grace period')
      process.exit(1)
    }, 5_000)

    try {
      await app.stop()
    } catch (error) {
      log.error({ err: error }, 'Failed to stop AsaBot cleanly')
      exitCode = 1
    }

    if (shutdownTimer !== undefined) {
      clearTimeout(shutdownTimer)
    }
    clearInterval(keepAliveTimer)
    process.off('SIGINT', handleSigint)
    process.off('SIGTERM', handleSigterm)
    process.off('unhandledRejection', handleUnhandledRejection)
    process.off('uncaughtException', handleUncaughtException)
    await flushLogger(log)
    // Exit explicitly so a leaked handle (socket, timer) cannot keep the process alive after shutdown.
    process.exit(exitCode)
  }

  const handleSigint = (): void => {
    void shutdown('SIGINT', 0)
  }
  const handleSigterm = (): void => {
    void shutdown('SIGTERM', 0)
  }
  const handleUnhandledRejection = (reason: unknown): void => {
    log.error({ err: reason }, 'Unhandled promise rejection')
  }
  const handleUncaughtException = (error: Error): void => {
    log.fatal({ err: error }, 'Uncaught exception')
    void shutdown('uncaughtException', 1)
  }

  process.on('SIGINT', handleSigint)
  process.on('SIGTERM', handleSigterm)
  process.on('unhandledRejection', handleUnhandledRejection)
  process.on('uncaughtException', handleUncaughtException)
}

export async function runMain(): Promise<void> {
  const envPath = resolve('.env')
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath)
  }

  const configPath = process.env.ASABOT_CONFIG || './asabot.config.yaml'
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `Configuration file "${configPath}" does not exist. Copy "asabot.config.example.yaml" to "asabot.config.yaml".`,
    )
  }

  const config = await loadConfig(configPath)
  const app = createApp(config, { logger: createLogger({ level: config.logLevel }) })
  installProcessHandlers(app)
  app.logger.info({ configPath }, 'Starting AsaBot')
  await app.start()
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runMain().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      // Configuration problems are user-actionable: print the readable message, not a stack trace.
      process.stderr.write(`AsaBot failed to start: ${error.message}
`)
    } else {
      createLogger().fatal({ err: error }, 'Startup failed')
    }
    process.exitCode = 1
  })
}
