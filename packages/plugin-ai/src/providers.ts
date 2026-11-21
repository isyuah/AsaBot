import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { type HttpService, z } from '@asabot/core'
import {
  APICallError,
  type AssistantModelMessage,
  generateImage,
  generateSpeech,
  generateText,
  InvalidResponseDataError,
  type JSONSchema7,
  jsonSchema,
  type LanguageModelUsage,
  type ModelMessage,
  NoContentGeneratedError,
  NoImageGeneratedError,
  NoObjectGeneratedError,
  Output,
  streamText,
  type ToolSet,
  TypeValidationError,
} from 'ai'
import { Ajv } from 'ajv'
import type { Target } from './catalog.ts'
import type {
  AiDecisionOptions,
  AiDecisionResult,
  AiGenerateOptions,
  AiGenerateResult,
  AiImageOptions,
  AiImageResult,
  AiMessage,
  AiSpeechOptions,
  AiSpeechResult,
  AiStreamEvent,
  AiToolCall,
  AiUsage,
  ChannelSettings,
  DiscoveredModel,
  JsonObject,
  Protocol,
} from './contracts.ts'
import { AiError, upstreamError } from './errors.ts'

type WithoutRequest<Result> = Omit<Result, 'requestId' | 'modelId'>
type ProviderEvent =
  | Exclude<AiStreamEvent, { type: 'finish' }>
  | { type: 'finish'; result: WithoutRequest<AiGenerateResult> }
type Progress = (usage: AiUsage, upstreamModel?: string) => void

export class Transport {
  private readonly base: URL
  private readonly channel: ChannelSettings
  private readonly key?: string
  private readonly http: HttpService
  readonly signal: AbortSignal
  private status?: number

  constructor(http: HttpService, channel: ChannelSettings, key: string | undefined, signal: AbortSignal) {
    this.http = http
    this.channel = channel
    this.base = new URL(channel.baseUrl)
    this.key = key
    this.signal = signal
  }

  readonly fetch: typeof fetch = async (input, options) => {
    if (input instanceof Request) throw new AiError('UPSTREAM_REQUEST')
    const url = new URL(input)
    const prefix = this.base.pathname.replace(/\/$/, '')
    if (
      url.origin !== this.base.origin ||
      url.username ||
      url.password ||
      !url.pathname.startsWith(`${prefix}/`)
    )
      throw new AiError('UPSTREAM_REQUEST')
    const headers = new Headers(options?.headers)
    if (this.key === undefined) {
      for (const header of ['authorization', 'x-api-key', 'x-goog-api-key']) headers.delete(header)
    }
    const signal = options?.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal
    this.status = undefined
    const response = await this.http.fetch(url, {
      ...options,
      headers,
      signal,
      redirect: 'error',
      timeout: this.channel.timeoutMs,
      maxSize: 32 * 1024 * 1024,
    })
    this.status = response.status
    return response
  }

  sdkOptions() {
    return { baseURL: this.channel.baseUrl, apiKey: this.key ?? 'asabot-no-key', fetch: this.fetch }
  }

  async json(path: string, body?: object): Promise<unknown> {
    const headers = new Headers({ Accept: 'application/json' })
    if (body !== undefined) headers.set('content-type', 'application/json')
    if (this.key !== undefined) {
      switch (this.channel.protocol) {
        case 'anthropic':
          headers.set('x-api-key', this.key)
          break
        case 'gemini':
          headers.set('x-goog-api-key', this.key)
          break
        default:
          headers.set('authorization', `Bearer ${this.key}`)
      }
    }
    if (this.channel.protocol === 'anthropic') headers.set('anthropic-version', '2023-06-01')
    const response = await this.fetch(
      `${this.channel.baseUrl}${path}`,
      body === undefined ? { headers } : { headers, method: 'POST', body: JSON.stringify(body) },
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw upstreamError(response.status)
    }
    try {
      return await response.json()
    } catch (error) {
      this.signal.throwIfAborted()
      if (error instanceof SyntaxError) throw new AiError('UPSTREAM_OUTPUT')
      throw error
    }
  }

