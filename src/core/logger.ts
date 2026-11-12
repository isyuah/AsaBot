import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { Writable } from 'node:stream'
import pino, { type DestinationStream, type Logger, type StreamEntry } from 'pino'
import { dispatchContext } from './dispatch/trace.ts'

const logCapacity = 2_000
const redactedFields = [
  'accessToken',
  'token',
  'password',
  'apiToken',
  '*.accessToken',
  '*.token',
  '*.password',
  '*.apiToken',
]
// A subscriber failure cannot be sent through the same ring buffer without recursing.
const subscriberErrorLogger = pino(
  { redact: { paths: redactedFields, censor: '[Redacted]' } },
  process.stderr,
)

/** 包含可选事件 ID 的只读结构化日志记录。 */
export type LogRecord = Readonly<Record<string, unknown> & { eventId?: string }>
/** 接收每条新日志记录的回调。 */
export type LogSubscriber = (record: LogRecord) => void
/** 框架支持的日志级别。 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

class LogRingBuffer {
  private readonly entries: (LogRecord | undefined)[] = new Array(logCapacity)
  private readonly subscribers = new Set<LogSubscriber>()
  private pending = ''
  private nextIndex = 0
  private size = 0

  append(record: LogRecord): void {
    const entry = Object.freeze(record)
    this.entries[this.nextIndex] = entry
    this.nextIndex = (this.nextIndex + 1) % logCapacity
    this.size = Math.min(this.size + 1, logCapacity)

    for (const subscriber of this.subscribers) {
      try {
        subscriber(entry)
      } catch (error) {
        subscriberErrorLogger.error({ err: error }, 'Log subscriber failed')
      }
    }
  }

  appendSerializedChunk(chunk: string): void {
    this.pending += chunk
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line.length > 0) {
        this.append(JSON.parse(line) as Record<string, unknown>)
      }
    }
  }

  recent(): LogRecord[] {
    const records: LogRecord[] = []
    const firstIndex = (this.nextIndex - this.size + logCapacity) % logCapacity

    for (let offset = 0; offset < this.size; offset += 1) {
      const record = this.entries[(firstIndex + offset) % logCapacity]
      if (record !== undefined) {
        records.push(record)
      }
    }

    return records
  }

  subscribe(subscriber: LogSubscriber): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }
}

const logBuffer = new LogRingBuffer()

const ringBufferDestination = new Writable({
  write(chunk, _encoding, callback) {
    try {
      logBuffer.appendSerializedChunk(chunk.toString())
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  },
})

export interface CreateLoggerOptions {
  level?: LogLevel
  destination?: DestinationStream
  pretty?: boolean
  file?: { path: string; maxSize: number; maxFiles: number }
}

class RotatingFile {
  private readonly options: NonNullable<CreateLoggerOptions['file']>
  private readonly warn: (error: unknown) => void
  private size = 0
  private initialized = false
  private failed = false

  constructor(options: NonNullable<CreateLoggerOptions['file']>, warn: (error: unknown) => void) {
    this.options = options
    this.warn = warn
  }

  write(chunk: string): void {
    if (this.failed) return
    try {
      const { path, maxSize, maxFiles } = this.options
      if (!this.initialized) {
        mkdirSync(dirname(path), { recursive: true })
        this.size = existsSync(path) ? statSync(path).size : 0
        this.initialized = true
      }
      const length = Buffer.byteLength(chunk)
      if (this.size > 0 && this.size + length > maxSize) {
        if (maxFiles === 1) unlinkSync(path)
        else {
          const oldest = `${path}.${maxFiles - 1}`
          if (existsSync(oldest)) unlinkSync(oldest)
          for (let index = maxFiles - 2; index >= 1; index--) {
            const previous = `${path}.${index}`
            if (existsSync(previous)) renameSync(previous, `${path}.${index + 1}`)
          }
          renameSync(path, `${path}.1`)
        }
        this.size = 0
      }
      appendFileSync(path, chunk)
      this.size += length
    } catch (error) {
      this.failed = true
      this.warn(error)
    }
  }
}

/** 按选项创建带敏感字段脱敏、内存缓冲和可选文件输出的日志器。 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const destination = options.destination ?? process.stdout
  const pretty = options.pretty ?? process.stdout.isTTY === true
  let output: DestinationStream = destination
  if (pretty) {
    const pinoPretty: typeof import('pino-pretty') = createRequire(import.meta.url)('pino-pretty')
    output = pinoPretty({ destination, sync: true })
  }
  const streams: StreamEntry[] = [
    { level: 'trace', stream: output },
    { level: 'trace', stream: ringBufferDestination },
  ]
  let result: Logger
  if (options.file) {
    const file = new RotatingFile(options.file, (error) => {
      queueMicrotask(() =>
        result.warn({ err: error, path: options.file?.path }, 'Log file write or rotation failed'),
      )
    })
    streams.push({ level: 'trace', stream: file })
  }
  result = pino(
    {
      level: options.level ?? 'info',
      redact: { paths: redactedFields, censor: '[Redacted]' },
      mixin: () => {
        const context = dispatchContext.getStore()
        return context?.active.value ? { eventId: context.eventId } : {}
      },
    },
    pino.multistream(streams),
  )
  return result
}

/** 按时间顺序获取最近的内存日志。 */
export function getRecentLogs(): LogRecord[] {
  return logBuffer.recent()
}

/** 订阅新日志并返回取消订阅函数。 */
export function subscribeLogs(subscriber: LogSubscriber): () => void {
  return logBuffer.subscribe(subscriber)
}

/** 使用默认选项创建的日志器。 */
export const logger = createLogger()
