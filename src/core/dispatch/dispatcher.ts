import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import { CommandBuilder, type CommandDefinition, type CommandRegistration } from '../command/builder.ts'
import { formatUsage, parseArguments } from '../command/parse.ts'
import { tokenize } from '../command/tokenizer.ts'
import type { Config } from '../config/schema.ts'
import { CommandConflictError, SendBlockedError } from '../errors.ts'
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
import { dialogueMethods, stripLeadingMention } from '../event/index.ts'
import type { Message, Sendable } from '../message/index.ts'
import { isSegment } from '../message/index.ts'
import { resolvePermission } from '../permission.ts'
import { pluginExecution } from '../plugin/execution.ts'
import type { PluginStateEvent } from '../plugin/types.ts'
import { RateLimiter } from '../ratelimit.ts'
import { type Activity, ActivityTracker, trackPrompt } from './activity.ts'
import { messages } from './messages.ts'
import { PromptManager } from './prompt.ts'
import { scheduleTimeout } from './timer.ts'
import { type DispatchTrace, dispatchContext, type TraceStep } from './trace.ts'
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
import { groupKeyOf } from './types.ts'

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

function matches(pattern: MatchPattern, session: Session): { match?: RegExpExecArray } | undefined {
  if (typeof pattern === 'string') return session.text.includes(pattern) ? {} : undefined
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0
    const match = pattern.exec(session.text)
    return match ? { match } : undefined
  }
  return pattern(session) ? {} : undefined
}

function editDistance(first: string, second: string): number {
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index)
  for (let i = 0; i < first.length; i++) {
    const current = [i + 1]
    for (let j = 0; j < second.length; j++)
      current.push(
        Math.min(
          (current[j] as number) + 1,
          (previous[j + 1] as number) + 1,
          (previous[j] as number) + Number(first[i] !== second[j]),
        ),
      )
    previous = current
  }
  return previous[second.length] as number
}

/** 管理事件观察者、消息管线、命令、匹配器和对话等待。 */
export class Dispatcher implements SessionServices, CommandRegistration {
  accessFilter: AccessFilter = () => true
  isEnabledFor: EnabledFilter = () => true
  isCommandEnabledFor: (path: string, groupKey: string) => boolean = () => true
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
  private readonly warnedOverrideIssues = new Set<string>()
  private readonly activeTraces = new Map<string, DispatchTrace>()
  private readonly traceLinkSubscribers = new Set<(eventId: string, relatedEventId: string) => void>()

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
      const override = this.config.command.overrides[command.path.join(' ')]
      if ((override?.hidden ?? command.hidden) || !this.commandEnabled(command, session)) continue
      const permission = this.permission(command)
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

  private permission(command: CommandDefinition) {
    const permission = this.config.command.overrides[command.path.join(' ')]?.permission
    return permission === 'everyone'
      ? undefined
      : permission
        ? resolvePermission(permission)
        : command.permission
  }

  private effectivePaths(): { paths: CommandPath[]; issues: Map<CommandDefinition, string[]> } {
    const paths = [...this.paths.values()]
    const used = new Map(this.paths)
    const issues = new Map<CommandDefinition, string[]>()
    for (const command of this.commands) {
      const aliases = this.config.command.overrides[command.path.join(' ')]?.aliases ?? []
      for (const alias of aliases) {
        const path = alias.trim().split(/\s+/).filter(Boolean)
        const key = path.join(' ')
        const conflict = used.get(key)
        if (!key || conflict) {
          const issue = `别名 "${alias}" 与命令 "${conflict?.command.path.join(' ') ?? ''}" 冲突`
          const entries = issues.get(command) ?? []
          entries.push(issue)
          issues.set(command, entries)
          const warning = `${command.path.join(' ')}:${issue}`
          if (!this.warnedOverrideIssues.has(warning)) {
            this.warnedOverrideIssues.add(warning)
            this.logger.warn({ plugin: command.owner, command: command.path.join(' '), alias }, issue)
          }
          continue
        }
        const entry = { path, command }
        used.set(key, entry)
        paths.push(entry)
      }
    }
    return { paths, issues }
  }

  overrideIssues(command: CommandDefinition): string[] {
    return this.effectivePaths().issues.get(command) ?? []
  }

