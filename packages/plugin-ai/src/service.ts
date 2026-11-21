import { randomUUID } from 'node:crypto'
import type { Context, HttpService, ServiceConsumer } from '@asabot/core'
import { type Audit, capturedText } from './audit.ts'
import type { Catalog, Target } from './catalog.ts'
import {
  type AiCallOptions,
  type AiGenerateOptions,
  type AiGenerateResult,
  type AiResult,
  type AiService,
  type AiToolCall,
  type AiUsage,
  type Capability,
  capabilities,
  type Feature,
  type FinishedState,
  features,
  type RequestRecord,
} from './contracts.ts'
import { AiError } from './errors.ts'
import * as providers from './providers.ts'
import { chatInput, dayMs, decisionInput, imageInput, panelSource, parse, speechInput } from './schema.ts'

type Scope = Pick<ServiceConsumer, 'signal' | 'event'> & { source: string }
type WithoutRequest<Result> = Omit<Result, 'requestId' | 'modelId'>
type ProviderResult = Pick<AiResult, 'upstreamModel' | 'usage'>
type LogError = (id: string, reason: string) => void

class Call {
  private readonly controller = new AbortController()
  private readonly started = performance.now()
  private readonly startedAt = Date.now()
  private readonly audit: Audit
  private readonly logError: LogError
  private readonly capture: boolean
  private finished = false
  private timeout?: NodeJS.Timeout
  private signal?: AbortSignal
  private transport?: providers.Transport
  private key?: string
  private upstreamModel?: string
  private usage?: AiUsage
  private phase: 'selection' | 'upstream' = 'selection'
  readonly id = randomUUID()

  constructor(
    audit: Audit,
    catalog: Catalog,
    scope: Scope,
    capability: Capability,
    mode: RequestRecord['mode'],
    logError: LogError,
  ) {
    this.audit = audit
    this.logError = logError
    this.capture = catalog.capture(this.startedAt)?.source === scope.source
    audit.begin({
      id: this.id,
      startedAt: this.startedAt,
      source: scope.source,
      capability,
      mode,
      ...scope.event(),
    })
  }

  readonly progress = (usage: AiUsage, upstreamModel?: string) => {
    this.usage = usage
    this.upstreamModel = upstreamModel === undefined ? undefined : this.safeModel(upstreamModel)
  }

  connect(
    http: HttpService,
    target: Target,
    key: string | undefined,
    signals: AbortSignal[],
  ): providers.Transport {
    this.key = key
    this.timeout = setTimeout(
      () => this.controller.abort(new DOMException('AI timeout', 'TimeoutError')),
      target.channel.timeoutMs,
    )
    this.timeout.unref()
    this.signal = AbortSignal.any([...signals, this.controller.signal])
    this.signal.addEventListener('abort', this.onAbort, { once: true })
    this.phase = 'upstream'
    this.signal.throwIfAborted()
    this.transport = new providers.Transport(http, target.channel, key, this.signal)
    return this.transport
  }

  private readonly onAbort = () => {
    const error = this.cancelError()
    try {
      this.finish(error.code === 'TIMEOUT' ? 'timeout' : 'cancelled', error)
    } catch (error) {
      this.logError(this.id, error instanceof Error ? error.name : 'Error')
    }
  }

  cancel(): void {
    if (!this.finished) this.controller.abort(new DOMException('AI stream closed', 'AbortError'))
  }

