import { AsyncLocalStorage } from 'node:async_hooks'

export interface TraceStep {
  stage: 'filter' | 'observer' | 'middleware' | 'prompt' | 'command' | 'matcher' | 'suggest'
  plugin?: string
  command?: string
  outcome: 'handled' | 'passed' | 'blocked' | 'denied' | 'cooldown' | 'invalid' | 'error' | 'timeout'
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
  sent: string[]
}

export interface DispatchContext {
  eventId: string
  trace: DispatchTrace
  active: { value: boolean }
  plugin?: string
}

export const dispatchContext = new AsyncLocalStorage<DispatchContext | undefined>()
