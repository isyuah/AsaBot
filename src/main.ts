import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringify } from 'yaml'
import { createApp } from './bootstrap.ts'
import type { App } from './core/app.ts'
import { loadConfig } from './core/config/load.ts'
import type { Config } from './core/config/schema.ts'
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

export async function loadMainConfig(configPath: string): Promise<{ config: Config; setupCode?: string }> {
  const missing = !existsSync(configPath)
  if (missing) {
    const host = process.env.ASABOT_HOST || '127.0.0.1'
    const portValue = process.env.ASABOT_PORT || '5140'
    const port = Number(portValue)
    if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port > 65_535) {
      throw new ConfigError('ASABOT_PORT must be an integer between 0 and 65535')
    }
    await mkdir(dirname(resolve(configPath)), { recursive: true })
    await writeFile(
      configPath,
      `# 完整配置示例见 asabot.config.example.yaml\n${stringify({
        superusers: [],
        adapters: {},
        server: { host, port, panelPassword: '' },
      })}`,
      { encoding: 'utf8', flag: 'wx' },
    )
  }

  const config = await loadConfig(configPath)
  const setup = missing || (!config.server.panelPassword && Object.keys(config.adapters).length === 0)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const characters = setup ? [...randomBytes(8)].map((byte) => alphabet[byte & 31]).join('') : ''
  const setupCode = setup ? `${characters.slice(0, 4)}-${characters.slice(4)}` : undefined
  if (setupCode) {
    // Printed straight to the console, never through the logger: it must not reach log files or the panel.
    const { host, port } = config.server
    const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
    process.stderr.write(
      `\n  首次运行：在浏览器打开 http://${shown}:${port} 完成设置\n  设置码：${setupCode}\n\n`,
    )
  }
  return { config, setupCode }
}

export async function runMain(): Promise<void> {
  const envPath = resolve('.env')
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath)
  }

  const configPath = process.env.ASABOT_CONFIG || './asabot.config.yaml'
  const { config, setupCode } = await loadMainConfig(configPath)
  const app = createApp(config, { configPath, setupCode })
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
