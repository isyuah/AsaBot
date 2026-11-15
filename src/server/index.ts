import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { getRequestListener, type HttpBindings } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { type Context, Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import type { App, ServerService } from '../core/app.ts'
import { type Bot, supports } from '../core/bot.ts'
import { commandOverrideSchema, logLevelSchema } from '../core/config/schema.ts'
import { deleteConfigValue, writeConfigValue } from '../core/config/write.ts'
import type { DispatchEvent } from '../core/dispatch/types.ts'
import { NoBotOnlineError, PluginConfigError } from '../core/errors.ts'
import type { MessageSentEvent } from '../core/event/index.ts'
import { getRecentLogs, subscribeLogs } from '../core/logger.ts'
import { plainText } from '../core/message/index.ts'
import type { PackageOperation } from '../core/plugin/packages.ts'
import { TaskConflictError, taskStates } from '../core/plugin/tasks.ts'
import { ManagementError } from '../core/plugin/upload.ts'
import { redactValue } from '../core/utils/redact.ts'
import { constantTimeEqual } from '../core/utils/security.ts'
import { PanelAuth } from './auth.ts'
import { Groups } from './groups.ts'
import { Playground } from './playground.ts'
import { isPluginPageName, pluginPageFile, unsafePluginPageUrl } from './plugin-pages.ts'
import {
  accessSchema,
  packageInstallSchema,
  packageNameSchema,
  packageUninstallSchema,
  playgroundEventSchema,
  playgroundSchema,
  purgeSchema,
  sendSchema,
  uploadSchema,
} from './schemas.ts'
import {
  SettingsService,
  SettingsValidationError,
  SetupCodeError,
  settingsInput,
  setupInput,
} from './settings.ts'
import { botView, commandView, overview, pluginView } from './views.ts'

type Env = { Bindings: HttpBindings }
type ServerContext = Context<Env>
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500

class HttpError extends Error {
  readonly status: ErrorStatus
  readonly code: string
  readonly issues?: { path: string; message: string }[]

  constructor(
    status: ErrorStatus,
    code: string,
    message: string,
    issues?: { path: string; message: string }[],
  ) {
    super(message)
    this.status = status
    this.code = code
    this.issues = issues
  }
}

function failure(c: ServerContext, error: HttpError): Response {
  return c.json(
    {
      error: { code: error.code, message: error.message, ...(error.issues ? { issues: error.issues } : {}) },
    },
    error.status,
  )
}

function issuePath(path: PropertyKey[]): string {
  return (
    path.reduce<string>(
      (value, part) =>
        typeof part === 'number' ? `${value}[${part}]` : value ? `${value}.${String(part)}` : String(part),
      '',
    ) || '<root>'
  )
}

function configSecrets(value: unknown, key = ''): string[] {
  if (typeof value === 'string') {
    if (/token|password|secret/i.test(key)) return value ? [value] : []
    try {
      const url = new URL(value)
      return [
        url.password,
        ...[...url.searchParams]
          .filter(([name]) => /token|password|secret/i.test(name))
          .map(([, secret]) => secret),
      ].filter(Boolean)
    } catch {
      return []
    }
  }
  if (Array.isArray(value)) return value.flatMap((item) => configSecrets(item))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([name, item]) => configSecrets(item, name))
  }
  return []
}

async function body<T extends z.ZodType>(
  c: ServerContext,
  schema: T,
  maxBytes?: number,
): Promise<z.output<T>> {
  let value: unknown
  try {
    if (maxBytes === undefined) value = await c.req.json()
    else {
      if (Number(c.req.header('content-length') ?? 0) > maxBytes)
        throw new HttpError(400, 'BAD_REQUEST', 'Request exceeds 2 MB')
      const reader = c.req.raw.body?.getReader()
      if (!reader) throw new HttpError(400, 'BAD_REQUEST', 'Invalid JSON')
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > maxBytes) {
          await reader.cancel()
          throw new HttpError(400, 'BAD_REQUEST', 'Request exceeds 2 MB')
        }
        chunks.push(part.value)
      }
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'BAD_REQUEST', 'Invalid JSON')
  }
  const result = schema.safeParse(value)
  if (!result.success)
    throw new HttpError(
      400,
      'BAD_REQUEST',
      'Invalid request',
      result.error.issues.map((issue) => ({ path: issuePath(issue.path), message: issue.message })),
    )
  return result.data
}