  aliases(command: CommandDefinition): string[] {
    return this.effectivePaths()
      .paths.filter((entry) => entry.command === command && entry.path.join(' ') !== command.path.join(' '))
      .map((entry) => entry.path.join(' '))
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

  activeTrace(eventId: string): DispatchTrace | undefined {
    return this.activeTraces.get(eventId)
  }

  subscribeTraceLinks(subscriber: (eventId: string, relatedEventId: string) => void): Disposer {
    this.traceLinkSubscribers.add(subscriber)
    return () => this.traceLinkSubscribers.delete(subscriber)
  }

  async dispatch(event: DispatchEvent): Promise<void> {
    if (this.shutdown.aborted) return
    if (event.kind === 'internal' || event.kind === 'meta') {
      const current = dispatchContext.getStore()
      if (event.name === 'bot.message.sent' && 'messageId' in event && current?.active.value) {
        current.trace.sent.push(event.messageId)
        event = { ...event, eventId: current.eventId }
      }
      await this.dispatchEvent(event)
      return
    }
    const parent = dispatchContext.getStore()
    if (parent?.active.value) {
      for (const subscriber of this.traceLinkSubscribers) subscriber(parent.eventId, event.id)
    }
    const trace: DispatchTrace = {
      eventId: event.id,
      name: event.name,
      platform: event.platform,
      selfId: event.selfId,
      ...('channelKey' in event ? { channel: event.channelKey } : {}),
      ...('userId' in event && event.userId !== undefined ? { userId: event.userId } : {}),
      time: event.time,
      duration: 0,
      steps: [],
      sent: [],
    }
    const active = { value: true }
    this.activeTraces.set(event.id, trace)
    const started = performance.now()
    await dispatchContext.run({ eventId: event.id, trace, active }, async () => {
      try {
        await this.dispatchEvent(event)
      } finally {
        active.value = false
        trace.duration = performance.now() - started
        try {
          await dispatchContext.run(undefined, () =>
            this.dispatch({
              id: randomUUID(),
              platform: event.platform,
              selfId: event.selfId,
              time: Date.now(),
              kind: 'internal',
              name: 'dispatch.trace',
              raw: undefined,
              bot: event.bot,
              trace,
            }),
          )
        } finally {
          this.activeTraces.delete(event.id)
        }
      }
    })
  }

  private async dispatchEvent(event: DispatchEvent): Promise<void> {
    this.onDispatch(event)
    const filterStarted = performance.now()
    if (
      ('userId' in event || 'groupId' in event) &&
      !(event.kind === 'message'
        ? event.isSuperuser
        : 'userId' in event &&
          event.userId !== undefined &&
          this.config.superusers.some(
            (actor) =>
              actor.platform === event.platform &&
              actor.selfId === event.selfId &&
              actor.userId === event.userId,
          )) &&
      !this.accessFilter(event)
    ) {
      const step = this.traceStep('filter', undefined, 'blocked')
      if (step) step.duration = performance.now() - filterStarted
      return
    }
    const observers = this.runObservers(event)
    let pipeline = Promise.resolve()
    if (event.kind === 'message') {
      const activity = this.activity.begin()
      pipeline = this.runMiddlewares(event, activity).finally(() => activity.finish())
    }
    try {
      await Promise.all([observers, pipeline])
    } catch (error) {
      if (!(error instanceof SendBlockedError)) throw error
      this.logger.info({ err: error, event: event.name, eventId: event.id }, 'Message send blocked')
    }
  }

  private traceStep(
    stage: TraceStep['stage'],
    plugin?: string,
    outcome: TraceStep['outcome'] = 'handled',
    command?: string,
  ): TraceStep | undefined {
    const context = dispatchContext.getStore()
    if (!context?.active.value) return undefined
    const step: TraceStep = {
      stage,
      ...(plugin === undefined ? {} : { plugin }),
      ...(command === undefined ? {} : { command }),
      outcome,
      duration: 0,
    }
    context.trace.steps.push(step)
    return step
  }

  private scopeEnabled(scope: Scope, event: DispatchEvent): boolean {
    if (!this.isEnabledFor(scope.owner, event)) return false
    try {
      return scope.filter?.(event) ?? true
    } catch (error) {
      this.logger.error(
        { err: error, plugin: scope.owner, event: event.name, eventId: event.id },
        'Scope filter failed',
      )
      return false
    }
  }

  private async runObservers(event: DispatchEvent): Promise<void> {
    const entries = this.observers.filter(
      (entry) => entry.active && (event.name === entry.name || event.name.startsWith(`${entry.name}.`)),
    )
    await Promise.allSettled(
      entries.map(async (entry) => {
        if (!entry.active || !this.scopeEnabled(entry.scope, event)) return
        await this.invoke(
          entry.scope,
          event,
          (view, signal) => entry.listener(view, signal),
          'Event listener failed',
          undefined,
          undefined,
          undefined,
          undefined,
          'observer',
        )
      }),
    )
  }

  private async runMiddlewares(session: Session, activity: Activity): Promise<void> {
    const entries = [...this.middlewares].sort((a, b) => b.priority - a.priority)
    const run = async (index: number, parent: Activity): Promise<void> => {
      const entry = entries[index]
      if (entry === undefined) {
        const started = performance.now()
        const prompt = this.prompts.consume(session)
        if (prompt) {
          const step = this.traceStep('prompt', prompt.owner)
          if (step) step.duration = performance.now() - started
          await prompt.settled
          return
        }
        if (await this.runCommand(session, parent)) return
        if (!(await this.runMatchers(session, parent))) await this.runSuggest(session, parent)
        return
      }
      if (!entry.active || !this.scopeEnabled(entry.scope, session)) return run(index + 1, parent)
      let middlewareActivity: Activity
      await this.invoke(
        entry.scope,
        session,
        async (view, signal, step) => {
          let nextPromise: Promise<void> | undefined
          let called = false
          const next = (): Promise<void> => {
            if (called) throw new Error('Middleware next() called more than once')
            signal.throwIfAborted()
            called = true
            if (step) step.outcome = 'passed'
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
        'middleware',
      )
    }
    await run(0, activity)
  }

  private async runMatchers(session: Session, parent: Activity): Promise<boolean> {
    const entries = [...this.matchers].sort((a, b) => b.priority - a.priority)
    let anyMatched = false
    for (const entry of entries) {
      if (!entry.active || !this.scopeEnabled(entry.scope, session)) continue
      let matched = false
      await this.invoke(
        entry.scope,
        session,
        async (view, signal, _step, record) => {
          const bound = view as Session
          const resultMatch = matches(entry.pattern, bound)
          if (!resultMatch) return
          matched = true
          anyMatched = true
          record()
          const result = await entry.handler({ session: bound, signal, ...resultMatch })
          if (result !== undefined && !signal.aborted) await bound.send(result)
        },
        'Matcher failed',
        undefined,
        undefined,
        undefined,
        parent,
        'matcher',
      )
      if (matched && entry.block) break
    }
    return anyMatched
  }

  private commandSource(session: Session): Message | undefined {
    const message = stripLeadingMention(session.message, session.selfId)
    const first = message[0]
    const text = first && isSegment(first, 'text') ? first.data.text : ''
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
    const available = this.effectivePaths().paths.filter(({ command }) =>
      this.commandEnabled(command, session),
    )
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
      async (view, signal, step) => {
        const bound = view as Session
        const permission = this.permission(command)
        if (permission !== undefined) {
          const allowed = await permission(bound)
          signal.throwIfAborted()
          if (!allowed) {
            if (step) step.outcome = 'denied'
            if (this.config.command.replyOnDenied) await bound.send(messages.denied)
            return
          }
        }
        let parsed: ReturnType<typeof parseArguments>
        try {
          parsed = parseArguments(command, source, candidate.path.length, this.config.timezone)
        } catch (error) {
          if (step) step.outcome = 'invalid'
          await bound.send(
            messages.argumentError(
              error instanceof Error ? error.message : String(error),
              formatUsage(command, this.config.command.prefixes[0] ?? ''),
            ),
          )
          return
        }
        // Cooldown is charged only after arguments parse, so a typo does not burn the user's cooldown.
        const override = this.config.command.overrides[command.path.join(' ')]
        const cooldown =
          override?.cooldown === false
            ? undefined
            : override?.cooldown
              ? { duration: override.cooldown.duration, scope: override.cooldown.scope ?? ('user' as const) }
              : command.cooldown
        if (cooldown !== undefined) {
          const limit = this.limiter.check(command, bound, cooldown.duration, cooldown.scope)
          if (limit !== null) {
            if (step) step.outcome = 'cooldown'
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
      'command',
    )
    return true
  }

  private async subcommands(path: string[], session: Session, parent: Activity): Promise<string[]> {
    const visible = new Set(await this.listCommands(session, parent))
    const result = new Set<string>()
    for (const entry of this.effectivePaths().paths) {
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
    const path = command.path.join(' ')
    const groupKey = groupKeyOf(session)
    return (
      this.config.command.overrides[path]?.enabled !== false &&
      (command.messageScope === 'all' || command.messageScope === session.messageType) &&
      (groupKey === undefined || this.isCommandEnabledFor(path, groupKey)) &&
      this.scopeEnabled(command.scope, session)
    )
  }

  private async runSuggest(session: Session, parent: Activity): Promise<void> {
    const mode = this.config.command.suggest
    if (mode === 'off') return
    const message = stripLeadingMention(session.message, session.selfId)
    const first = message[0]
    const text = first && isSegment(first, 'text') ? first.data.text : ''
    const prefix = [...this.config.command.prefixes]
      .sort((a, b) => b.length - a.length)
      .find((item) => item.length > 0 && text.startsWith(item))
    if (!(session.messageType === 'private' || session.toMe || (mode === 'always' && prefix))) return
    if (prefix && first) message[0] = { type: 'text', data: { text: text.slice(prefix.length) } }
    const token = tokenize(message).tokens[0]
    if (!token || token.error || typeof token.value !== 'string' || !token.value) return
    const visible = new Set(await this.listCommands(session, parent))
    const names = new Set(
      this.effectivePaths()
        .paths.filter((entry) => visible.has(entry.command))
        .map((entry) => entry.path.join(' ')),
    )
    let nearest = Infinity
    const results: string[] = []
    for (const name of names) {
      if (Math.abs(token.value.length - name.length) > (name.length <= 4 ? 1 : 2)) continue
      const distance = editDistance(token.value, name)
      if (distance > (name.length <= 4 ? 1 : 2)) continue
      if (distance < nearest) {
        nearest = distance
        results.length = 0
      }
      if (distance === nearest) results.push(name)
    }
    if (results.length !== 1) return
    const started = performance.now()
    const step = this.traceStep('suggest', 'core')
    try {
      await session.send(messages.suggest(`${prefix ?? this.config.command.prefixes[0] ?? ''}${results[0]}`))
    } catch (error) {
      if (step) {
        step.outcome = 'error'
        step.error = error instanceof Error ? error.message : String(error)
      }
      throw error
    } finally {
      if (step) step.duration = performance.now() - started
    }
  }

  private bindSession(session: Session, signal: AbortSignal, activity?: Activity, owner?: string): Session {
    const view: Session = {
      ...session,
      ...dialogueMethods((work) => {
        const combined = AbortSignal.any([signal, this.shutdown])
        let waiting = false
        let pending = false
        const promise = work((text, options) =>
          this.prompts
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
              owner,
              activity,
            )
            .then((answer) => (answer === null ? null : this.bindSession(answer, signal, activity, owner))),
        )
        if (!activity) return promise
        return trackPrompt(promise, () => {
          waiting = true
          if (pending) activity.pause()
        })
      }),
    }
    return view
  }

  private async invoke(
    scope: Scope,
    event: DispatchEvent,
    handler: (
      event: DispatchEvent,
      signal: AbortSignal,
      step: TraceStep | undefined,
      record: () => void,
    ) => unknown | Promise<unknown>,
    message: string,
    command?: string,
    onError?: (event: DispatchEvent) => Promise<void>,
    setActivity?: (activity: Activity) => void,
    parent?: Activity,
    stage?: TraceStep['stage'],
  ): Promise<void> {
    if (scope.signal?.aborted || this.shutdown.aborted) return
    const started = performance.now()
    let step: TraceStep | undefined
    const record = (): void => {
      if (!step && stage && event.kind !== 'internal' && event.kind !== 'meta')
        step = this.traceStep(stage, scope.owner, 'handled', command)
    }
    if (stage !== 'matcher') record()
    const activity = this.activity.begin(parent)
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
    const view = event.kind === 'message' ? this.bindSession(event, signal, activity, scope.owner) : event
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    const current = dispatchContext.getStore()
    const handlerContext = current ? { ...current, plugin: scope.owner, parent: current } : undefined
    const logError = (error: unknown): void => {
      this.logger[error instanceof SendBlockedError ? 'info' : 'error'](
        {
          err: error,
          plugin: scope.owner,
          event: event.name,
          eventId: handlerContext?.active.value ? handlerContext.eventId : event.id,
          ...(command === undefined ? {} : { command }),
        },
        message,
      )
    }
    let finished = false
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return handlerContext
        ? pluginExecution.run(scope.owner, () =>
            dispatchContext.run(handlerContext, () => handler(view, signal, step, record)),
          )
        : pluginExecution.run(scope.owner, () => handler(view, signal, step, record))
    })
    void work.catch((error: unknown) => {
      if (finished && !isCancellation(error, signal)) logError(error)
    })
    try {
      await Promise.race([work, aborted])
    } catch (error) {
      if (isCancellation(error, signal)) {
        if (timeout.signal.aborted && signal.reason === timeout.signal.reason) {
          if (step) step.outcome = 'timeout'
          this.logger.warn(
            { plugin: scope.owner, event: event.name, eventId: handlerContext?.eventId ?? event.id },
            '处理器超时',
          )
        }
      } else {
        if (step) {
          step.outcome = 'error'
          step.error = error instanceof Error ? error.message : String(error)
        }
        logError(error)
        if (onError !== undefined && !(error instanceof SendBlockedError)) {
          try {
            await dispatchContext.run(handlerContext, () => onError(view))
          } catch (replyError) {
            this.logger[replyError instanceof SendBlockedError ? 'info' : 'error'](
              {
                err: replyError,
                plugin: scope.owner,
                event: event.name,
                eventId: handlerContext?.eventId ?? event.id,
              },
              'Failed to send error reply',
            )
          }
        }
      }
    } finally {
      finished = true
      if (step) step.duration = performance.now() - started
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