  error(error: unknown): AiError {
    if (error instanceof AiError) return error
    if (
      NoObjectGeneratedError.isInstance(error) ||
      NoImageGeneratedError.isInstance(error) ||
      NoContentGeneratedError.isInstance(error) ||
      InvalidResponseDataError.isInstance(error) ||
      TypeValidationError.isInstance(error)
    )
      return new AiError('UPSTREAM_OUTPUT')
    const status = APICallError.isInstance(error) ? error.statusCode : this.status
    return status !== undefined && status >= 200 && status < 300
      ? new AiError('UPSTREAM_OUTPUT')
      : upstreamError(status)
  }
}

const ajv = new Ajv({
  strict: false,
  validateFormats: false,
  addUsedSchema: false,
  ownProperties: true,
  logger: false,
})
const jsonValue = z.json()

function validatedSchema(schema: JSONSchema7) {
  try {
    const validate = ajv.compile<JsonObject>(schema)
    if ('$async' in validate) throw new AiError('INVALID_INPUT')
    return jsonSchema<JsonObject>(schema, {
      validate: async (value) => {
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && validate(value))
          return { success: true, value }
        return { success: false, error: new AiError('UPSTREAM_OUTPUT') }
      },
    })
  } catch {
    throw new AiError('INVALID_INPUT', { message: '工具或结构化输出的 JSON Schema 无效' })
  } finally {
    ajv.removeSchema(schema)
  }
}

function messageForSdk(message: AiMessage, target: Target): ModelMessage {
  switch (message.role) {
    case 'user':
      return {
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) =>
                part.type === 'text' ? part : { type: 'file', data: part.data, mediaType: part.mediaType },
              ),
      }
    case 'assistant': {
      const content: Exclude<AssistantModelMessage['content'], string> = []
      if (message.content !== undefined) content.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        const signature =
          target.channel.protocol === 'gemini' && call.continuation?.modelId === target.model.id
            ? call.continuation.signature
            : undefined
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
          ...(signature ? { providerOptions: { google: { thoughtSignature: signature } } } : {}),
        })
      }
      return { role: 'assistant', content }
    }
    case 'tool':
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: { type: message.isError ? 'error-json' : 'json', value: message.output },
          },
        ],
      }
  }
}