async function uploadBody(c: ServerContext): Promise<z.output<typeof uploadSchema>> {
  const max = 2 * 1024 * 1024
  const length = Number(c.req.header('content-length') ?? 0)
  if (length > max) throw new HttpError(400, 'BAD_REQUEST', 'Upload request exceeds 2 MB')
  const reader = c.req.raw.body?.getReader()
  if (!reader) throw new HttpError(400, 'BAD_REQUEST', 'Invalid JSON')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      await reader.cancel()
      throw new HttpError(400, 'BAD_REQUEST', 'Upload request exceeds 2 MB')
    }
    chunks.push(value)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'Invalid JSON')
  }
  const parsed = uploadSchema.safeParse(value)
  if (!parsed.success) throw new HttpError(400, 'BAD_REQUEST', 'Invalid upload request')
  return parsed.data
}

function verifyOrigin(c: ServerContext): void {
  const type = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (type !== 'application/json')
    throw new HttpError(400, 'BAD_REQUEST', 'Content-Type must be application/json')
  const origin = c.req.header('origin')
  if (origin !== undefined) {
    let valid = false
    try {
      const url = new URL(origin)
      valid =
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.host.toLowerCase() === c.req.header('host')?.toLowerCase() &&
        url.origin === origin
    } catch {
      /* Invalid Origin is rejected below. */
    }
    if (!valid) throw new HttpError(403, 'FORBIDDEN', 'Origin does not match Host')
  }
}

/**
 * Paths owned by the backend: the APIs and plugin routes (`/plugins/<name>/...`). Everything else is the panel SPA,
 * including its own `/plugins` page, so deep links to panel pages work.
 */
function isBackendPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/') || path.startsWith('/plugins/')
}

