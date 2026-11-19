import { AsyncLocalStorage } from 'node:async_hooks'
import type { DeliveryFailure } from '../delivery.ts'

/** 一次事件分发中单个阶段的处理结果及耗时。 */
export interface TraceStep {
  stage: 'filter' | 'observer' | 'middleware' | 'prompt' | 'command' | 'matcher' | 'suggest'
  plugin?: string
  command?: string
  outcome: 'handled' | 'passed' | 'blocked' | 'denied' | 'cooldown' | 'invalid' | 'error' | 'timeout'
  duration: number
  error?: string
  deliveryFailure?: DeliveryFailure
}

/** 事件的完整分发阶段、耗时和发送消息 ID。 */
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
  parent?: DispatchContext
}

export const dispatchContext = new AsyncLocalStorage<DispatchContext | undefined>()
