export interface JsonSchema {
  writeOnly?: boolean
  type?: string | string[]
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  const?: unknown
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  minLength?: number
  maxLength?: number
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  additionalProperties?: boolean | JsonSchema
}

export interface StatsPoint {
  t: number
  received: number
  sent: number
}

export interface LogRecord {
  time: number
  level: number
  msg: string
  plugin?: string
  /** The dispatched event this record was logged while handling. */
  eventId?: string
  [key: string]: unknown
}

export type TraceStage = 'filter' | 'observer' | 'middleware' | 'prompt' | 'command' | 'matcher' | 'suggest'
export type TraceOutcome =
  | 'handled'
  | 'passed'
  | 'blocked'
  | 'denied'
  | 'cooldown'
  | 'invalid'
  | 'error'
  | 'timeout'

export interface TraceStep {
  stage: TraceStage
  plugin?: string
  command?: string
  outcome: TraceOutcome
  duration: number
  error?: string
}

export interface DispatchTrace {
  eventId: string
  name: string
  platform: string
  selfId: string
  channel?: string
  userId?: string
  time: number
  duration: number
  steps: TraceStep[]
  /** Message IDs sent while handling the event. */
  sent: string[]
}

export interface Segment {
  type: string
  data: Record<string, unknown>
}
