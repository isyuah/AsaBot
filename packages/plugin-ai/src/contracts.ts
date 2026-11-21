import type { JSONSchema7 } from 'ai'

export const protocols = ['openai-chat', 'openai-responses', 'anthropic', 'gemini', 'system-one'] as const
export const capabilities = ['chat', 'image', 'speech', 'decision'] as const
export const features = ['vision', 'stream', 'tools', 'structured'] as const
export const requestStates = [
  'running',
  'succeeded',
  'failed',
  'rejected',
  'timeout',
  'cancelled',
  'interrupted',
] as const

export type Protocol = (typeof protocols)[number]
export type Capability = (typeof capabilities)[number]
export type Feature = (typeof features)[number]
export type RequestState = (typeof requestStates)[number]
export type FinishedState = Exclude<RequestState, 'running'>

const chatFeatures = ['chat', ...features] as const

export const protocolInfo: Record<
  Protocol,
  { name: string; baseUrl: string; supports: readonly (Capability | Feature)[] }
> = {
  'openai-chat': {
    name: 'OpenAI Chat Completions',
    baseUrl: 'https://api.openai.com/v1',
    supports: [...chatFeatures, 'image', 'speech'],
  },
  'openai-responses': {
    name: 'OpenAI Responses',
    baseUrl: 'https://api.openai.com/v1',
    supports: [...chatFeatures, 'image', 'speech'],
  },
  anthropic: { name: 'Anthropic Messages', baseUrl: 'https://api.anthropic.com/v1', supports: chatFeatures },
  gemini: {
    name: 'Gemini 原生',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    supports: [...chatFeatures, 'image', 'speech'],
  },
  'system-one': {
    name: 'TypeSafe AI System One',
    baseUrl: 'https://api.typesafe.ai/v1',
    supports: ['decision'],
  },
}

export interface ChannelSettings {
  name: string
  protocol: Protocol
  baseUrl: string
  timeoutMs: number
  enabled: boolean
}

export type CredentialInput =
  | { kind: 'none' }
  | { kind: 'env'; variable: string }
  | { kind: 'key'; value: string }

export interface ChannelDraft extends ChannelSettings {
  credential?: CredentialInput
}

export interface ChannelView extends ChannelSettings {
  id: string
  credential: { kind: CredentialInput['kind']; status: 'configured' | 'missing' | 'none' }
}

export interface ModelInfo {
  id: string
  name: string
  capabilities: (Capability | Feature)[]
}

export interface ModelDraft extends Omit<ModelInfo, 'id'> {
  upstreamModel: string
  channelId: string
  enabled: boolean
}

export interface ModelView extends ModelDraft {
  id: string
}

export interface DiscoveredModel {
  upstreamModel: string
  name: string
}

export type Defaults = Partial<Record<Capability, string>>

export interface Policy {
  defaults: Defaults
  allowlist: string[] | null
}

export interface CatalogView {
  channels: ChannelView[]
  models: ModelView[]
  defaults: Defaults
  policies: Record<string, Policy>
  consumers: string[]
  capture: { source: string; until: number } | null
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}

export interface AiImagePart {
  type: 'image'
  data: Uint8Array
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

export interface AiToolCall {
  id: string
  name: string
  input: JsonValue
  continuation?: { modelId: string; signature: string }
}

export type AiMessage =
  | { role: 'user'; content: string | ({ type: 'text'; text: string } | AiImagePart)[] }
  | { role: 'assistant'; content?: string; toolCalls?: AiToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; output: JsonValue; isError?: boolean }

export interface AiCallOptions {
  modelId?: string
  signal?: AbortSignal
}

export interface AiGenerateOptions extends AiCallOptions {
  system?: string
  messages: AiMessage[]
  maxOutputTokens?: number
  tools?: Record<string, { description?: string; inputSchema: JSONSchema7 }>
  outputSchema?: JSONSchema7
}

export interface AiImageOptions extends AiCallOptions {
  prompt: string
  count?: number
  size?: `${number}x${number}`
  aspectRatio?: `${number}:${number}`
}

export interface AiSpeechOptions extends AiCallOptions {
  text: string
  voice?: string
}

type DecisionEntry = string | JsonObject | JsonValue[] | null
export type DecisionQuestion =
  | { type: 'noul'; instructions?: DecisionEntry; criteria?: { true?: DecisionEntry; false?: DecisionEntry } }
  | { type: 'choice'; instructions?: DecisionEntry; criteria: Record<string, DecisionEntry> }
  | { type: 'score'; instructions?: DecisionEntry; criteria: DecisionEntry[] }

export interface AiDecisionOptions extends AiCallOptions {
  state: NonNullable<DecisionEntry>
  questions: Record<string, DecisionQuestion>
}

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence?: number; probabilities: Record<string, number> }
  | {
      type: 'score'
      score: number
      confidence?: number
      probabilities: Record<string, number>
      legend: Record<string, DecisionEntry>
    }

export const usageFields = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'reasoningTokens',
  'images',
  'speechCharacters',
  'audioSeconds',
  'decisions',
] as const
export type UsageField = (typeof usageFields)[number]
export type AiUsage = Partial<Record<UsageField, number>>

export interface AiResult {
  requestId: string
  modelId: string
  upstreamModel: string
  usage: AiUsage
}

export interface AiGenerateResult extends AiResult {
  text: string
  finishReason: string
  toolCalls: AiToolCall[]
  output?: JsonObject
}

export type AiStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: AiToolCall }
  | { type: 'finish'; result: AiGenerateResult }

export interface AiMedia {
  data: Buffer
  mediaType: string
}

export interface AiImageResult extends AiResult {
  images: AiMedia[]
}
export interface AiSpeechResult extends AiResult {
  audio: AiMedia
}
export interface AiDecisionResult extends AiResult {
  answers: Record<string, DecisionAnswer>
}

export interface AiService {
  listModels(options?: { capability?: Capability | Feature }): ModelInfo[]
  generate(options: AiGenerateOptions): Promise<AiGenerateResult>
  stream(options: AiGenerateOptions): AsyncIterable<AiStreamEvent>
  generateImage(options: AiImageOptions): Promise<AiImageResult>
  synthesizeSpeech(options: AiSpeechOptions): Promise<AiSpeechResult>
  decide(options: AiDecisionOptions): Promise<AiDecisionResult>
}

export interface QueryFilters {
  from?: string
  to?: string
  source?: string
  channelId?: string
  modelId?: string
  capability?: Capability
  status?: RequestState
}

export interface RequestRecord {
  id: string
  source: string
  capability: Capability
  mode: 'request' | 'stream' | 'test'
  status: RequestState
  startedAt: number
  durationMs?: number
  modelId?: string
  modelName?: string
  channelId?: string
  channelName?: string
  protocol?: Protocol
  upstreamModel?: string
  eventId?: string
  platform?: string
  selfId?: string
  error?: { code: string; message: string; httpStatus?: number }
  usage: AiUsage
}

export interface RequestDetail extends RequestRecord {
  content?: { input?: string; output?: string; expiresAt: number }
}

export interface RequestPage {
  items: RequestRecord[]
  next?: number
}
export type UsageGroup = 'source' | 'channel' | 'model' | 'capability'

export interface UsageTotals {
  requests: number
  succeeded: number
  averageMs: number | null
  usage: Partial<Record<UsageField, { value: number; reported: number }>>
}

export interface UsageReport {
  from: string
  to: string
  total: UsageTotals
  daily: (UsageTotals & { day: string })[]
  groups: (UsageTotals & { key: string; name: string })[]
  moreGroups: boolean
}