  private cancelError(): AiError {
    const reason: unknown = this.signal?.reason
    return new AiError(reason instanceof Error && reason.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED')
  }

  body(column: 'input' | 'output', value: unknown): void {
    if (this.capture && !this.finished)
      this.audit.content(this.id, column, capturedText(value, this.key), this.startedAt + dayMs)
  }

  success<Result extends ProviderResult>(
    result: Result,
    modelId: string,
    output: unknown,
  ): Result & AiResult {
    this.signal?.throwIfAborted()
    this.progress(result.usage, result.upstreamModel)
    this.body('output', output)
    this.finish('succeeded')
    return { ...result, upstreamModel: this.safeModel(result.upstreamModel), requestId: this.id, modelId }
  }

  failure(cause: unknown): AiError {
    let error: AiError
    if (this.signal?.aborted) error = this.cancelError()
    else if (cause instanceof AiError) error = cause
    else if (this.phase === 'upstream' && this.transport !== undefined) error = this.transport.error(cause)
    else {
      this.logError(this.id, cause instanceof Error ? cause.name : 'Error')
      error = new AiError('INTERNAL')
    }
    const status =
      error.code === 'TIMEOUT'
        ? 'timeout'
        : error.code === 'CANCELLED'
          ? 'cancelled'
          : error.code === 'INVALID_INPUT' || this.phase === 'selection'
            ? 'rejected'
            : 'failed'
    this.finish(status, error)
    return error.forRequest(this.id)
  }

  private safeModel(name: string): string {
    return (this.key ? name.replaceAll(this.key, '[已隐藏]') : name).slice(0, 250)
  }

  private finish(status: FinishedState, error?: AiError): void {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timeout)
    this.signal?.removeEventListener('abort', this.onAbort)
    this.audit.finish(this.id, {
      status,
      error,
      durationMs: Math.round(performance.now() - this.started),
      upstreamModel: this.upstreamModel,
      usage: this.usage,
    })
  }
}

function withoutSignature({ continuation: _continuation, ...call }: AiToolCall) {
  return call
}

function chatBody(options: AiGenerateOptions) {
  const { system, messages } = options
  return {
    system,
    messages: messages.map((message) =>
      message.role === 'assistant'
        ? { ...message, toolCalls: message.toolCalls?.map(withoutSignature) }
        : message,
    ),
  }
}

function chatResult(result: WithoutRequest<AiGenerateResult>) {
  return { text: result.text, toolCalls: result.toolCalls.map(withoutSignature), output: result.output }
}

export class Gateway {
  private readonly http: HttpService
  private readonly signal: AbortSignal
  private readonly catalog: Catalog
  private readonly audit: Audit
  private readonly logError: LogError

  constructor(
    context: Pick<Context, 'signal' | 'logger'>,
    http: HttpService,
    catalog: Catalog,
    audit: Audit,
  ) {
    this.http = http
    this.signal = context.signal
    this.catalog = catalog
    this.audit = audit
    const logger = context.logger
    this.logError = (requestId, errorName) =>
      logger.error({ requestId, errorName }, 'AI request bookkeeping failed')
  }

  bind(consumer: ServiceConsumer): AiService {
    return this.service(
      { source: consumer.plugin, signal: consumer.signal, event: consumer.event },
      'request',
    )
  }

  panel(signal: AbortSignal): AiService {
    return this.service({ source: panelSource, signal, event: () => undefined }, 'test')
  }

  private begin(scope: Scope, capability: Capability, mode: RequestRecord['mode']): Call {
    this.active(scope)
    return new Call(this.audit, this.catalog, scope, capability, mode, this.logError)
  }

  private active(scope: Scope): void {
    if (this.signal.aborted || scope.signal.aborted) throw new AiError('CANCELLED')
  }

  private connect(
    call: Call,
    scope: Scope,
    capability: Capability,
    input: AiCallOptions,
    required: Feature[],
  ): { target: Target; transport: providers.Transport } {
    const target = this.catalog.resolve(scope.source, capability, input.modelId)
    this.audit.target(call.id, target)
    if (![capability, ...required].every((item) => target.model.capabilities.includes(item)))
      throw new AiError('CAPABILITY_UNSUPPORTED')
    const key = this.catalog.secret(target.channel)
    return {
      target,
      transport: call.connect(this.http, target, key, [
        this.signal,
        scope.signal,
        ...(input.signal ? [input.signal] : []),
      ]),
    }
  }

