import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import { scheduleTimeout } from '../dispatch/timer.ts'
import type { Storage } from '../storage/index.ts'
import { parseDuration } from '../utils/duration.ts'

/** 持久化任务的时间与可选键；at 和 delay 必须且只能提供一个。 */
export interface TaskOptions {
  at?: Date | number
  delay?: string | number
  key?: string
}

/** 持久化任务的调度、取消和查询入口。 */
export interface TaskHandle<T> {
  /** 按 at 或 delay 调度任务并返回任务键；两者同时指定或都未指定时抛错，相同键会覆盖旧任务。 */
  schedule(payload: T, options: TaskOptions): string
  /** 按任务键取消待执行任务；找到并取消时返回 true。 */
  cancel(key: string): boolean
  /** 按执行时间列出当前插件此类任务的待执行项。 */
  list(): { key: string; runAt: number; payload: T }[]
}

/** 持久化任务的处理函数，接收载荷、任务键、计划时间及取消信号。 */
export type TaskHandler<T> = (
  payload: T,
  context: { signal: AbortSignal; key: string; runAt: number },
) => unknown | Promise<unknown>

interface Pending {
  cancel: () => void
}

export class TaskCoordinator {
  readonly running = new Map<string, Promise<void>>()
}

export class PersistentTasks {
  private readonly names = new Set<string>()
  private readonly timers = new Map<string, Map<string, Pending>>()
  private readonly storage: Storage
  private readonly owner: string
  private readonly signal: AbortSignal
  private readonly logger: Logger
  private readonly coordinator: TaskCoordinator
  private readonly assertActive: () => void

  constructor(
    storage: Storage,
    owner: string,
    signal: AbortSignal,
    logger: Logger,
    coordinator: TaskCoordinator,
    assertActive: () => void,
  ) {
    this.storage = storage
    this.owner = owner
    this.signal = signal
    this.logger = logger
    this.coordinator = coordinator
    this.assertActive = assertActive
    signal.addEventListener(
      'abort',
      () => {
        for (const entries of this.timers.values()) for (const timer of entries.values()) timer.cancel()
        this.timers.clear()
      },
      { once: true },
    )
  }

  register<T>(name: string, handler: TaskHandler<T>): TaskHandle<T> {
    this.assertActive()
    if (this.names.has(name)) throw new Error(`Task "${name}" is already registered`)
    this.names.add(name)
    const entries = new Map<string, Pending>()
    this.timers.set(name, entries)
    const arm = (key: string, runAt: number, payload: string): void => {
      entries.get(key)?.cancel()
      const pending: Pending = { cancel: () => {} }
      entries.set(key, pending)
      const fire = (): void => {
        if (this.signal.aborted || entries.get(key) !== pending) return
        const identity = JSON.stringify([this.owner, name, key])
        const previous = this.coordinator.running.get(identity)
        if (previous) {
          void previous.then(() => {
            if (!this.signal.aborted && entries.get(key) === pending) arm(key, runAt, payload)
          })
          return
        }
        const work = (async () => {
          try {
            await handler(JSON.parse(payload) as T, { signal: this.signal, key, runAt })
          } catch (error) {
            this.logger.error({ err: error, task: name, key }, 'Scheduled task failed')
          } finally {
            if (!this.signal.aborted && entries.get(key) === pending) {
              try {
                this.storage.db
                  .prepare('DELETE FROM scheduled_tasks WHERE plugin = ? AND name = ? AND key = ?')
                  .run(this.owner, name, key)
                entries.delete(key)
              } catch (error) {
                this.logger.error({ err: error, task: name, key }, 'Failed to remove scheduled task')
              }
            }
          }
        })()
        this.coordinator.running.set(identity, work)
        void work.finally(() => {
          this.coordinator.running.delete(identity)
        })
      }
      const remaining = Math.max(0, runAt - Date.now())
      pending.cancel = scheduleTimeout(
        Math.min(remaining, 2_147_483_647),
        () => {
          if (Date.now() < runAt) arm(key, runAt, payload)
          else fire()
        },
        true,
      )
    }
    const list = (): { key: string; runAt: number; payload: T }[] => {
      this.assertActive()
      return this.storage.db
        .prepare(
          'SELECT key, run_at, payload FROM scheduled_tasks WHERE plugin = ? AND name = ? ORDER BY run_at, key',
        )
        .all(this.owner, name)
        .map((row) => ({
          key: String(row.key),
          runAt: Number(row.run_at),
          payload: JSON.parse(String(row.payload)) as T,
        }))
    }
    for (const row of this.storage.db
      .prepare('SELECT key, run_at, payload FROM scheduled_tasks WHERE plugin = ? AND name = ?')
      .all(this.owner, name))
      arm(String(row.key), Number(row.run_at), String(row.payload))
    return {
      schedule: (payload, options) => {
        this.assertActive()
        if ((options.at === undefined) === (options.delay === undefined))
          throw new TypeError('必须且只能指定 at 或 delay')
        const runAt =
          options.at === undefined
            ? Date.now() + parseDuration(options.delay as string | number)
            : Number(options.at)
        if (!Number.isFinite(runAt)) throw new TypeError('无效的任务时间')
        const json = JSON.stringify(payload)
        if (json === undefined) throw new TypeError('任务 payload 必须可以序列化为 JSON')
        const key = options.key ?? randomUUID()
        this.storage.db
          .prepare(
            'INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?, ?) ON CONFLICT(plugin, name, key) DO UPDATE SET run_at = excluded.run_at, payload = excluded.payload',
          )
          .run(this.owner, name, key, Math.trunc(runAt), json)
        arm(key, Math.trunc(runAt), json)
        return key
      },
      cancel: (key) => {
        this.assertActive()
        const result = this.storage.db
          .prepare('DELETE FROM scheduled_tasks WHERE plugin = ? AND name = ? AND key = ?')
          .run(this.owner, name, key)
        entries.get(key)?.cancel()
        entries.delete(key)
        return Number(result.changes) > 0
      },
      list,
    }
  }

  warnUnregistered(): void {
    for (const row of this.storage.db
      .prepare('SELECT DISTINCT name FROM scheduled_tasks WHERE plugin = ?')
      .all(this.owner)) {
      const name = String(row.name)
      if (!this.names.has(name)) this.logger.warn({ task: name }, 'Scheduled task has no registered handler')
    }
  }
}
