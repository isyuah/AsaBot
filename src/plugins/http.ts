import { createRequire } from 'node:module'
import { ProxyAgent } from 'undici'
import { z } from 'zod'
import { durationSchema } from '../core/config/schema.ts'
import { definePlugin } from '../core/plugin/definition.ts'
import { type Duration, parseDuration } from '../core/utils/duration.ts'

/** HTTP 请求选项，可指定超时、代理和响应体字节数上限。 */
export type HttpInit = RequestInit & {
  timeout?: Duration | string
  proxy?: boolean | string
  maxSize?: number
}

/** 提供带超时、代理和大小限制的 HTTP 请求服务。 */
export interface HttpService {
  fetch(url: string | URL, init?: HttpInit): Promise<Response>
  json<T = unknown>(url: string | URL, init?: HttpInit): Promise<T>
  text(url: string | URL, init?: HttpInit): Promise<string>
  buffer(url: string | URL, init?: HttpInit): Promise<Buffer>
}

declare module '@asabot/core' {
  interface Services {
    http: HttpService
  }
}

/** HTTP 响应不是 2xx 时抛出的错误；url 不包含查询参数。 */
export class HttpError extends Error {
  readonly status: number
  readonly url: string

  constructor(status: number, url: string | URL) {
    const parsed = new URL(url)
    const safeUrl = `${parsed.origin}${parsed.pathname}`
    super(`HTTP ${status}: ${safeUrl}`)
    this.name = 'HttpError'
    this.status = status
    this.url = safeUrl
  }
}

const version = (createRequire(import.meta.url)('../../package.json') as { version: string }).version
const defaultMaxSize = 10 * 1024 * 1024

function bypassProxy(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase()
  return patterns.some((entry) => {
    const pattern = entry.toLowerCase()
    return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern
  })
}

export default definePlugin({
  name: 'http',
  description: 'HTTP 请求、代理和响应大小限制',
  config: z.object({
    proxy: z.string().default(''),
    noProxy: z.array(z.string()).default([]),
    timeout: durationSchema.default(30_000),
    userAgent: z.string().default(''),
  }),
  setup(ctx) {
    const agents = new Map<string, ProxyAgent>()
    ctx.onDispose(async () => {
      await Promise.all([...agents.values()].map((agent) => agent.close()))
    })

    const request: HttpService['fetch'] = async (url, init = {}) => {
      const { timeout = ctx.config.timeout, proxy, maxSize = defaultMaxSize, signal, ...options } = init
      if (!Number.isSafeInteger(maxSize) || maxSize < 0) throw new TypeError('Invalid maxSize')
      const destination = new URL(url)
      const proxyUrl =
        proxy === false || bypassProxy(destination.hostname, ctx.config.noProxy)
          ? ''
          : typeof proxy === 'string'
            ? proxy
            : ctx.config.proxy
      let dispatcher: ProxyAgent | undefined
      if (proxyUrl) {
        dispatcher = agents.get(proxyUrl)
        if (!dispatcher) {
          dispatcher = new ProxyAgent(proxyUrl)
          agents.set(proxyUrl, dispatcher)
        }
      }
      const headers = new Headers(options.headers)
      if (!headers.has('user-agent')) headers.set('user-agent', ctx.config.userAgent || `AsaBot/${version}`)
      const controller = new AbortController()
      const signals = [ctx.signal, controller.signal, AbortSignal.timeout(parseDuration(timeout))]
      if (signal) signals.push(signal)
      const response = await fetch(destination, {
        ...options,
        headers,
        signal: AbortSignal.any(signals),
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit)
      if (!response.body) return response
      const reader = response.body.getReader()
      let size = 0
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const part = await reader.read()
            if (part.done) {
              stream.close()
              return
            }
            size += part.value.byteLength
            if (size > maxSize) {
              const error = new Error(`HTTP response exceeds maxSize (${maxSize} bytes)`)
              controller.abort(error)
              stream.error(error)
              return
            }
            stream.enqueue(part.value)
          } catch (error) {
            stream.error(error)
          }
        },
        cancel(reason) {
          return reader.cancel(reason)
        },
      })
      const limited = new Response(body, response)
      Object.defineProperties(limited, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
      })
      return limited
    }
    const checked = async (url: string | URL, init?: HttpInit): Promise<Response> => {
      const response = await request(url, init)
      if (!response.ok) {
        await response.body?.cancel()
        throw new HttpError(response.status, response.url || url)
      }
      return response
    }
    ctx.provide('http', {
      fetch: request,
      async json<T>(url: string | URL, init?: HttpInit): Promise<T> {
        return (await (await checked(url, init)).json()) as T
      },
      async text(url, init) {
        return (await checked(url, init)).text()
      },
      async buffer(url, init) {
        return Buffer.from(await (await checked(url, init)).arrayBuffer())
      },
    })
  },
})