function observed(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function tokenUsage(usage: LanguageModelUsage, protocol: Protocol): AiUsage {
  const { raw } = usage
  if (!raw) return {}
  const count = (key: string, field?: string) => {
    const value = raw[key]
    if (field === undefined) return observed(value)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    return observed(Object.getOwnPropertyDescriptor(value, field)?.value)
  }
  switch (protocol) {
    case 'openai-chat':
      return {
        inputTokens: count('prompt_tokens'),
        outputTokens: count('completion_tokens'),
        cachedInputTokens: count('prompt_tokens_details', 'cached_tokens'),
        reasoningTokens: count('completion_tokens_details', 'reasoning_tokens'),
      }
    case 'openai-responses':
      return {
        inputTokens: count('input_tokens'),
        outputTokens: count('output_tokens'),
        cachedInputTokens: count('input_tokens_details', 'cached_tokens'),
        reasoningTokens: count('output_tokens_details', 'reasoning_tokens'),
      }
    case 'anthropic':
      return {
        inputTokens: count('input_tokens') === undefined ? undefined : observed(usage.inputTokens),
        outputTokens: count('output_tokens') === undefined ? undefined : observed(usage.outputTokens),
        cachedInputTokens: count('cache_read_input_tokens'),
        reasoningTokens: count('output_tokens_details', 'thinking_tokens'),
      }
    case 'gemini': {
      const reasoningTokens = count('thoughtsTokenCount')
      return {
        inputTokens: count('promptTokenCount') === undefined ? undefined : observed(usage.inputTokens),
        outputTokens:
          count('candidatesTokenCount') === undefined && reasoningTokens === undefined
            ? undefined
            : observed(usage.outputTokens),
        cachedInputTokens: count('cachedContentTokenCount'),
        reasoningTokens,
      }
    }
    case 'system-one':
      throw new AiError('CAPABILITY_UNSUPPORTED')
  }
}

function toolCall(
  part: {
    toolCallId: string
    toolName: string
    input: unknown
    providerMetadata?: { google?: { thoughtSignature?: unknown } }
  },
  target: Target,
): AiToolCall {
  const parsed = jsonValue.safeParse(part.input)
  if (!parsed.success) throw new AiError('UPSTREAM_OUTPUT')
  const signature = part.providerMetadata?.google?.thoughtSignature
  return {
    id: part.toolCallId,
    name: part.toolName,
    input: parsed.data,
    ...(typeof signature === 'string' && signature.length <= 64_000
      ? { continuation: { modelId: target.model.id, signature } }
      : {}),
  }
}

function checkFinish(reason: string): void {
  if (reason === 'error' || reason === 'content-filter' || reason === 'interrupted')
    throw new AiError('UPSTREAM_OUTPUT')
}

function chatOptions(target: Target, transport: Transport, input: AiGenerateOptions) {
  const { protocol } = target.channel
  const name = target.model.upstreamModel
  const options = transport.sdkOptions()
  const model =
    protocol === 'anthropic'
      ? createAnthropic(options)(name)
      : protocol === 'gemini'
        ? createGoogleGenerativeAI(options).chat(googleName(name))
        : protocol === 'openai-chat'
          ? createOpenAI(options).chat(name)
          : createOpenAI(options).responses(name)
  const tools: ToolSet | undefined =
    input.tools &&
    Object.fromEntries(
      Object.entries(input.tools).map(([key, value]) => [
        key,
        { description: value.description, inputSchema: validatedSchema(value.inputSchema) },
      ]),
    )
  return {
    model,
    system: input.system,
    messages: input.messages.map((message) => messageForSdk(message, target)),
    maxOutputTokens: input.maxOutputTokens,
    tools,
    output: input.outputSchema && Output.object({ schema: validatedSchema(input.outputSchema) }),
    providerOptions: protocol === 'openai-responses' ? { openai: { store: false } } : undefined,
    abortSignal: transport.signal,
    maxRetries: 0,
  }
}

export async function text(
  target: Target,
  transport: Transport,
  input: AiGenerateOptions,
  progress: Progress,
): Promise<WithoutRequest<AiGenerateResult>> {
  const result = await generateText(chatOptions(target, transport, input))
  const usage = tokenUsage(result.totalUsage, target.channel.protocol)
  const upstreamModel = result.response.modelId || target.model.upstreamModel
  progress(usage, upstreamModel)
  checkFinish(result.finishReason)
  const toolCalls = result.toolCalls.map((item) => toolCall(item, target))
  return {
    text: result.text,
    finishReason: result.finishReason,
    toolCalls,
    usage,
    upstreamModel,
    ...(input.outputSchema && toolCalls.length === 0 ? { output: result.output } : {}),
  }
}

export async function* textStream(
  target: Target,
  transport: Transport,
  input: AiGenerateOptions,
  progress: Progress,
): AsyncGenerator<ProviderEvent> {
  let streamError: unknown
  const result = streamText({
    ...chatOptions(target, transport, input),
    streamRetries: 0,
    onError: ({ error }) => {
      streamError = error
    },
  })
  let finished = false
  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        yield { type: 'text-delta', text: part.text }
        break
      case 'tool-call':
        yield { type: 'tool-call', call: toolCall(part, target) }
        break
      case 'finish-step':
        progress(tokenUsage(part.usage, target.channel.protocol), part.response.modelId)
        break
      case 'finish':
        finished = true
        break
      case 'error':
        throw transport.error(part.error)
      case 'abort':
        transport.signal.throwIfAborted()
        throw new AiError('CANCELLED')
    }
  }
  transport.signal.throwIfAborted()
  if (streamError !== undefined) throw transport.error(streamError)
  if (!finished) throw new AiError('UPSTREAM_OUTPUT')
  const [content, finishReason, totalUsage, response, calls] = await Promise.all([
    result.text,
    result.finishReason,
    result.totalUsage,
    result.response,
    result.toolCalls,
  ])
  checkFinish(finishReason)
  const toolCalls = calls.map((item) => toolCall(item, target))
  yield {
    type: 'finish',
    result: {
      text: content,
      finishReason,
      toolCalls,
      usage: tokenUsage(totalUsage, target.channel.protocol),
      upstreamModel: response.modelId || target.model.upstreamModel,
      ...(input.outputSchema && toolCalls.length === 0 ? { output: await result.output } : {}),
    },
  }
}

