import { randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import type { Logger } from 'pino'
import { z } from 'zod'
import { type Config, durationSchema } from '../config/schema.ts'
import { scheduleTimeout } from '../dispatch/timer.ts'
import type { Storage } from '../storage/index.ts'
import { type Duration, parseDuration } from '../utils/duration.ts'
import { redactText } from '../utils/redact.ts'

export const taskStates = [
  'pending',
  'running',
  'retry_wait',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type TaskState = (typeof taskStates)[number]
export type TaskOutcome = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'timeout'

/** at 和 delay 必须且只能提供一个；相同逻辑键替换旧任务。 */
export interface TaskOptions {
  at?: Date | number
  delay?: Duration | string
  key?: string
}

/** 默认不自动重试、不限制执行时长；中止始终是协作式的。 */
export interface TaskRegistrationOptions {
  retry?: { maxRetries: number; delay?: Duration | string; maxDelay?: Duration | string }
  timeout?: Duration | string
}

export interface TaskPolicy {
  maxRetries: number
  delay: number
  maxDelay: number
  timeout?: number
}

export interface TaskRecord<T = unknown> {
  id: string
  plugin: string
  name: string
  key: string
  payload: T
  state: TaskState
  runAt: number
  nextRunAt: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  attempt: number
  failures: number
  policy: TaskPolicy
  error?: string
  blockedReason?: string
  canRetry: boolean
}

export interface TaskAttempt {
  id: string
  taskId: string
  attempt: number
  startedAt: number
  finishedAt?: number
  outcome: TaskOutcome
  error?: string
}

export interface TaskQuery {
  plugin?: string
  name?: string
  state?: TaskState
  q?: string
  offset?: number
  limit?: number
}

/** 插件按逻辑键管理任务，每次 schedule 创建独立的任务及历史。 */
export interface TaskHandle<T> {
  schedule(payload: T, options: TaskOptions): string
  cancel(key: string): boolean
  list(): TaskRecord<T>[]
  get(key: string): TaskRecord<T> | undefined
  attempts(key: string): TaskAttempt[]
  retry(key: string): boolean
}

export type TaskHandler<T> = (
  payload: T,
  context: { signal: AbortSignal; taskId: string; attempt: number; key: string; runAt: number },
) => unknown | Promise<unknown>

export class TaskConflictError extends Error {}

interface Registration {
  plugin: string
  name: string
  handler: TaskHandler<unknown>
  policy: TaskPolicy
  active: boolean
}

interface Execution {
  task: TaskRecord
  attemptId: string
  registration: Registration
  controller: AbortController
  cancelTimeout?: () => void
  reason?: 'user' | 'superseded' | 'timeout' | 'interrupted'
  detached: boolean
}

type Row = Record<string, unknown>
const terminal = new Set<TaskState>(['succeeded', 'failed', 'cancelled'])
const identity = (plugin: string, name: string, key?: string): string => JSON.stringify([plugin, name, key])
const policySchema = z
  .object({
    retry: z
      .object({
        maxRetries: z.number().int().nonnegative(),
        delay: durationSchema.default(5_000),
        maxDelay: durationSchema.default(300_000),
      })
      .strict()
      .optional(),
    timeout: durationSchema.refine((value) => value > 0, 'Timeout must be positive').optional(),
  })
  .strict()

/** 应用级单实例调度器，拥有执行代际、状态及数据库生命周期。 */
export class TaskService {
  private readonly storage: Storage
  private readonly config: Config
  private readonly logger: Logger
  private readonly registrations = new Map<string, Registration>()
  private readonly running = new Map<string, Execution>()
  private readonly locks = new Set<string>()
  private readonly subscribers = new Set<(id?: string) => void>()
  private cancelTimer?: () => void
  private sweep?: NodeJS.Timeout
  private queued = false
  private alive = false

  constructor(storage: Storage, config: Config, logger: Logger) {
    this.storage = storage
    this.config = config
    this.logger = logger
  }

  start(): void {
    const now = Date.now()
    const db = this.storage.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        "UPDATE task_attempts SET outcome = 'interrupted', finished_at = ? WHERE outcome = 'running'",
      ).run(now)
      db.prepare(
        "UPDATE tasks SET state = 'cancelled', finished_at = ?, updated_at = ? WHERE state = 'cancelling' AND cancel_reason IN ('user', 'superseded')",
      ).run(now, now)
      db.prepare(
        "UPDATE tasks SET state = 'pending', next_run_at = ?, updated_at = ?, cancel_reason = NULL WHERE state IN ('running', 'cancelling')",
      ).run(now, now)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    this.alive = true
    this.clean()
    this.sweep = setInterval(() => {
      try {
        this.clean()
      } catch (error) {
        this.logger.error({ error: this.errorText(error) }, 'Task history cleanup failed')
      }
    }, 60_000)
    this.sweep.unref()
  }

  stop(): void {
    if (!this.alive) return
    for (const registration of this.registrations.values()) this.unregister(registration)
    this.alive = false
    this.cancelTimer?.()
    clearInterval(this.sweep)
    this.subscribers.clear()
  }

  register(
    plugin: string,
    name: string,
    handler: TaskHandler<unknown>,
    options: TaskRegistrationOptions,
  ): Registration {
    if (!name.trim()) throw new TypeError('Task name must not be empty')
    const key = identity(plugin, name)
    if (this.registrations.has(key)) throw new Error(`Task "${name}" is already registered`)
    const parsed = policySchema.parse(options)
    const policy: TaskPolicy = {
      maxRetries: parsed.retry?.maxRetries ?? 0,
      delay: parsed.retry?.delay ?? 5_000,
      maxDelay: parsed.retry?.maxDelay ?? 300_000,
      ...(parsed.timeout === undefined ? {} : { timeout: parsed.timeout }),
    }
    if (policy.maxDelay < policy.delay) throw new TypeError('maxDelay must not be less than delay')
    const registration = { plugin, name, handler, policy, active: false }
    this.registrations.set(key, registration)
    return registration
  }

  activate(registrations: Registration[]): void {
    for (const registration of registrations) registration.active = true
    this.changed()
  }

  unregister(registration: Registration): void {
    if (this.registrations.get(identity(registration.plugin, registration.name)) !== registration) return
    this.registrations.delete(identity(registration.plugin, registration.name))
    registration.active = false
    for (const execution of this.running.values()) {
      if (execution.registration !== registration || execution.detached) continue
      execution.detached = true
      execution.cancelTimeout?.()
      const now = Date.now()
      const cancelled = execution.reason === 'user' || execution.reason === 'superseded'
      this.storage.db
        .prepare('UPDATE task_attempts SET outcome = ?, finished_at = ? WHERE id = ?')
        .run(cancelled ? 'cancelled' : 'interrupted', now, execution.attemptId)
      this.storage.db
        .prepare(
          'UPDATE tasks SET state = ?, next_run_at = ?, updated_at = ?, finished_at = ?, cancel_reason = NULL WHERE id = ?',
        )
        .run(cancelled ? 'cancelled' : 'pending', now, now, cancelled ? now : null, execution.task.id)
      execution.reason = 'interrupted'
      execution.controller.abort(new DOMException('Plugin unloaded', 'AbortError'))
    }
    this.changed()
  }

  schedule(registration: Registration, payload: unknown, options: TaskOptions): string {
    if ((options.at === undefined) === (options.delay === undefined))
      throw new TypeError('必须且只能指定 at 或 delay')
    const runAt =
      options.at === undefined
        ? Date.now() + parseDuration(options.delay as Duration | string)
        : Number(options.at)
    if (!Number.isFinite(runAt)) throw new TypeError('无效的任务时间')
    const json = JSON.stringify(payload)
    if (json === undefined) throw new TypeError('任务 payload 必须可以序列化为 JSON')
    const key = options.key ?? randomUUID()
    for (const previous of this.storage.db
      .prepare(
        "SELECT id FROM tasks WHERE plugin = ? AND name = ? AND key = ? AND state IN ('pending', 'running', 'retry_wait', 'cancelling')",
      )
      .all(registration.plugin, registration.name, key))
      this.cancel(String(previous.id), 'superseded')
    const now = Date.now()
    const id = randomUUID()
    this.storage.db
      .prepare(
        'INSERT INTO tasks (id, plugin, name, key, payload, state, run_at, next_run_at, created_at, updated_at, policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        registration.plugin,
        registration.name,
        key,
        json,
        'pending',
        Math.trunc(runAt),
        Math.trunc(runAt),
        now,
        now,
        JSON.stringify(registration.policy),
      )
    this.changed(id)
    return key
  }

  get(id: string): TaskRecord | undefined {
    const row = this.storage.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    return row ? this.record(row) : undefined
  }

  latest(plugin: string, name: string, key: string): TaskRecord | undefined {
    const row = this.storage.db
      .prepare('SELECT * FROM tasks WHERE plugin = ? AND name = ? AND key = ? ORDER BY rowid DESC LIMIT 1')
      .get(plugin, name, key)
    return row ? this.record(row) : undefined
  }

  query(options: TaskQuery = {}): { items: TaskRecord[]; total: number } {
    const conditions: string[] = []
    const values: SQLInputValue[] = []
    for (const [column, value] of [
      ['plugin', options.plugin],
      ['name', options.name],
      ['state', options.state],
    ] as const) {
      if (value !== undefined) {
        conditions.push(`${column} = ?`)
        values.push(value)
      }
    }
    if (options.q) {
      conditions.push('(instr(key, ?) > 0 OR instr(name, ?) > 0 OR instr(plugin, ?) > 0)')
      values.push(options.q, options.q, options.q)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = Number(
      this.storage.db.prepare(`SELECT COUNT(*) AS total FROM tasks ${where}`).get(...values)?.total,
    )
    const rows = this.storage.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...values, options.limit ?? 50, options.offset ?? 0)
    return { items: rows.map((row) => this.record(row)), total }
  }

  list(plugin: string, name: string): TaskRecord[] {
    return this.storage.db
      .prepare(
        "SELECT * FROM tasks WHERE plugin = ? AND name = ? AND state IN ('pending', 'running', 'retry_wait', 'cancelling') ORDER BY run_at, key",
      )
      .all(plugin, name)
      .map((row) => this.record(row))
  }

  attempts(taskId: string): TaskAttempt[] {
    return this.storage.db
      .prepare('SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt DESC')
      .all(taskId)
      .map((row) => ({
        id: String(row.id),
        taskId,
        attempt: Number(row.attempt),
        startedAt: Number(row.started_at),
        ...(row.finished_at === null ? {} : { finishedAt: Number(row.finished_at) }),
        outcome: row.outcome as TaskOutcome,
        ...(row.error === null ? {} : { error: String(row.error) }),
      }))
  }

  retry(id: string): TaskRecord {
    const task = this.get(id)
    if (!task?.canRetry) throw new TaskConflictError('任务必须处于失败状态，且处理器已激活')
    const now = Date.now()
    this.storage.db
      .prepare(
        "UPDATE tasks SET state = 'pending', failures = 0, next_run_at = ?, updated_at = ?, finished_at = NULL, cancel_reason = NULL WHERE id = ? AND state = 'failed'",
      )
      .run(now, now, id)
    this.changed(id)
    return this.get(id) as TaskRecord
  }

  cancel(id: string, reason: 'user' | 'superseded' = 'user'): boolean {
    const task = this.get(id)
    if (!task || terminal.has(task.state)) return false
    const now = Date.now()
    const execution = this.running.get(id)
    if (task.state === 'cancelling' && execution?.reason !== 'timeout') return false
    const running = execution !== undefined && !execution.detached
    this.storage.db
      .prepare('UPDATE tasks SET state = ?, cancel_reason = ?, updated_at = ?, finished_at = ? WHERE id = ?')
      .run(running ? 'cancelling' : 'cancelled', reason, now, running ? null : now, id)
    if (running) {
      execution.reason = reason
      execution.cancelTimeout?.()
      execution.controller.abort(new DOMException('Task cancelled', 'AbortError'))
    }
    this.changed(id)
    return true
  }

  subscribe(listener: (id?: string) => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  clean(now = Date.now()): void {
    const db = this.storage.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        "DELETE FROM tasks WHERE state IN ('succeeded', 'failed', 'cancelled') AND finished_at < ?",
      ).run(now - this.config.tasks.historyRetention)
      db.prepare(
        "DELETE FROM tasks WHERE id IN (SELECT id FROM tasks WHERE state IN ('succeeded', 'failed', 'cancelled') ORDER BY finished_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
      ).run(this.config.tasks.maxHistory)
      db.exec('DELETE FROM task_attempts WHERE task_id NOT IN (SELECT id FROM tasks)')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private record(row: Row): TaskRecord {
    const registration = this.registrations.get(identity(String(row.plugin), String(row.name)))
    const state = row.state as TaskState
    const waiting = state === 'pending' || state === 'retry_wait'
    const blockedReason = !registration?.active
      ? '任务处理器未激活'
      : waiting && this.locks.has(identity(String(row.plugin), String(row.name), String(row.key)))
        ? '等待同键的上一次执行结束'
        : undefined
    return {
      id: String(row.id),
      plugin: String(row.plugin),
      name: String(row.name),
      key: String(row.key),
      payload: JSON.parse(String(row.payload)),
      state,
      runAt: Number(row.run_at),
      nextRunAt: Number(row.next_run_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      attempt: Number(row.attempt),
      failures: Number(row.failures),
      policy: JSON.parse(String(row.policy)) as TaskPolicy,
      ...(row.started_at === null ? {} : { startedAt: Number(row.started_at) }),
      ...(row.finished_at === null ? {} : { finishedAt: Number(row.finished_at) }),
      ...(row.error === null ? {} : { error: String(row.error) }),
      ...(blockedReason === undefined || terminal.has(state) ? {} : { blockedReason }),
      canRetry:
        state === 'failed' &&
        registration?.active === true &&
        !this.locks.has(identity(String(row.plugin), String(row.name), String(row.key))) &&
        !this.storage.db
          .prepare(
            "SELECT 1 FROM tasks WHERE plugin = ? AND name = ? AND key = ? AND state IN ('pending', 'running', 'retry_wait', 'cancelling') LIMIT 1",
          )
          .get(String(row.plugin), String(row.name), String(row.key)),
    }
  }

  private changed(id?: string): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(id)
      } catch (error) {
        this.logger.error({ error: this.errorText(error) }, 'Task subscriber failed')
      }
    }
    this.wake()
  }

  private wake(): void {
    if (!this.alive || this.queued) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      if (!this.alive) return
      try {
        this.pump()
      } catch (error) {
        this.logger.error({ error: this.errorText(error) }, 'Task scheduler failed')
        this.cancelTimer = scheduleTimeout(1_000, () => this.wake(), true)
      }
    })
  }

  private pump(): void {
    this.cancelTimer?.()
    this.cancelTimer = undefined
    if (this.running.size >= this.config.tasks.maxConcurrent) return
    const rows = this.storage.db
      .prepare(
        "SELECT * FROM tasks WHERE state IN ('pending', 'retry_wait') ORDER BY next_run_at, created_at, rowid",
      )
      .all()
    let next = Number.POSITIVE_INFINITY
    for (const row of rows) {
      if (this.running.size >= this.config.tasks.maxConcurrent) break
      const task = this.record(row)
      const registration = this.registrations.get(identity(task.plugin, task.name))
      if (!registration?.active || this.locks.has(identity(task.plugin, task.name, task.key))) continue
      if (task.nextRunAt > Date.now()) {
        next = Math.min(next, task.nextRunAt)
        continue
      }
      this.execute(task, registration)
    }
    if (Number.isFinite(next) && this.running.size < this.config.tasks.maxConcurrent)
      this.cancelTimer = scheduleTimeout(
        Math.min(2_147_483_647, Math.max(0, next - Date.now())),
        () => this.wake(),
        true,
      )
  }

  private execute(task: TaskRecord, registration: Registration): void {
    const now = Date.now()
    const attemptId = randomUUID()
    const db = this.storage.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        "UPDATE tasks SET state = 'running', attempt = attempt + 1, started_at = ?, updated_at = ?, error = NULL WHERE id = ?",
      ).run(now, now, task.id)
      db.prepare(
        "INSERT INTO task_attempts (id, task_id, plugin, attempt, started_at, outcome) VALUES (?, ?, ?, ?, ?, 'running')",
      ).run(attemptId, task.id, task.plugin, task.attempt + 1, now)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    const execution: Execution = {
      task,
      attemptId,
      registration,
      controller: new AbortController(),
      detached: false,
    }
    this.running.set(task.id, execution)
    const lock = identity(task.plugin, task.name, task.key)
    this.locks.add(lock)
    if (task.policy.timeout !== undefined)
      execution.cancelTimeout = scheduleTimeout(
        task.policy.timeout,
        () => {
          if (!this.alive || execution.detached || execution.reason) return
          execution.reason = 'timeout'
          this.storage.db
            .prepare(
              "UPDATE tasks SET state = 'cancelling', cancel_reason = 'timeout', updated_at = ? WHERE id = ?",
            )
            .run(Date.now(), task.id)
          execution.controller.abort(new DOMException('Task timed out', 'TimeoutError'))
          this.changed(task.id)
        },
        true,
      )
    this.changed(task.id)
    void Promise.resolve()
      .then(() =>
        registration.handler(task.payload, {
          signal: execution.controller.signal,
          taskId: task.id,
          attempt: task.attempt + 1,
          key: task.key,
          runAt: task.runAt,
        }),
      )
      .then(
        () => this.finish(execution),
        (error: unknown) => this.finish(execution, { error }),
      )
      .catch((error: unknown) => {
        this.logger.error({ taskId: task.id, error: this.errorText(error) }, 'Failed to persist task result')
      })
      .finally(() => {
        execution.cancelTimeout?.()
        this.running.delete(task.id)
        this.locks.delete(lock)
        this.changed(task.id)
      })
  }

  private finish(execution: Execution, failure?: { error: unknown }): void {
    if (!this.alive || execution.detached) return
    const { task, reason } = execution
    const now = Date.now()
    const cancelled = reason === 'user' || reason === 'superseded'
    const failed = reason === 'timeout' || failure !== undefined
    const failures = task.failures + (failed ? 1 : 0)
    const retry = failed && !cancelled && failures <= task.policy.maxRetries
    const error = reason === 'timeout' ? '任务执行超时' : failure ? this.errorText(failure.error) : undefined
    const state: TaskState = cancelled ? 'cancelled' : retry ? 'retry_wait' : failed ? 'failed' : 'succeeded'
    const nextRunAt = retry
      ? now + Math.min(task.policy.maxDelay, task.policy.delay * 2 ** Math.min(30, failures - 1))
      : task.nextRunAt
    const db = this.storage.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE task_attempts SET outcome = ?, finished_at = ?, error = ? WHERE id = ?').run(
        cancelled ? 'cancelled' : reason === 'timeout' ? 'timeout' : failed ? 'failed' : 'succeeded',
        now,
        error ?? null,
        execution.attemptId,
      )
      db.prepare(
        'UPDATE tasks SET state = ?, failures = ?, next_run_at = ?, updated_at = ?, finished_at = ?, error = ?, cancel_reason = NULL WHERE id = ?',
      ).run(state, failures, nextRunAt, now, terminal.has(state) ? now : null, error ?? null, task.id)
      db.exec('COMMIT')
    } catch (cause) {
      db.exec('ROLLBACK')
      throw cause
    }
    if (failed)
      this.logger.error(
        { plugin: task.plugin, task: task.name, taskId: task.id, attempt: task.attempt + 1, error },
        'Scheduled task failed',
      )
  }

  private errorText(error: unknown): string {
    return redactText(error instanceof Error ? error.message : String(error), this.config).slice(0, 8_192)
  }
}

