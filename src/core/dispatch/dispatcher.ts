import type { Logger } from 'pino'
import { CommandBuilder, type CommandDefinition, type CommandRegistration } from '../command/builder.ts'
import { formatUsage, parseArguments } from '../command/parse.ts'
import { tokenize } from '../command/tokenizer.ts'
import type { Config } from '../config/schema.ts'
import { CommandConflictError } from '../errors.ts'
import type {
  EventMap,
  KnownEventMap,
  MetaEvent,
  NoticeEvent,
  PlatformNoticeEvent,
  PromptOptions,
  RequestEvent,
  Session,
  SessionServices,
} from '../event/index.ts'
import { stripLeadingMention } from '../event/index.ts'
import type { Message, Sendable } from '../message/index.ts'
import type { PluginStateEvent } from '../plugin/types.ts'
import { RateLimiter } from '../ratelimit.ts'
import { type Activity, ActivityTracker, trackPrompt } from './activity.ts'
import { messages } from './messages.ts'
import { PromptManager } from './prompt.ts'
import { scheduleTimeout } from './timer.ts'
import type {
  AccessFilter,
  DispatchEvent,
  Disposer,
  EnabledFilter,
  MatchHandler,
  MatchPattern,
  Middleware,
  Scope,
} from './types.ts'

type Listener = (event: DispatchEvent, signal: AbortSignal) => unknown | Promise<unknown>
type PublicListener =
  | Listener
  | ((event: Session, signal: AbortSignal) => unknown | Promise<unknown>)
  | ((event: NoticeEvent, signal: AbortSignal) => unknown | Promise<unknown>)
  | ((event: PlatformNoticeEvent, signal: AbortSignal) => unknown | Promise<unknown>)
  | ((event: RequestEvent, signal: AbortSignal) => unknown | Promise<unknown>)
  | ((event: MetaEvent, signal: AbortSignal) => unknown | Promise<unknown>)
  | ((event: PluginStateEvent, signal: AbortSignal) => unknown | Promise<unknown>)

interface Entry {
  scope: Scope
  priority: number
  active: boolean
}
interface Observer extends Entry {
  name: string
  listener: Listener
}
interface MiddlewareEntry extends Entry {
  handler: Middleware
}
interface MatcherEntry extends Entry {
  pattern: MatchPattern
  handler: MatchHandler
  block: boolean
}
interface CommandPath {
  path: string[]
  command: CommandDefinition
}
interface SignalRegistrations {
  disposers: Set<Disposer>
  onAbort: () => void
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error === signal.reason ||
      (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')))
  )
}

function matches(pattern: MatchPattern, session: Session): boolean {
  if (typeof pattern === 'string') return session.text.includes(pattern)
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0
    return pattern.test(session.text)
  }
  return pattern(session)
}

export class Dispatcher implements SessionServices, CommandRegistration {
  accessFilter: AccessFilter = () => true
  isEnabledFor: EnabledFilter = () => true
  onDispatch: (event: DispatchEvent) => void = () => {}
  private readonly config: Config
  private readonly logger: Logger
  private readonly shutdown: AbortSignal
  private readonly observers: Observer[] = []
  private readonly middlewares: MiddlewareEntry[] = []
  private readonly matchers: MatcherEntry[] = []
  private readonly paths = new Map<string, CommandPath>()
  private readonly commands = new Set<CommandDefinition>()
  private readonly disposers = new Map<CommandDefinition, Disposer>()
  private readonly signalRegistrations = new Map<AbortSignal, SignalRegistrations>()
  private readonly limiter = new RateLimiter()
  private readonly prompts: PromptManager
  private readonly activity = new ActivityTracker()

  constructor(config: Config, logger: Logger, shutdown: AbortSignal) {
    this.config = config
    this.logger = logger
    this.shutdown = shutdown
    this.prompts = new PromptManager(
      config.dispatch.promptTimeout,
      config.dispatch.maxPromptTimeout,
      (session, signal) => this.bindSession(session, signal),
    )
  }