function googleName(name: string): string {
  return name.replace(/^models\//, '')
}

export async function image(
  target: Target,
  transport: Transport,
  input: AiImageOptions,
  progress: Progress,
): Promise<WithoutRequest<AiImageResult>> {
  const name = target.model.upstreamModel
  const model =
    target.channel.protocol === 'gemini'
      ? createGoogleGenerativeAI(transport.sdkOptions()).image(googleName(name))
      : createOpenAI(transport.sdkOptions()).image(name)
  const count = input.count ?? 1
  const result = await generateImage({
    model,
    prompt: input.prompt,
    n: count,
    maxImagesPerCall: count,
    size: input.size,
    aspectRatio: input.aspectRatio,
    abortSignal: transport.signal,
    maxRetries: 0,
  })
  const usage = {
    inputTokens: observed(result.usage.inputTokens),
    outputTokens: observed(result.usage.outputTokens),
    images: result.images.length,
  }
  const upstreamModel = result.calls[0]?.response.modelId || name
  progress(usage, upstreamModel)
  const images = result.images.map((item) => ({
    mediaType: item.mediaType,
    data: Buffer.from(item.uint8Array),
  }))
  if (
    images.length === 0 ||
    images.some(
      (item) =>
        !item.data.length || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.mediaType),
    )
  )
    throw new AiError('UPSTREAM_OUTPUT')
  return { images, upstreamModel, usage }
}

function wavSeconds(buffer: Buffer): number | undefined {
  if (
    buffer.length < 12 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  )
    return undefined
  let bytesPerSecond = 0
  let dataLength = 0
  for (let offset = 12; offset + 8 <= buffer.length; ) {
    const kind = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (offset + 8 + size > buffer.length) return undefined
    if (kind === 'fmt ' && size >= 16) bytesPerSecond = buffer.readUInt32LE(offset + 16)
    if (kind === 'data') dataLength += size
    offset += 8 + size + (size % 2)
  }
  return bytesPerSecond > 0 && dataLength > 0 ? dataLength / bytesPerSecond : undefined
}

const speechUsage = z.object({
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      cachedContentTokenCount: z.number().optional(),
    })
    .nullish(),
})

export async function speech(
  target: Target,
  transport: Transport,
  input: AiSpeechOptions,
  progress: Progress,
): Promise<WithoutRequest<AiSpeechResult>> {
  const name = target.model.upstreamModel
  const google = target.channel.protocol === 'gemini'
  const model = google
    ? createGoogleGenerativeAI(transport.sdkOptions()).speech(googleName(name))
    : createOpenAI(transport.sdkOptions()).speech(name)
  const result = await generateSpeech({
    model,
    text: input.text,
    voice: input.voice ?? (google ? 'Kore' : 'alloy'),
    outputFormat: 'wav',
    abortSignal: transport.signal,
    maxRetries: 0,
  })
  const data = Buffer.from(result.audio.uint8Array)
  if (!data.length) throw new AiError('UPSTREAM_OUTPUT')
  const metadata = google ? speechUsage.safeParse(result.responses[0]?.body).data?.usageMetadata : undefined
  const usage = {
    speechCharacters: [...input.text].length,
    audioSeconds: wavSeconds(data),
    inputTokens: observed(metadata?.promptTokenCount),
    outputTokens: observed(metadata?.candidatesTokenCount),
    cachedInputTokens: observed(metadata?.cachedContentTokenCount),
  }
  const upstreamModel = result.responses[0]?.modelId || name
  progress(usage, upstreamModel)
  return { audio: { data, mediaType: result.audio.mediaType }, upstreamModel, usage }
}