  private service(scope: Scope, mode: 'request' | 'test'): AiService {
    const run = async <Input extends AiCallOptions, Result extends ProviderResult>(
      capability: Capability,
      validate: () => Input,
      required: (input: Input) => Feature[],
      provider: (
        target: Target,
        transport: providers.Transport,
        input: Input,
        progress: Call['progress'],
      ) => Promise<Result>,
      captureInput: (input: Input) => unknown,
      captureOutput: (result: Result) => unknown,
    ): Promise<Result & AiResult> => {
      const call = this.begin(scope, capability, mode)
      try {
        const input = validate()
        const { target, transport } = this.connect(call, scope, capability, input, required(input))
        call.body('input', captureInput(input))
        const result = await provider(target, transport, input, call.progress)
        return call.success(result, target.model.id, captureOutput(result))
      } catch (error) {
        throw call.failure(error)
      }
    }

    return Object.freeze<AiService>({
      listModels: ({ capability } = {}) => {
        this.active(scope)
        if (capability !== undefined && ![...capabilities, ...features].includes(capability))
          throw new AiError('INVALID_INPUT')
        return this.catalog.listModels(scope.source, capability)
      },
      generate: (opts) =>
        run('chat', () => checkedChat(opts), chatFeatures, providers.text, chatBody, chatResult),
      stream: (opts) => this.stream(scope, opts),
      generateImage: (opts) =>
        run(
          'image',
          () => {
            parse(imageInput, opts)
            return opts
          },
          () => [],
          providers.image,
          ({ prompt, size, aspectRatio, count }) => ({ prompt, size, aspectRatio, count }),
          ({ images }) => ({
            images: images.map(({ mediaType, data }) => ({ mediaType, bytes: data.length })),
          }),
        ),
      synthesizeSpeech: (opts) =>
        run(
          'speech',
          () => parse(speechInput, opts),
          () => [],
          providers.speech,
          ({ text, voice }) => ({ text, voice }),
          ({ audio }) => ({ mediaType: audio.mediaType, bytes: audio.data.length }),
        ),
      decide: (opts) =>
        run(
          'decision',
          () => parse(decisionInput, opts),
          () => [],
          providers.decision,
          ({ state, questions }) => ({ state, questions }),
          ({ answers }) => answers,
        ),
    })
  }

  private async *stream(scope: Scope, opts: AiGenerateOptions) {
    const call = this.begin(scope, 'chat', 'stream')
    try {
      const input = checkedChat(opts)
      const { target, transport } = this.connect(call, scope, 'chat', input, [
        'stream',
        ...chatFeatures(input),
      ])
      call.body('input', chatBody(input))
      for await (const event of providers.textStream(target, transport, input, call.progress)) {
        transport.signal.throwIfAborted()
        if (event.type === 'finish') {
          yield {
            type: 'finish' as const,
            result: call.success(event.result, target.model.id, chatResult(event.result)),
          }
          return
        }
        yield event
      }
      throw new AiError('UPSTREAM_OUTPUT')
    } catch (error) {
      throw call.failure(error)
    } finally {
      call.cancel()
    }
  }
}

function checkedChat(options: AiGenerateOptions): AiGenerateOptions {
  parse(chatInput, options)
  return options
}

function chatFeatures(input: AiGenerateOptions): Feature[] {
  const required: Feature[] = []
  if (
    input.messages.some(
      (message) =>
        message.role === 'user' &&
        typeof message.content !== 'string' &&
        message.content.some((item) => item.type === 'image'),
    )
  )
    required.push('vision')
  if (
    (input.tools && Object.keys(input.tools).length > 0) ||
    input.messages.some(
      (message) => message.role === 'tool' || (message.role === 'assistant' && message.toolCalls?.length),
    )
  )
    required.push('tools')
  if (input.outputSchema) required.push('structured')
  return required
}
