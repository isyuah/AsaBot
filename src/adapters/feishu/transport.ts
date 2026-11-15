import {
  Client,
  Domain,
  defaultHttpInstance,
  EventDispatcher,
  type HttpInstance,
  type HttpRequestOptions,
  LoggerLevel,
  type Logger as SDKLogger,
  WSClient,
} from '@larksuiteoapi/node-sdk'
import type { Logger } from 'pino'
import { redactText } from '../../core/utils/redact.ts'
import type { FeishuAccountConfig, FeishuConfig } from './config.ts'

export type FeishuEventHandlers = Record<string, (event: unknown) => Promise<unknown>>
export interface FeishuLifecycle {
  ready(): void
  reconnecting(): void
  error(error: unknown): void
}
export interface FeishuRequest {
  data?: Record<string, unknown>
  params?: Record<string, string | number>
}
/** Injectable SDK boundary; protocol payloads are validated by the adapter. */
export interface FeishuTransport {
  request(method: string, path: string, input?: FeishuRequest): Promise<unknown>
  upload(type: 'image' | 'file', content: Buffer, name: string): Promise<unknown>
  download(messageId: string, key: string, type: 'image' | 'file'): Promise<Buffer>
  start(handlers: FeishuEventHandlers): Promise<void>
  close(): void
}

export class SDKTransport implements FeishuTransport {
  private readonly client: Client
  private readonly ws: WSClient
  private readonly config: FeishuConfig
  private readonly sdkLogger: SDKLogger
  private readonly controller = new AbortController()

  constructor(
    account: FeishuAccountConfig,
    config: FeishuConfig,
    lifecycle: FeishuLifecycle,
    logger: Logger,
  ) {
    this.config = config
    const report = (...items: unknown[]) =>
      logger.warn(
        {
          platform: 'feishu',
          appId: account.appId,
          reason: redactText(
            items
              .map((item) =>
                item instanceof Error ? item.message : typeof item === 'string' ? item : '[SDK detail]',
              )
              .join(' '),
            account,
          ),
        },
        'Feishu SDK',
      )
    const sdkLogger = { error: report, warn: report, info() {}, debug() {}, trace() {} }
    this.sdkLogger = sdkLogger
    const signal = this.controller.signal
    // The SDK HTTP boundary returns decoded bodies; callers validate their API envelopes.
    function request<T = unknown, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R>
    function request(options: HttpRequestOptions<unknown>): Promise<unknown> {
      return defaultHttpInstance.request({
        ...options,
        timeout: config.apiTimeout,
        signal,
        maxContentLength: config.mediaMaxBytes,
        maxBodyLength: config.mediaMaxBytes + 65536,
      })
    }
    const http: HttpInstance = {
      request,
      get: (url, options) => request({ ...options, url, method: 'GET' }),
      delete: (url, options) => request({ ...options, url, method: 'DELETE' }),
      head: (url, options) => request({ ...options, url, method: 'HEAD' }),
      options: (url, options) => request({ ...options, url, method: 'OPTIONS' }),
      post: (url, data, options) => request({ ...options, url, data, method: 'POST' }),
      put: (url, data, options) => request({ ...options, url, data, method: 'PUT' }),
      patch: (url, data, options) => request({ ...options, url, data, method: 'PATCH' }),
    }
    const base = {
      ...account,
      domain: Domain.Feishu,
      logger: sdkLogger,
      loggerLevel: LoggerLevel.warn,
      httpInstance: http,
    }
    this.client = new Client(base)
    this.ws = new WSClient({
      ...base,
      handshakeTimeoutMs: config.apiTimeout,
      onReady: lifecycle.ready,
      onReconnected: lifecycle.ready,
      onReconnecting: lifecycle.reconnecting,
      onError: lifecycle.error,
    })
  }

  request(method: string, path: string, input: FeishuRequest = {}): Promise<unknown> {
    return this.client.request<unknown>({ method, url: `https://open.feishu.cn/open-apis${path}`, ...input })
  }

  upload(type: 'image' | 'file', content: Buffer, name: string): Promise<unknown> {
    return type === 'image'
      ? this.client.im.image.create({ data: { image_type: 'message', image: content } })
      : this.client.im.file.create({ data: { file_type: 'stream', file_name: name, file: content } })
  }

  async download(messageId: string, key: string, type: 'image' | 'file'): Promise<Buffer> {
    const result = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: key },
      params: { type },
    })
    const stream = result.getReadableStream()
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.config.apiTimeout)])
    const abort = () => stream.destroy(new Error('Resource download aborted'))
    signal.addEventListener('abort', abort, { once: true })
    const chunks: Buffer[] = []
    let size = 0
    try {
      signal.throwIfAborted()
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > this.config.mediaMaxBytes) throw new Error('Resource exceeds mediaMaxBytes')
        chunks.push(bytes)
      }
      return Buffer.concat(chunks)
    } finally {
      signal.removeEventListener('abort', abort)
      stream.destroy()
    }
  }

  async start(handlers: FeishuEventHandlers): Promise<void> {
    await this.ws.start({
      eventDispatcher: new EventDispatcher({
        logger: this.sdkLogger,
        loggerLevel: LoggerLevel.error,
      }).register(handlers),
    })
  }

  close(): void {
    this.controller.abort()
    this.ws.close({ force: true })
  }
}