const probability = z.number().min(0).max(1)
const probabilities = z.record(z.string(), probability)
const answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({ type: z.literal('choice'), choice: z.string(), confidence: probability, probabilities }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    confidence: probability,
    probabilities,
    legend: z.record(
      z.string(),
      z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json()), z.null()]),
    ),
  }),
])
const systemOneResponse = z.object({
  model: z.string().min(1).max(250),
  answers: z.record(z.string(), answer),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().nullish(),
      output_tokens: z.number().int().nonnegative().nullish(),
    })
    .nullish(),
})

export async function decision(
  target: Target,
  transport: Transport,
  input: AiDecisionOptions,
  progress: Progress,
): Promise<WithoutRequest<AiDecisionResult>> {
  const raw = await transport.json('/systemone', {
    state: input.state,
    questions: input.questions,
    model: target.model.upstreamModel,
  })
  const result = systemOneResponse.safeParse(raw)
  if (!result.success) throw new AiError('UPSTREAM_OUTPUT')
  const { model: upstreamModel, answers, usage: tokens } = result.data
  const usage: AiUsage = {
    inputTokens: tokens?.input_tokens ?? undefined,
    outputTokens: tokens?.output_tokens ?? undefined,
  }
  progress(usage, upstreamModel)
  const questions = Object.entries(input.questions)
  if (
    Object.keys(answers).length !== questions.length ||
    questions.some(([key, question]) => {
      const value = Object.hasOwn(answers, key) ? answers[key] : undefined
      return (
        value?.type !== question.type ||
        (value.type === 'choice' &&
          question.type === 'choice' &&
          !Object.hasOwn(question.criteria, value.choice))
      )
    })
  )
    throw new AiError('UPSTREAM_OUTPUT')
  return { upstreamModel, answers, usage: { ...usage, decisions: questions.length } }
}

const openaiModels = z.object({ data: z.array(z.object({ id: z.string() })) })
const anthropicModels = z.object({
  data: z.array(z.object({ id: z.string(), display_name: z.string().optional() })),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
})
const geminiModels = z.object({
  models: z.array(z.object({ name: z.string(), displayName: z.string().optional() })).optional(),
  nextPageToken: z.string().optional(),
})

export async function discover(
  transport: Transport,
  protocol: ChannelSettings['protocol'],
): Promise<{ models: DiscoveredModel[]; truncated: boolean }> {
  try {
    const models = new Map<string, DiscoveredModel>()
    const put = (upstreamModel: string, name = upstreamModel) =>
      models.set(upstreamModel, { upstreamModel, name })
    let next: string | undefined
    for (let page = 0; page < 5; page++) {
      switch (protocol) {
        case 'system-one':
          throw new AiError('CATALOG_UNSUPPORTED')
        case 'openai-chat':
        case 'openai-responses':
          for (const item of openaiModels.parse(await transport.json('/models')).data) put(item.id)
          break
        case 'anthropic': {
          const result = anthropicModels.parse(
            await transport.json(`/models?limit=100${next ? `&after_id=${encodeURIComponent(next)}` : ''}`),
          )
          for (const item of result.data) put(item.id, item.display_name)
          next = result.has_more ? (result.last_id ?? undefined) : undefined
          break
        }
        case 'gemini': {
          const result = geminiModels.parse(
            await transport.json(
              `/models?pageSize=100${next ? `&pageToken=${encodeURIComponent(next)}` : ''}`,
            ),
          )
          for (const item of result.models ?? []) put(googleName(item.name), item.displayName)
          next = result.nextPageToken
          break
        }
      }
      if (!next || models.size >= 500) break
    }
    return { models: [...models.values()].slice(0, 500), truncated: Boolean(next) || models.size > 500 }
  } catch (error) {
    if (transport.signal.aborted)
      throw new AiError(transport.signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED')
    throw transport.error(error)
  }
}