/** 插件级入口，注册在 setup 成功后激活，卸载时解除注册。 */
export class PersistentTasks {
  private readonly registrations: Registration[] = []
  private readonly service: TaskService
  private readonly owner: string
  private readonly assertActive: () => void

  constructor(service: TaskService, owner: string, signal: AbortSignal, assertActive: () => void) {
    this.service = service
    this.owner = owner
    this.assertActive = assertActive
    signal.addEventListener(
      'abort',
      () => {
        for (const registration of this.registrations) service.unregister(registration)
      },
      { once: true },
    )
  }

  register<T>(name: string, handler: TaskHandler<T>, options: TaskRegistrationOptions = {}): TaskHandle<T> {
    this.assertActive()
    const registration = this.service.register(this.owner, name, handler as TaskHandler<unknown>, options)
    this.registrations.push(registration)
    const get = (key: string): TaskRecord<T> | undefined => {
      this.assertActive()
      return this.service.latest(this.owner, name, key) as TaskRecord<T> | undefined
    }
    return {
      schedule: (payload, settings) => {
        this.assertActive()
        return this.service.schedule(registration, payload, settings)
      },
      cancel: (key) => {
        const task = get(key)
        return task ? this.service.cancel(task.id) : false
      },
      list: () => {
        this.assertActive()
        return this.service.list(this.owner, name) as TaskRecord<T>[]
      },
      get,
      attempts: (key) => {
        const task = get(key)
        return task ? this.service.attempts(task.id) : []
      },
      retry: (key) => {
        const task = get(key)
        if (!task?.canRetry) return false
        this.service.retry(task.id)
        return true
      },
    }
  }

  activate(): void {
    this.service.activate(this.registrations)
  }
}