  on<K extends keyof KnownEventMap>(
    scope: Scope,
    name: K,
    listener: (event: EventMap[K], signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  on(
    scope: Scope,
    name: 'plugin.state',
    listener: (event: PluginStateEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  on(
    scope: Scope,
    name: `notice.${string}`,
    listener: (event: PlatformNoticeEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  on(
    scope: Scope,
    name: `request.${string}`,
    listener: (event: RequestEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  on(
    scope: Scope,
    name: `meta.${string}`,
    listener: (event: MetaEvent, signal: AbortSignal) => unknown | Promise<unknown>,
  ): Disposer
  on(scope: Scope, name: string, listener: Listener): Disposer
  on(scope: Scope, name: string, listener: PublicListener): Disposer {
    const entry: Observer = { scope, name, listener: listener as Listener, priority: 0, active: true }
    this.observers.push(entry)
    return this.track(scope, () => {
      entry.active = false
      this.remove(this.observers, entry)
    })
  }

  middleware(scope: Scope, handler: Middleware, options: { priority?: number } = {}): Disposer {
    const entry: MiddlewareEntry = { scope, handler, priority: options.priority ?? 0, active: true }
    this.middlewares.push(entry)
    return this.track(scope, () => {
      entry.active = false
      this.remove(this.middlewares, entry)
    })
  }

  match(
    scope: Scope,
    pattern: MatchPattern,
    handler: MatchHandler,
    options: { priority?: number; block?: boolean } = {},
  ): Disposer {
    const entry: MatcherEntry = {
      scope,
      pattern,
      handler,
      priority: options.priority ?? 0,
      block: options.block ?? true,
      active: true,
    }
    this.matchers.push(entry)
    return this.track(scope, () => {
      entry.active = false
      this.remove(this.matchers, entry)
    })
  }

  command<const Decl extends string>(scope: Scope, declaration: Decl): CommandBuilder<Decl> {
    this.assertActive(scope)
    const builder = new CommandBuilder(scope, declaration, this)
    const command = builder.definition
    const key = command.path.join(' ')
    this.assertAvailable(key, scope.owner)
    this.paths.set(key, { path: command.path, command })
    this.commands.add(command)
    const disposer = this.track(scope, () => {
      for (const [name, entry] of this.paths) if (entry.command === command) this.paths.delete(name)
      this.commands.delete(command)
      this.disposers.delete(command)
      this.limiter.delete(command)
    })
    this.disposers.set(command, disposer)
    return builder
  }

  addAlias(command: CommandDefinition, alias: string): void {
    this.assertActive(command.scope)
    if (!this.commands.has(command)) throw new Error('Cannot modify a disposed command')
    // An alias is a complete command path: '重载插件' is top-level, 'plugin rl' is a sibling subcommand.
    const path = alias
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0)
    if (path.length === 0) throw new Error('命令别名不能为空')
    const key = path.join(' ')
    this.assertAvailable(key, command.owner)
    this.paths.set(key, { path, command })
  }

  dispose(command: CommandDefinition): void {
    this.disposers.get(command)?.()
  }

  async listCommands(session: Session, parent?: Activity): Promise<CommandDefinition[]> {
    const result: CommandDefinition[] = []
    for (const command of this.commands) {
      if (command.hidden || !this.commandEnabled(command, session)) continue
      const permission = command.permission
      if (permission !== undefined) {
        let permitted = false
        await this.invoke(
          command.scope,
          session,
          async (view) => {
            permitted = await permission(view as Session)
          },
          'Command permission failed',
          command.path.join(' '),
          undefined,
          undefined,
          parent,
        )
        if (!permitted) continue
      }
      result.push(command)
    }
    return result
  }

  registeredCommands(owner?: string): CommandDefinition[] {
    return [...this.commands].filter((command) => owner === undefined || command.owner === owner)
  }

  prompt(
    session: Session,
    text?: Sendable,
    options?: PromptOptions,
    signal?: AbortSignal,
  ): Promise<Session | null> {
    const combined = AbortSignal.any(signal === undefined ? [this.shutdown] : [signal, this.shutdown])
    return this.prompts.prompt(session, text, combined, options)
  }

  whenIdle(): Promise<void> {
    return this.activity.whenIdle()
  }

  async dispatch(event: DispatchEvent): Promise<void> {
    if (this.shutdown.aborted) return
    this.onDispatch(event)
    if (
      ('userId' in event || 'groupId' in event) &&
      !(event.kind === 'message'
        ? event.isSuperuser
        : 'userId' in event && event.userId !== undefined && this.config.superusers.includes(event.userId)) &&
      !this.accessFilter(event)
    )
      return
    const observers = this.runObservers(event)
    let pipeline = Promise.resolve()
    if (event.kind === 'message') {
      const activity = this.activity.begin()
      pipeline = this.runMiddlewares(event, activity).finally(() => activity.finish())
    }
    await Promise.all([observers, pipeline])
  }

  private async runObservers(event: DispatchEvent): Promise<void> {
    const entries = this.observers.filter(
      (entry) => entry.active && (event.name === entry.name || event.name.startsWith(`${entry.name}.`)),
    )
    await Promise.allSettled(
      entries.map(async (entry) => {
        if (!entry.active || !this.isEnabledFor(entry.scope.owner, event)) return
        await this.invoke(
          entry.scope,
          event,
          (view, signal) => entry.listener(view, signal),
          'Event listener failed',
        )
      }),
    )
  }

  private async runMiddlewares(session: Session, activity: Activity): Promise<void> {
    const entries = [...this.middlewares].sort((a, b) => b.priority - a.priority)
    const run = async (index: number, parent: Activity): Promise<void> => {
      const entry = entries[index]
      if (entry === undefined) {
        if (this.prompts.consume(session)) return
        if (await this.runCommand(session, parent)) return
        await this.runMatchers(session, parent)
        return
      }
      if (!entry.active || !this.isEnabledFor(entry.scope.owner, session)) return run(index + 1, parent)
      let middlewareActivity: Activity
      await this.invoke(
        entry.scope,
        session,
        async (view, signal) => {
          let nextPromise: Promise<void> | undefined
          let called = false
          const next = (): Promise<void> => {
            if (called) throw new Error('Middleware next() called more than once')
            signal.throwIfAborted()
            called = true
            nextPromise = run(index + 1, middlewareActivity)
            return nextPromise
          }
          await entry.handler(view as Session, next, signal)
          if (nextPromise !== undefined) await nextPromise
        },
        'Middleware failed',
        undefined,
        undefined,
        (activity) => {
          middlewareActivity = activity
        },
        parent,
      )
    }
    await run(0, activity)
  }

  private async runMatchers(session: Session, parent: Activity): Promise<void> {
    const entries = [...this.matchers].sort((a, b) => b.priority - a.priority)
    for (const entry of entries) {
      if (!entry.active || !this.isEnabledFor(entry.scope.owner, session)) continue
      let matched = false
      await this.invoke(
        entry.scope,
        session,
        async (view, signal) => {
          const bound = view as Session
          matched = matches(entry.pattern, bound)
          if (!matched) return
          const result = await entry.handler(bound, signal)
          if (result !== undefined && !signal.aborted) await bound.send(result)
        },
        'Matcher failed',
        undefined,
        undefined,
        undefined,
        parent,
      )
      if (matched && entry.block) break
    }
  }

  private commandSource(session: Session): Message | undefined {
    const message = stripLeadingMention(session.message, session.selfId)
    const first = message[0]
    const text = first?.type === 'text' ? String(first.data.text) : ''
    const prefix = [...this.config.command.prefixes]
      .sort((a, b) => b.length - a.length)
      .find((item) => item.length > 0 && text.startsWith(item))
    if (prefix !== undefined && first !== undefined) {
      message[0] = { type: 'text', data: { text: text.slice(prefix.length) } }
      return message
    }
    if (
      session.messageType === 'private'
        ? !this.config.command.privateRequirePrefix
        : session.toMe && this.config.command.mentionAsPrefix
    )
      return message
    return undefined
  }

  private async runCommand(session: Session, parent: Activity): Promise<boolean> {
    const message = this.commandSource(session)
    if (message === undefined) return false
    const source = tokenize(message)
    const available = [...this.paths.values()].filter(({ command }) => this.commandEnabled(command, session))
    const candidates = available
      .filter(({ path }) =>
        path.every((part, index) => source.tokens[index]?.value === part && !source.tokens[index]?.error),
      )
      .sort((a, b) => b.path.length - a.path.length)
    const candidate = candidates[0]
    let branch: string[] = []
    for (const { path } of available) {
      let length = 0
      while (
        length < path.length &&
        source.tokens[length]?.value === path[length] &&
        !source.tokens[length]?.error
      )
        length += 1
      if (length === source.tokens.length && length < path.length && length > branch.length) {
        branch = path.slice(0, length)
      }
    }
    if (branch.length > (candidate?.path.length ?? 0)) {
      const children = await this.subcommands(branch, session, parent)
      if (children.length === 0) return false
      await session.send(messages.subcommands(children))
      return true
    }
    if (candidate === undefined) return false
    const command = candidate.command
    if (command.action === undefined) {
      if (source.tokens.length > candidate.path.length) return false
      const children = await this.subcommands(candidate.path, session, parent)
      if (children.length > 0) await session.send(messages.subcommands(children))
      return true
    }
    await this.invoke(
      command.scope,
      session,
      async (view, signal) => {
        const bound = view as Session
        if (command.permission !== undefined) {
          const allowed = await command.permission(bound)
          signal.throwIfAborted()
          if (!allowed) {
            if (this.config.command.replyOnDenied) await bound.send(messages.denied)
            return
          }
        }
        let parsed: ReturnType<typeof parseArguments>
        try {
          parsed = parseArguments(command, source, candidate.path.length)
        } catch (error) {
          await bound.send(
            messages.argumentError(
              error instanceof Error ? error.message : String(error),
              formatUsage(command, this.config.command.prefixes[0] ?? ''),
            ),
          )
          return
        }
        // Cooldown is charged only after arguments parse, so a typo does not burn the user's cooldown.
        if (command.cooldown !== undefined) {
          const limit = this.limiter.check(command, bound, command.cooldown.duration, command.cooldown.scope)
          if (limit !== null) {
            if (limit.notify && this.config.command.replyOnDenied)
              await bound.send(messages.cooldown(limit.remaining))
            return
          }
        }
        const result = await command.action?.({ session: bound, ...parsed, signal })
        if (result !== undefined && !signal.aborted) await bound.send(result)
      },
      'Command failed',
      command.path.join(' '),
      async (view) => {
        if (this.config.command.replyOnError) await (view as Session).send(messages.commandError)
      },
      undefined,
      parent,
    )
    return true
  }

  private async subcommands(path: string[], session: Session, parent: Activity): Promise<string[]> {
    const visible = new Set(await this.listCommands(session, parent))
    const result = new Set<string>()
    for (const entry of this.paths.values()) {
      if (
        visible.has(entry.command) &&
        entry.path.length > path.length &&
        path.every((part, index) => entry.path[index] === part)
      ) {
        result.add(entry.path[path.length] as string)
      }
    }
    return [...result]
  }

  private commandEnabled(command: CommandDefinition, session: Session): boolean {
    return (
      (command.messageScope === 'all' || command.messageScope === session.messageType) &&
      this.isEnabledFor(command.owner, session)
    )
  }

  private bindSession(session: Session, signal: AbortSignal, activity?: Activity): Session {
    const view: Session = {
      ...session,
      prompt: (text, options) => {
        const combined = AbortSignal.any([signal, this.shutdown])
        let waiting = false
        let pending = false
        const promise = this.prompts
          .prompt(
            view,
            text,
            combined,
            options,
            () => {
              pending = true
              if (waiting) activity?.pause()
            },
            () => {
              pending = false
              activity?.resume()
            },
          )
          .then((answer) => (answer === null ? null : this.bindSession(answer, signal, activity)))
        if (!activity) return promise
        return trackPrompt(promise, () => {
          waiting = true
          if (pending) activity.pause()
        })
      },
    }
    return view
  }

  private async invoke(
    scope: Scope,
    event: DispatchEvent,
    handler: (event: DispatchEvent, signal: AbortSignal) => unknown | Promise<unknown>,
    message: string,
    command?: string,
    onError?: (event: DispatchEvent) => Promise<void>,
    setActivity?: (activity: Activity) => void,
    parent?: Activity,
  ): Promise<void> {
    if (scope.signal?.aborted || this.shutdown.aborted) return
    const activity = this.activity.begin()
    parent?.pause()
    setActivity?.(activity)
    const timeout = new AbortController()
    const cancelTimer = scheduleTimeout(this.config.dispatch.handlerTimeout, () =>
      timeout.abort(new DOMException('Handler timed out', 'TimeoutError')),
    )
    const signal = AbortSignal.any([
      ...(scope.signal === undefined ? [] : [scope.signal]),
      this.shutdown,
      timeout.signal,
    ])
    const view = event.kind === 'message' ? this.bindSession(event, signal, activity) : event
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    const logError = (error: unknown): void => {
      this.logger.error(
        {
          err: error,
          plugin: scope.owner,
          event: event.name,
          eventId: event.id,
          ...(command === undefined ? {} : { command }),
        },
        message,
      )
    }
    let finished = false
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return handler(view, signal)
    })
    void work.catch((error: unknown) => {
      if (finished && !isCancellation(error, signal)) logError(error)
    })
    try {
      await Promise.race([work, aborted])
    } catch (error) {
      if (isCancellation(error, signal)) {
        if (timeout.signal.aborted && signal.reason === timeout.signal.reason)
          this.logger.warn({ plugin: scope.owner, event: event.name, eventId: event.id }, '处理器超时')
      } else {
        logError(error)
        if (onError !== undefined) {
          try {
            await onError(view)
          } catch (replyError) {
            this.logger.error(
              { err: replyError, plugin: scope.owner, event: event.name, eventId: event.id },
              'Failed to send error reply',
            )
          }
        }
      }
    } finally {
      finished = true
      cancelTimer()
      signal.removeEventListener('abort', onAbort)
      parent?.resume()
      activity.finish()
    }
  }

  private assertActive(scope: Scope): void {
    if (scope.signal?.aborted) throw scope.signal.reason
    if (this.shutdown.aborted) throw this.shutdown.reason
  }

  private track(scope: Scope, remove: Disposer): Disposer {
    try {
      this.assertActive(scope)
    } catch (error) {
      remove()
      throw error
    }
    let active = true
    const signals = [...new Set([this.shutdown, ...(scope.signal === undefined ? [] : [scope.signal])])]
    const dispose = (): void => {
      if (!active) return
      active = false
      for (const signal of signals) {
        const registrations = this.signalRegistrations.get(signal)
        if (registrations === undefined) continue
        registrations.disposers.delete(dispose)
        if (registrations.disposers.size === 0) {
          signal.removeEventListener('abort', registrations.onAbort)
          this.signalRegistrations.delete(signal)
        }
      }
      remove()
    }
    for (const signal of signals) {
      let registrations = this.signalRegistrations.get(signal)
      if (registrations === undefined) {
        const disposers = new Set<Disposer>()
        const onAbort = (): void => {
          for (const item of [...disposers]) item()
        }
        registrations = { disposers, onAbort }
        this.signalRegistrations.set(signal, registrations)
        signal.addEventListener('abort', onAbort, { once: true })
      }
      registrations.disposers.add(dispose)
    }
    return dispose
  }

  private assertAvailable(name: string, owner: string): void {
    const existing = this.paths.get(name)
    if (existing !== undefined) throw new CommandConflictError(name, existing.command.owner, owner)
  }

  private remove<T>(entries: T[], entry: T): void {
    const index = entries.indexOf(entry)
    if (index >= 0) entries.splice(index, 1)
  }
}
