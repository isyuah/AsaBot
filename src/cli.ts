#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { stringify } from 'yaml'
import { loadAdapterModules } from './adapters/loader.ts'
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
        adapterModules: [],
        connections: [],
        server: { host, port, panelPassword: '' },
      })}`,
      { encoding: 'utf8', flag: 'wx' },
    )
  }

  const config = await loadConfig(configPath)
  const setup = missing || (!config.server.panelPassword && config.connections.length === 0)
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

async function start(configOption: string | undefined, dev: boolean): Promise<void> {
  const envPath = resolve('.env')
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath)
  }

  const configPath = configOption ?? (process.env.ASABOT_CONFIG || './asabot.config.yaml')
  const { config, setupCode } = await loadMainConfig(configPath)
  if (dev) config.pluginLoader.hotReload = true
  const app = createApp(config, {
    configPath,
    setupCode,
    adapters: await loadAdapterModules(config.adapterModules),
  })
  installProcessHandlers(app)
  app.logger.info({ configPath }, 'Starting AsaBot')
  await app.start()
}

function printUsage(): void {
  process.stdout.write(`Usage: asabot <start|dev> [--config <path>]
       asabot --version | -v
       asabot --help
`)
}

async function runCli(): Promise<void> {
  const parsed = (() => {
    try {
      return parseArgs({
        allowPositionals: true,
        options: {
          help: { type: 'boolean' },
          version: { type: 'boolean', short: 'v' },
          config: { type: 'string' },
        },
      })
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      printUsage()
      process.exitCode = 1
      return undefined
    }
  })()
  if (!parsed) return

  const { values, positionals } = parsed
  const command = positionals[0]
  if (positionals.length > 1 || (command !== undefined && command !== 'start' && command !== 'dev')) {
    printUsage()
    process.exitCode = 1
    return
  }
  if (values.help) {
    printUsage()
    return
  }
  if (values.version && command === undefined && values.config === undefined) {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    process.stdout.write(`${manifest.version}\n`)
    return
  }
  if (command === undefined || values.version) {
    printUsage()
    if (values.config !== undefined || values.version) process.exitCode = 1
    return
  }
  await start(values.config, command === 'dev')
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void runCli().catch((error: unknown) => {
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