export class HttpServer implements ServerService {
  private readonly app: App
  private readonly auth = new PanelAuth()
  private readonly playground: Playground
  private readonly settings: SettingsService
  private readonly groups: Groups
  private readonly http: Server
  private readonly websocket = new WebSocketServer({ noServer: true })
  private readonly clientSessions = new Map<WebSocket, string | undefined>()
  constructor(app: App) {
    this.app = app
    this.playground = new Playground(app)
    this.settings = new SettingsService(app)
    this.groups = new Groups(app)
    const routes = this.routes()
    const listener = getRequestListener(routes.fetch)
    this.http = createServer((request, response) => {
      if (unsafePluginPageUrl(request.url ?? '/')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }))
        return
      }
      listener(request, response)
    })
    if (app.config.server.panelPassword || app.setupCode) {
      app.registerUpgrade('/api/panel/ws', (request, socket, head) => {
        if (this.app.setupCode || !this.auth.authenticated(request.headers.cookie))
          return this.rejectUpgrade(socket, 401)
        this.websocket.handleUpgrade(request, socket, head, (client) =>
          this.connect(client, request.headers.cookie),
        )
      })
    }
    this.http.on('upgrade', (request, socket, head) => {
      let path: string
      try {
        path = new URL(request.url ?? '/', 'http://localhost').pathname
      } catch {
        return this.rejectUpgrade(socket, 400)
      }
      const handler = this.app.getUpgrade(path)
      if (handler) handler(request, socket, head)
      else this.rejectUpgrade(socket, 404)
    })
  }

  address(): AddressInfo | null {
    const address = this.http.address()
    return typeof address === 'object' ? address : null
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.http.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.http.off('error', onError)
        resolve()
      }
      this.http.once('error', onError)
      this.http.once('listening', onListening)
      this.http.listen(this.app.config.server.port, this.app.config.server.host)
    })
    this.app.logger.info(
      { host: this.app.config.server.host, port: this.address()?.port },
      'HTTP server listening',
    )
  }

  async stop(): Promise<void> {
    for (const client of this.websocket.clients) client.terminate()
    const closed = this.http.listening
      ? new Promise<void>((resolve, reject) => {
          this.http.closeIdleConnections()
          this.http.close((error) => (error ? reject(error) : resolve()))
        })
      : Promise.resolve()
    await closed
  }

  private rejectUpgrade(socket: Duplex, status: 400 | 401 | 404 | 503, detail?: string): void {
    const message = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 503: 'Service Unavailable' }[
      status
    ]
    const payload = JSON.stringify({
      error: {
        code: { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 404: 'NOT_FOUND', 503: 'UNAVAILABLE' }[status],
        message: detail ?? message,
      },
    })
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
    )
  }

  private routes(): Hono<Env> {
    const routes = new Hono<Env>()
    routes.onError((error, c) => {
      if (error instanceof HttpError) return failure(c, error)
      if (error instanceof PluginConfigError)
        return failure(c, new HttpError(400, 'BAD_REQUEST', 'Plugin configuration is invalid', error.issues))
      if (error instanceof SettingsValidationError)
        return failure(c, new HttpError(400, 'BAD_REQUEST', 'Configuration is invalid', error.issues))
      if (error instanceof SetupCodeError)
        return failure(c, new HttpError(401, 'UNAUTHORIZED', 'Invalid setup code'))
      if (error instanceof ManagementError)
        return failure(
          c,
          new HttpError(
            error.status,
            error.status === 409 ? 'CONFLICT' : error.status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST',
            error.message,
          ),
        )
      this.app.logger.error({ err: error, method: c.req.method, path: c.req.path }, 'HTTP request failed')
      return failure(c, new HttpError(500, 'INTERNAL_ERROR', 'Internal server error'))
    })
    routes.get('/healthz', (c) => {
      const bots = this.app.bots.list()
      return c.json({
        ok: true,
        bots: { online: bots.filter((bot) => bot.status === 'online').length, total: bots.length },
      })
    })
    if (this.app.config.server.panelPassword || this.app.setupCode) this.panelRoutes(routes)
    if (this.app.config.server.apiToken) this.publicRoutes(routes)
    const forwardPlugin = (c: ServerContext): Promise<Response> | Response => {
      const app = this.app.getPluginRoute(c.req.param('name') ?? '')
      if (!app) throw new HttpError(404, 'NOT_FOUND', 'Plugin route not found')
      const url = new URL(c.req.url)
      url.pathname = url.pathname.replace(/^\/plugins\/[^/]+/, '') || '/'
      return app.fetch(new Request(url, c.req.raw))
    }
    routes.all('/plugins/:name', forwardPlugin)
    routes.all('/plugins/:name/*', forwardPlugin)
    if (this.app.config.server.panelPassword || this.app.setupCode) {
      routes.use('/plugin-pages/*', async (_c, next) => {
        if (!this.app.config.server.panelPassword) throw new HttpError(404, 'NOT_FOUND', 'Not found')
        await next()
      })
      const page = async (c: ServerContext, next: () => Promise<void>): Promise<Response | undefined> => {
        const name = c.req.param('name') ?? ''
        if (name.startsWith('_')) {
          await next()
          return undefined
        }
        if (!isPluginPageName(name)) throw new HttpError(404, 'NOT_FOUND', 'Not found')
        const config = this.app.getPanelPage(name)
        if (!config) throw new HttpError(404, 'NOT_FOUND', 'Not found')
        const raw = (c.env.incoming.url ?? '').split('?', 1)[0] ?? ''
        const path = decodeURIComponent(raw).slice('/plugin-pages/'.length).split('/').slice(1).join('/')
        const response = await pluginPageFile(config, path)
        if (!response) throw new HttpError(404, 'NOT_FOUND', 'Not found')
        return response
      }
      routes.get('/plugin-pages/:name', page)
      routes.get('/plugin-pages/:name/*', page)
      const root = fileURLToPath(new URL('../../web/dist', import.meta.url))
      if (existsSync(root)) {
        // Built assets have content hashes in their names, so they can be cached forever. index.html must always be
        // revalidated: a stale copy would reference asset files that no longer exist after an upgrade.
        const cacheHeaders = (path: string, c: Context<Env>) => {
          c.header(
            'Cache-Control',
            /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
          )
        }
        const staticFiles = serveStatic<Env>({ root, onFound: cacheHeaders })
        const index = serveStatic<Env>({ root, path: 'index.html', onFound: cacheHeaders })
        routes.use('*', async (c, next) => {
          if (isBackendPath(c.req.path)) return next()
          return staticFiles(c, next)
        })
        routes.use('*', async (c, next) => {
          if (isBackendPath(c.req.path) || c.req.path.startsWith('/plugin-pages/')) return next()
          return index(c, next)
        })
      } else {
        routes.get('/', (c) =>
          c.html(
            '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AsaBot</title><p>面板尚未构建，请先运行 pnpm --filter web build。</p></html>',
          ),
        )
      }
    }
    routes.notFound((c) => failure(c, new HttpError(404, 'NOT_FOUND', 'Not found')))
    return routes
  }

  private panelRoutes(routes: Hono<Env>): void {
    const panel = new Hono<Env>()
    panel.use('*', async (c, next) => {
      if (c.req.path.startsWith('/api/panel/ext/') && !this.app.config.server.panelPassword)
        throw new HttpError(404, 'NOT_FOUND', 'Not found')
      if (this.app.setupCode && c.req.path !== '/api/panel/session' && c.req.path !== '/api/panel/setup')
        throw new HttpError(401, 'UNAUTHORIZED', 'Setup required')
      if (
        c.req.path !== '/api/panel/login' &&
        c.req.path !== '/api/panel/session' &&
        c.req.path !== '/api/panel/setup' &&
        !this.auth.authenticated(c.req.header('cookie'))
      )
        throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required')
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) verifyOrigin(c)
      await next()
    })
    panel.post('/setup', async (c) => {
      const setupCode = this.app.setupCode
      if (!setupCode) throw new HttpError(404, 'NOT_FOUND', 'Not found')
      if (!this.auth.attempt(c.env.incoming.socket.remoteAddress ?? 'unknown'))
        throw new HttpError(429, 'RATE_LIMITED', 'Too many login attempts')
      const input = await body(c, setupInput)
      if (!constantTimeEqual(input.code, setupCode))
        throw new HttpError(401, 'UNAUTHORIZED', 'Invalid setup code')
      await this.settings.setup(input)
      this.setSessionCookie(c)
      return c.json({ ok: true })
    })
    panel.post('/login', async (c) => {
      if (!this.auth.attempt(c.env.incoming.socket.remoteAddress ?? 'unknown'))
        throw new HttpError(429, 'RATE_LIMITED', 'Too many login attempts')
      const input = await body(c, z.object({ password: z.string() }))
      if (!constantTimeEqual(input.password, this.app.config.server.panelPassword))
        throw new HttpError(401, 'UNAUTHORIZED', 'Invalid password')
      this.setSessionCookie(c)
      return c.json({ ok: true })
    })
    panel.post('/logout', (c) => {
      this.auth.remove(c.req.header('cookie'))
      for (const [client, cookie] of this.clientSessions) {
        if (!this.auth.authenticated(cookie)) client.close(1008, 'Session expired')
      }
      deleteCookie(c, 'asabot_session', { httpOnly: true, sameSite: 'Strict', path: '/' })
      return c.json({ ok: true })
    })
    panel.get('/session', (c) =>
      this.app.setupCode
        ? c.json({ authenticated: false, setup: true })
        : c.json({ authenticated: this.auth.authenticated(c.req.header('cookie')) }),
    )
    panel.get('/settings', async (c) => c.json(await this.settings.get()))
    panel.put('/settings', async (c) => c.json(await this.settings.update(await body(c, settingsInput))))
    panel.get('/overview', (c) => c.json(overview(this.app)))
    const requireTask = (id: string) => {
      const task = this.app.tasks.get(id)
      if (!task) throw new HttpError(404, 'NOT_FOUND', '任务不存在或历史已清理')
      return task
    }
    panel.get('/tasks', (c) => {
      const input = z
        .object({
          plugin: z.string().max(200).optional(),
          name: z.string().max(200).optional(),
          state: z.enum(taskStates).optional(),
          q: z.string().max(200).optional(),
          offset: z.coerce.number().int().nonnegative().default(0),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .strict()
        .safeParse(c.req.query())
      if (!input.success) throw new HttpError(400, 'BAD_REQUEST', '无效的任务筛选条件')
      return c.json(redactValue(this.app.tasks.query(input.data), this.app.config))
    })
    panel.get('/tasks/:id', (c) => c.json(redactValue(requireTask(c.req.param('id')), this.app.config)))
    panel.get('/tasks/:id/attempts', (c) => {
      requireTask(c.req.param('id'))
      return c.json(redactValue(this.app.tasks.attempts(c.req.param('id')), this.app.config))
    })
    panel.post('/tasks/:id/cancel', (c) => {
      const id = requireTask(c.req.param('id')).id
      if (!this.app.tasks.cancel(id)) throw new HttpError(409, 'CONFLICT', '任务已结束或正在取消')
      return c.json(redactValue(this.app.tasks.get(id), this.app.config))
    })
    panel.post('/tasks/:id/retry', (c) => {
      const id = requireTask(c.req.param('id')).id
      try {
        return c.json(redactValue(this.app.tasks.retry(id), this.app.config))
      } catch (error) {
        if (error instanceof TaskConflictError) throw new HttpError(409, 'CONFLICT', error.message)
        throw error
      }
    })
    panel.get('/stats/messages', (c) => {
      const range = c.req.query('range') ?? '1h'
      if (range !== '1h' && range !== '24h') throw new HttpError(400, 'BAD_REQUEST', 'Invalid range')
      return c.json(this.app.stats.range(range))
    })
    const forwardPanelPlugin = (c: ServerContext): Promise<Response> | Response => {
      const app = this.app.getPanelRoute(c.req.param('name') ?? '')
      if (!app) throw new HttpError(404, 'NOT_FOUND', 'Plugin route not found')
      const url = new URL(c.req.url)
      url.pathname = url.pathname.replace(/^\/api\/panel\/ext\/[^/]+/, '') || '/'
      return app.fetch(new Request(url, c.req.raw))
    }
    panel.all('/ext/:name', forwardPanelPlugin)
    panel.all('/ext/:name/*', forwardPanelPlugin)
    panel.get('/bots', (c) => c.json(this.app.bots.list().map((bot) => botView(this.app, bot))))
    panel.get('/groups', async (c) => c.json(await this.groups.list(c.req.query('refresh') === '1')))
    panel.get('/groups/:groupKey', async (c) => {
      const groupKey = c.req.param('groupKey')
      const group = (await this.groups.list()).find((item) => item.groupKey === groupKey)
      if (!group) throw new HttpError(404, 'NOT_FOUND', 'Group not found')
      return c.json({
        group,
        plugins: this.app.plugins.list().map((plugin) => {
          const override = this.app.storage.getGroupConfig(plugin.name, groupKey)
          return {
            name: plugin.name,
            enabled: this.app.storage.isGroupEnabled(plugin.name, groupKey),
            configurable: plugin.configSchema !== undefined,
            ...(override === undefined ? {} : { override }),
          }
        }),
        commands: this.app.dispatcher.registeredCommands().map((command) => ({
          path: command.path.join(' '),
          owner: command.owner,
          enabled: this.app.storage.isCommandGroupEnabled(command.path.join(' '), groupKey),
        })),
      })
    })
    panel.get('/bots/:platform/:selfId/groups', async (c) => {
      const bot = this.app.getBot(c.req.param('platform'), c.req.param('selfId'))
      if (!bot) throw new HttpError(404, 'NOT_FOUND', 'Bot not found')
      const groups = await bot.getGroupList()
      return c.json(
        groups.map(({ groupId, groupName, memberCount }) => ({
          groupId,
          groupName,
          ...(memberCount === undefined ? {} : { memberCount }),
        })),
      )
    })
    panel.post('/send', async (c) => c.json(await this.send(await body(c, sendSchema))))
    panel.get('/plugins', (c) =>
      c.json(this.app.plugins.list().map((plugin) => pluginView(this.app, plugin))),
    )
    panel.post('/plugins/rescan', async (c) => {
      const result = await this.app.plugins.rescan()
      return c.json({
        ...result,
        plugins: this.app.plugins.list().map((plugin) => pluginView(this.app, plugin)),
      })
    })
    panel.post('/plugins/upload', async (c) => {
      const input = await uploadBody(c)
      const state = await this.app.plugins.upload(input.filename, input.content, input.overwrite)
      return c.json(pluginView(this.app, state), 201)
    })
    panel.post('/plugins/:name/uninstall', async (c) => {
      const name = c.req.param('name')
      this.requirePlugin(name)
      const input = await body(c, purgeSchema)
      await this.app.plugins.uninstall(name, input.purge)
      return c.json({ ok: true })
    })
    panel.get('/packages/search', async (c) => {
      const from = Number(c.req.query('from') ?? 0)
      if (!Number.isSafeInteger(from) || from < 0)
        throw new HttpError(400, 'BAD_REQUEST', 'Invalid search offset')
      const sort = c.req.query('sort') ?? 'relevance'
      if (sort !== 'relevance' && sort !== 'updated' && sort !== 'name')
        throw new HttpError(400, 'BAD_REQUEST', 'Invalid search sort')
      return c.json(await this.app.plugins.packages.search(c.req.query('q') ?? '', from, sort))
    })
    panel.get('/packages/info', async (c) =>
      c.json(await this.app.plugins.packages.marketInfo(c.req.query('name') ?? '')),
    )
    panel.post('/packages/install', async (c) => {
      const input = await body(c, packageInstallSchema)
      return c.json(
        this.packageOperation(
          await this.app.plugins.packages.install(input.name, input.version, input.force),
        ),
        202,
      )
    })
    panel.post('/packages/update', async (c) => {
      const input = await body(c, packageNameSchema)
      return c.json(this.packageOperation(await this.app.plugins.packages.update(input.name)), 202)
    })
    panel.post('/packages/uninstall', async (c) => {
      const input = await body(c, packageUninstallSchema)
      return c.json(this.packageOperation(this.app.plugins.packages.uninstall(input.name, input.purge)), 202)
    })
    panel.get('/packages/operations', (c) =>
      c.json(this.app.plugins.packages.list().map((op) => this.packageOperation(op))),
    )
    panel.post('/plugins/:name/:operation', async (c) => {
      const name = c.req.param('name')
      const operation = c.req.param('operation')
      if (!['enable', 'disable', 'reload'].includes(operation))
        throw new HttpError(404, 'NOT_FOUND', 'Not found')
      this.requirePlugin(name)
      if (name === 'admin' && operation === 'disable')
        throw new HttpError(409, 'CONFLICT', 'admin cannot be disabled')
      try {
        if (operation === 'enable') await this.app.plugins.enable(name)
        else if (operation === 'disable') await this.app.plugins.disable(name)
        else await this.app.plugins.reload(name)
      } catch (error) {
        let reason = error instanceof Error ? error.message : 'Plugin operation failed'
        for (const secret of configSecrets(this.app.config)) {
          if (secret) reason = reason.replaceAll(secret, '[Redacted]')
        }
        throw new HttpError(409, 'CONFLICT', reason)
      }
      const state = this.requirePlugin(name)
      if (state.state === 'failed')
        throw new HttpError(409, 'CONFLICT', state.error ?? 'Plugin operation failed')
      return c.json(pluginView(this.app, state))
    })
    panel.put('/plugins/:name/config', async (c) => {
      const name = c.req.param('name')
      this.requirePlugin(name)
      const input = await body(
        c,
        z.object({ config: z.unknown() }).refine((value) => Object.hasOwn(value, 'config'), {
          message: 'config is required',
          path: ['config'],
        }),
      )
      await this.app.plugins.updateConfig(name, input.config)
      const state = this.requirePlugin(name)
      if (state.state === 'failed')
        throw new HttpError(409, 'CONFLICT', state.error ?? 'Plugin reload failed')
      return c.json(pluginView(this.app, state))
    })
    panel.get('/plugins/:name/groups', (c) => {
      this.requirePlugin(c.req.param('name'))
      return c.json(this.app.storage.listGroups(c.req.param('name')))
    })
    panel.put('/plugins/:name/groups/:groupKey', async (c) => {
      const name = c.req.param('name')
      this.requirePlugin(name)
      const input = await body(
        c,
        z
          .object({
            enabled: z.boolean().optional(),
            config: z.record(z.string(), z.unknown()).nullable().optional(),
          })
          .strict()
          .refine(
            (value) => value.enabled !== undefined || value.config !== undefined,
            'enabled or config is required',
          ),
      )
      const groupKey = c.req.param('groupKey')
      if (!/^[^:\s]+:[^\s]+$/.test(groupKey))
        throw new HttpError(400, 'BAD_REQUEST', 'Expected groupKey in platform:id format')
      if (input.config !== undefined) this.app.plugins.setGroupConfig(name, groupKey, input.config)
      if (input.enabled !== undefined) this.app.plugins.setGroupEnabled(name, groupKey, input.enabled)
      return c.json({ ok: true })
    })
    panel.get('/commands', (c) =>
      c.json(this.app.dispatcher.registeredCommands().map((command) => commandView(this.app, command))),
    )
    panel.put('/commands/override', async (c) => {
      const input = await body(
        c,
        z.object({ path: z.string().min(1), override: commandOverrideSchema.nullable() }).strict(),
      )
      return this.app.plugins.serial(async () => {
        const command = this.app.dispatcher
          .registeredCommands()
          .find((item) => item.path.join(' ') === input.path)
        if (!command) throw new HttpError(404, 'NOT_FOUND', 'Command not found')
        if (this.app.configPath) {
          const key = ['command', 'overrides', input.path]
          if (input.override === null) await deleteConfigValue(this.app.configPath, key)
          else
            await writeConfigValue(this.app.configPath, key, input.override, {
              previousValue: this.app.config.command.overrides[input.path],
            })
        } else this.app.logger.debug({ command: input.path }, 'Command override changed in memory')
        if (input.override === null) delete this.app.config.command.overrides[input.path]
        else this.app.config.command.overrides[input.path] = input.override
        return c.json(commandView(this.app, command))
      })
    })
    panel.put('/commands/groups', async (c) => {
      const input = await body(
        c,
        z
          .object({
            path: z.string().min(1),
            groupKey: z.string().regex(/^[^:\s]+:[^\s]+$/),
            enabled: z.boolean(),
          })
          .strict(),
      )
      const command = this.app.dispatcher
        .registeredCommands()
        .find((item) => item.path.join(' ') === input.path)
      if (!command) throw new HttpError(404, 'NOT_FOUND', 'Command not found')
      this.app.storage.setCommandGroupEnabled(input.path, input.groupKey, input.enabled)
      return c.json({ ok: true })
    })
    panel.get('/acl', (c) => c.json(this.app.storage.access.list()))
    panel.on(['POST', 'DELETE'], '/acl', async (c) => {
      const entry = await body(c, accessSchema)
      if (c.req.method === 'POST') {
        if (
          entry.list === 'block' &&
          entry.subject === 'user' &&
          this.app.isSuperuser(entry.key.slice(entry.key.indexOf(':') + 1))
        )
          throw new HttpError(409, 'CONFLICT', 'Cannot block a superuser')
        this.app.storage.access.add(entry.list, entry.subject, entry.key)
      } else this.app.storage.access.remove(entry.list, entry.subject, entry.key)
      return c.json({ ok: true })
    })
    panel.get('/logs', (c) => {
      const limit = Number(c.req.query('limit') ?? 200)
      const level = Number(c.req.query('level') ?? 30)
      const eventId = c.req.query('eventId')
      if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isFinite(level))
        throw new HttpError(400, 'BAD_REQUEST', 'Invalid log filter')
      const records = getRecentLogs().filter(
        (record) =>
          typeof record.level === 'number' &&
          record.level >= level &&
          (eventId === undefined || record.eventId === eventId),
      )
      return c.json(limit === 0 ? [] : records.slice(-limit))
    })
    panel.get('/logs/level', (c) => c.json({ level: this.app.logger.level }))
    panel.put('/logs/level', async (c) => {
      const input = await body(c, z.object({ level: logLevelSchema }).strict())
      this.app.logger.level = input.level
      return c.json({ level: this.app.logger.level })
    })
    panel.post('/playground', async (c) =>
      c.json(await this.playground.run(await body(c, playgroundSchema, 2 * 1024 * 1024))),
    )
    panel.post('/playground/event', async (c) =>
      c.json(await this.playground.event(await body(c, playgroundEventSchema, 2 * 1024 * 1024))),
    )
    panel.get('/ws', () => {
      throw new HttpError(400, 'BAD_REQUEST', 'WebSocket upgrade required')
    })
    routes.route('/api/panel', panel)
  }

  private publicRoutes(routes: Hono<Env>): void {
    const api = new Hono<Env>()
    api.use('*', async (c, next) => {
      if (this.app.setupCode) throw new HttpError(401, 'UNAUTHORIZED', 'Setup required')
      const authorization = c.req.header('authorization') ?? ''
      const match = /^Bearer (.+)$/.exec(authorization)
      if (!match || !constantTimeEqual(match[1] ?? '', this.app.config.server.apiToken))
        throw new HttpError(401, 'UNAUTHORIZED', 'Invalid API token')
      await next()
    })
    api.get('/bots', (c) => c.json(this.app.bots.list().map((bot) => botView(this.app, bot))))
    api.post('/send', async (c) => c.json(await this.send(await body(c, sendSchema))))
    routes.route('/api/v1', api)
  }

  private requirePlugin(name: string) {
    const plugin = this.app.plugins.get(name)
    if (!plugin) throw new HttpError(404, 'NOT_FOUND', 'Plugin not found')
    return plugin
  }

  private setSessionCookie(c: ServerContext): void {
    setCookie(c, 'asabot_session', this.auth.create(), {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    })
  }

  private packageOperation(operation: PackageOperation) {
    return { ...operation, ...(operation.plugin ? { plugin: pluginView(this.app, operation.plugin) } : {}) }
  }

  private async send(input: z.output<typeof sendSchema>) {
    try {
      return await this.app.send(input.target, input.message)
    } catch (error) {
      if (error instanceof NoBotOnlineError) throw new HttpError(409, 'CONFLICT', 'No matching online bot')
      throw error
    }
  }

  private connect(client: WebSocket, cookie: string | undefined): void {
    this.clientSessions.set(client, cookie)
    const push = (frame: unknown): void => {
      if (client.readyState !== WebSocket.OPEN) return
      if (!this.auth.authenticated(cookie)) {
        client.close(1008, 'Session expired')
        return
      }
      try {
        client.send(JSON.stringify(frame))
      } catch (error) {
        client.terminate()
        this.app.logger.warn({ err: error }, 'Panel WebSocket send failed')
      }
    }
    push({ type: 'hello', overview: overview(this.app) })
    const unsubscribeLogs = subscribeLogs((record) => push({ type: 'log', record }))
    const unsubscribePackages = this.app.plugins.packages.subscribe((operation) =>
      push({ type: 'package', operation: this.packageOperation(operation) }),
    )
    const unsubscribePackageUpdates = this.app.plugins.subscribePackageUpdates((plugin) =>
      push({ type: 'plugin', plugin: pluginView(this.app, plugin) }),
    )
    const unsubscribeEvents = this.app.subscribeDispatch((event) => {
      const frame = this.eventFrame(event)
      if (frame) push(frame)
    })
    const unsubscribePanelEvents = this.app.subscribePanelEvents((event) =>
      push({ type: 'plugin-event', ...event }),
    )
    const unsubscribeTasks = this.app.tasks.subscribe((id) => push({ type: 'task', id }))
    const ping = setInterval(() => {
      if (client.readyState !== WebSocket.OPEN) return
      if (this.auth.authenticated(cookie)) client.ping()
      else client.close(1008, 'Session expired')
    }, 30_000)
    let stats: NodeJS.Timeout
    const scheduleStats = (): void => {
      const now = Date.now()
      stats = setTimeout(
        () => {
          const t = Math.floor(Date.now() / 60_000) * 60_000 - 60_000
          push({ type: 'stats', point: this.app.stats.point(t) })
          scheduleStats()
        },
        60_000 - (now % 60_000),
      )
    }
    scheduleStats()
    client.on('error', (error) => {
      client.terminate()
      this.app.logger.warn({ err: error }, 'Panel WebSocket failed')
    })
    client.once('close', () => {
      this.clientSessions.delete(client)
      clearInterval(ping)
      clearTimeout(stats)
      unsubscribeLogs()
      unsubscribePackages()
      unsubscribePackageUpdates()
      unsubscribeEvents()
      unsubscribePanelEvents()
      unsubscribeTasks()
    })
  }

  private eventFrame(event: DispatchEvent): unknown {
    if (event.name === 'plugin.state' && 'plugin' in event)
      return { type: 'plugin', plugin: pluginView(this.app, event.plugin) }
    if (
      event.kind === 'internal' &&
      (event.name === 'bot.online' || event.name === 'bot.offline') &&
      event.bot
    )
      return { type: 'bot', bot: botView(this.app, event.bot as Bot) }
    if (event.kind === 'message')
      return {
        type: 'message',
        direction: 'in',
        platform: event.platform,
        selfId: event.selfId,
        channel: { type: event.messageType, id: event.groupId ?? event.userId },
        userId: event.userId,
        nickname: event.sender.nickname,
        avatar: supports(event.bot, 'getAvatarUrl') ? event.bot.getAvatarUrl?.(event.userId) : undefined,
        preview: [...event.text].slice(0, 120).join(''),
        time: event.time,
      }
    if (event.kind === 'internal' && event.name === 'bot.message.sent' && 'message' in event) {
      const sent = event as MessageSentEvent
      return {
        type: 'message',
        direction: 'out',
        platform: sent.platform,
        selfId: sent.selfId,
        channel: { type: sent.messageType, id: sent.groupId ?? sent.userId },
        ...(sent.userId === undefined ? {} : { userId: sent.userId }),
        avatar: supports(sent.bot, 'getAvatarUrl') ? sent.bot.getAvatarUrl?.(sent.selfId) : undefined,
        preview: [...plainText(sent.message)].slice(0, 120).join(''),
        time: sent.time,
      }
    }
    return undefined
  }
}
