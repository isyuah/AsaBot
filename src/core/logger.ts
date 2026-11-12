import { Writable } from 'node:stream'
import pino, { type DestinationStream, type Logger, type StreamEntry } from 'pino'
import pinoPretty from 'pino-pretty'

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

export type LogRecord = Readonly<Record<string, unknown>>
export type LogSubscriber = (record: LogRecord) => void
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
      } catch {
        process.emitWarning('A log subscriber threw while receiving a record', { type: 'LogSubscriberError' })
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
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const destination = options.destination ?? process.stdout
  const pretty = options.pretty ?? (process.env.NODE_ENV !== 'production' && process.stdout.isTTY === true)
  const output: DestinationStream = pretty ? pinoPretty({ destination, sync: true }) : destination
  const streams: StreamEntry[] = [
    { level: 'trace', stream: output },
    { level: 'trace', stream: ringBufferDestination },
  ]

  return pino(
    {
      level: options.level ?? 'info',
      redact: { paths: redactedFields, censor: '[Redacted]' },
    },
    pino.multistream(streams),
  )
}

export function getRecentLogs(): LogRecord[] {
  return logBuffer.recent()
}

export function subscribeLogs(subscriber: LogSubscriber): () => void {
  return logBuffer.subscribe(subscriber)
}

export const logger = createLogger()
