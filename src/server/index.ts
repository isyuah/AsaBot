import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
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
import type { Bot } from '../core/bot.ts'
import type { DispatchEvent } from '../core/dispatch/types.ts'
import { PluginConfigError } from '../core/errors.ts'
import type { MessageSentEvent } from '../core/event/index.ts'
import { getRecentLogs, subscribeLogs } from '../core/logger.ts'
import { plainText } from '../core/message/index.ts'
import { constantTimeEqual, PanelAuth } from './auth.ts'
import { Playground } from './playground.ts'
import { accessSchema, playgroundSchema, sendSchema } from './schemas.ts'
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

async function body<T extends z.ZodType>(c: ServerContext, schema: T): Promise<z.output<T>> {
  let value: unknown
  try {
    value = await c.req.json()
  } catch {
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
  private readonly http: Server
  private readonly websocket = new WebSocketServer({ noServer: true })
  private readonly clientSessions = new Map<WebSocket, string | undefined>()
  private readonly upgradeHandlers = new Map<
    string,
    (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  >()

  constructor(app: App) {
    this.app = app
    this.playground = new Playground(app)
    const routes = this.routes()
    this.http = createServer(getRequestListener(routes.fetch))
    if (app.config.server.panelPassword) {
      this.registerUpgrade('/api/panel/ws', (request, socket, head) => {
        if (!this.auth.authenticated(request.headers.cookie)) return this.rejectUpgrade(socket, 401)
        this.websocket.handleUpgrade(request, socket, head, (client) =>
          this.connect(client, request.headers.cookie),
        )
      })
    }
    // M5 can register /onebot/v11/ws in the same upgrade dispatch table.
    this.http.on('upgrade', (request, socket, head) => {
      let path: string
      try {
        path = new URL(request.url ?? '/', 'http://localhost').pathname
      } catch {
        return this.rejectUpgrade(socket, 400)
      }
      const handler = this.upgradeHandlers.get(path)
      if (handler) handler(request, socket, head)
      else this.rejectUpgrade(socket, 404)
    })
  }

  address(): AddressInfo | null {
    const address = this.http.address()
    return typeof address === 'object' ? address : null
  }

  registerUpgrade(
    path: string,
    handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): void {
    if (this.upgradeHandlers.has(path)) throw new Error(`WebSocket upgrade path already registered: ${path}`)
    this.upgradeHandlers.set(path, handler)
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
    if (!this.http.listening) return
    this.http.closeIdleConnections()
    await new Promise<void>((resolve, reject) =>
      this.http.close((error) => (error ? reject(error) : resolve())),
    )
  }

  private rejectUpgrade(socket: Duplex, status: 400 | 401 | 404): void {
    const message = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found' }[status]
    const payload = JSON.stringify({
      error: { code: { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 404: 'NOT_FOUND' }[status], message },
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
      this.app.logger.error('HTTP request failed')
      return failure(c, new HttpError(500, 'INTERNAL_ERROR', 'Internal server error'))
    })
    if (this.app.config.server.panelPassword) this.panelRoutes(routes)
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
    if (this.app.config.server.panelPassword) {
      const root = fileURLToPath(new URL('../../web/dist', import.meta.url))
      if (existsSync(root)) {
        const staticFiles = serveStatic<Env>({ root })
        const index = serveStatic<Env>({ root, path: 'index.html' })
        routes.use('*', async (c, next) => {
          if (isBackendPath(c.req.path)) return next()
          return staticFiles(c, next)
        })
        routes.use('*', async (c, next) => {
          if (isBackendPath(c.req.path)) return next()
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
      if (
        c.req.path !== '/api/panel/login' &&
        c.req.path !== '/api/panel/session' &&
        !this.auth.authenticated(c.req.header('cookie'))
      )
        throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required')
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) verifyOrigin(c)
      await next()
    })
    panel.post('/login', async (c) => {
      if (!this.auth.attempt(c.env.incoming.socket.remoteAddress ?? 'unknown'))
        throw new HttpError(429, 'RATE_LIMITED', 'Too many login attempts')
      const input = await body(c, z.object({ password: z.string() }))
      if (!constantTimeEqual(input.password, this.app.config.server.panelPassword))
        throw new HttpError(401, 'UNAUTHORIZED', 'Invalid password')
      const token = this.auth.create()
      setCookie(c, 'asabot_session', token, {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
        maxAge: 7 * 24 * 60 * 60,
      })
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
    panel.get('/session', (c) => c.json({ authenticated: this.auth.authenticated(c.req.header('cookie')) }))
    panel.get('/overview', (c) => c.json(overview(this.app)))
    panel.get('/stats/messages', (c) => {
      const range = c.req.query('range') ?? '1h'
      if (range !== '1h' && range !== '24h') throw new HttpError(400, 'BAD_REQUEST', 'Invalid range')
      return c.json(this.app.stats.range(range))
    })
    panel.get('/bots', (c) => c.json(this.app.bots.list().map((bot) => botView(this.app, bot))))
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
        for (const secret of [
          this.app.config.server.panelPassword,
          this.app.config.server.apiToken,
          ...this.app.config.onebot11.connections.map((connection) => connection.accessToken ?? ''),
        ]) {
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
      const input = await body(c, z.object({ enabled: z.boolean() }))
      const groupKey = c.req.param('groupKey')
      if (!/^[^:\s]+:[^\s]+$/.test(groupKey))
        throw new HttpError(400, 'BAD_REQUEST', 'Expected groupKey in platform:id format')
      this.app.plugins.setGroupEnabled(name, groupKey, input.enabled)
      return c.json({ ok: true })
    })
    panel.get('/commands', (c) =>
      c.json(this.app.dispatcher.registeredCommands().map((command) => commandView(this.app, command))),
    )
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
      if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isFinite(level))
        throw new HttpError(400, 'BAD_REQUEST', 'Invalid log filter')
      const records = getRecentLogs().filter(
        (record) => typeof record.level === 'number' && record.level >= level,
      )
      return c.json(limit === 0 ? [] : records.slice(-limit))
    })
    panel.post('/playground', async (c) => c.json(await this.playground.run(await body(c, playgroundSchema))))
    panel.get('/ws', () => {
      throw new HttpError(400, 'BAD_REQUEST', 'WebSocket upgrade required')
    })
    routes.route('/api/panel', panel)
  }

  private publicRoutes(routes: Hono<Env>): void {
    const api = new Hono<Env>()
    api.use('*', async (c, next) => {
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

  private async send(input: z.output<typeof sendSchema>) {
    const bot = this.app.bots
      .list()
      .find(
        (item) =>
          item.status === 'online' &&
          (input.platform === undefined || input.platform === item.platform) &&
          (input.selfId === undefined || input.selfId === item.selfId),
      )
    if (!bot) throw new HttpError(409, 'CONFLICT', 'No matching online bot')
    return input.target.type === 'group'
      ? bot.sendGroup(input.target.id, input.message)
      : bot.sendPrivate(input.target.id, input.message)
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
      } catch {
        client.terminate()
      }
    }
    push({ type: 'hello', overview: overview(this.app) })
    const unsubscribeLogs = subscribeLogs((record) => push({ type: 'log', record }))
    const unsubscribeEvents = this.app.subscribeDispatch((event) => {
      const frame = this.eventFrame(event)
      if (frame) push(frame)
    })
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
    client.on('error', () => client.terminate())
    client.once('close', () => {
      this.clientSessions.delete(client)
      clearInterval(ping)
      clearTimeout(stats)
      unsubscribeLogs()
      unsubscribeEvents()
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
        preview: [...plainText(sent.message)].slice(0, 120).join(''),
        time: sent.time,
      }
    }
    return undefined
  }
}
