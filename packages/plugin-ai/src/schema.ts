import { z } from '@asabot/core'
import { capabilities, features, protocols, requestStates } from './contracts.ts'
import { AiError } from './errors.ts'

export const id = z.uuid()
export const pluginName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/)
  .max(100)
export const panelSource = '@panel'
export const sourceName = z.union([pluginName, z.literal(panelSource)])
export const dayMs = 86_400_000
const displayName = z.string().trim().min(1).max(100)
const jsonObject = z.record(z.string(), z.json())
const decisionEntry = z.union([z.string(), jsonObject, z.array(z.json()), z.null()])

const baseUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .transform((value, context) => {
    const parsed = new URL(value)
    if (parsed.username || parsed.password || parsed.search || parsed.hash || /[?#]/.test(value)) {
      context.addIssue({ code: 'custom', message: 'Base URL 不可包含用户名、密码、查询字符串或锚点' })
      return z.NEVER
    }
    return parsed.href.replace(/\/+$/, '')
  })

export const channelDraft = z.strictObject({
  name: displayName,
  protocol: z.enum(protocols),
  baseUrl,
  timeoutMs: z.number().int().min(1000).max(600_000),
  enabled: z.boolean(),
  credential: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('none') }),
      z.strictObject({
        kind: z.literal('env'),
        variable: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .max(128),
      }),
      z.strictObject({
        kind: z.literal('key'),
        value: z
          .string()
          .trim()
          .min(1)
          .max(8192)
          .regex(/^[\x21-\x7e]+$/),
      }),
    ])
    .optional(),
})

export const modelDraft = z.strictObject({
  name: displayName,
  channelId: id,
  upstreamModel: z
    .string()
    .trim()
    .min(1)
    .max(250)
    .regex(/^[A-Za-z\d_@:./-]+$/)
    .refine((model) => !model.split('/').some((part) => part === '.' || part === '..' || !part)),
  enabled: z.boolean(),
  capabilities: z
    .array(z.enum([...capabilities, ...features]))
    .min(1)
    .max(capabilities.length + features.length),
})

export const defaultDraft = z.partialRecord(z.enum(capabilities), id)
export const policyDraft = z.strictObject({
  defaults: defaultDraft,
  allowlist: z.array(id).max(500).nullable(),
})

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(value)
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  })

const queryFilters = {
  from: day.optional(),
  to: day.optional(),
  source: sourceName.optional(),
  channelId: id.optional(),
  modelId: id.optional(),
  capability: z.enum(capabilities).optional(),
  status: z.enum(requestStates).optional(),
}

const validRange = (value: { from?: string; to?: string }) =>
  value.from === undefined || value.to === undefined || value.from <= value.to
export const requestQuery = z
  .strictObject({
    ...queryFilters,
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .refine(validRange)

export const usageQuery = z
  .strictObject({
    ...queryFilters,
    groupBy: z.enum(['source', 'channel', 'model', 'capability']).default('source'),
  })
  .refine(validRange)

const callOptions = { modelId: id.optional(), signal: z.instanceof(AbortSignal).optional() }
const nonEmpty = z.string().min(1).max(150_000)
const toolName = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(64)
const toolCallId = z.string().min(1).max(256)
const imagePart = z.strictObject({
  type: z.literal('image'),
  data: z
    .instanceof(Uint8Array)
    .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= 10 * 1024 * 1024),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
})
const message = z.discriminatedUnion('role', [
  z.strictObject({
    role: z.literal('user'),
    content: z.union([
      nonEmpty,
      z
        .array(
          z.discriminatedUnion('type', [
            z.strictObject({ type: z.literal('text'), text: nonEmpty }),
            imagePart,
          ]),
        )
        .min(1)
        .max(32),
    ]),
  }),
  z.strictObject({
    role: z.literal('assistant'),
    content: nonEmpty.optional(),
    toolCalls: z
      .array(
        z.strictObject({
          id: toolCallId,
          name: toolName,
          input: z.json(),
          continuation: z.strictObject({ modelId: id, signature: z.string().max(64_000) }).optional(),
        }),
      )
      .min(1)
      .max(64)
      .optional(),
  }),
  z.strictObject({
    role: z.literal('tool'),
    toolCallId,
    toolName,
    output: z.json(),
    isError: z.boolean().optional(),
  }),
])

export const chatInput = z
  .strictObject({
    ...callOptions,
    system: nonEmpty.optional(),
    messages: z.array(message).min(1).max(200),
    maxOutputTokens: z.number().int().positive().max(256_000).optional(),
    tools: z
      .record(
        toolName,
        z.strictObject({ description: z.string().max(8000).optional(), inputSchema: jsonObject }),
      )
      .optional(),
    outputSchema: jsonObject.optional(),
  })
  .refine((options) => {
    let images = 0
    const serializable = options.messages.map((item) => {
      if (item.role !== 'user' || typeof item.content === 'string') return item
      return item.content.map((part) => {
        if (part.type === 'text') return part.text
        images += part.data.byteLength
        return part.mediaType
      })
    })
    return (
      images <= 10 * 1024 * 1024 &&
      JSON.stringify([serializable, options.system, options.tools, options.outputSchema]).length <= 512_000 &&
      options.messages.every(
        (item) => item.role !== 'assistant' || item.content !== undefined || item.toolCalls !== undefined,
      )
    )
  })

export const imageInput = z.strictObject({
  ...callOptions,
  prompt: nonEmpty.max(32_000),
  count: z.number().int().min(1).max(4).optional(),
  size: z
    .string()
    .regex(/^[1-9]\d{0,4}x[1-9]\d{0,4}$/)
    .optional(),
  aspectRatio: z
    .string()
    .regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/)
    .optional(),
})
export const speechInput = z.strictObject({
  ...callOptions,
  text: nonEmpty.max(40_000),
  voice: displayName.optional(),
})
const question = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('noul'),
    instructions: decisionEntry.optional(),
    criteria: z.strictObject({ true: decisionEntry.optional(), false: decisionEntry.optional() }).optional(),
  }),
  z.strictObject({
    type: z.literal('choice'),
    instructions: decisionEntry.optional(),
    criteria: z
      .record(z.string().min(1).max(100), decisionEntry)
      .refine((value) => Object.keys(value).length >= 2),
  }),
  z.strictObject({
    type: z.literal('score'),
    instructions: decisionEntry.optional(),
    criteria: z.array(decisionEntry).min(2),
  }),
])
export const decisionInput = z
  .strictObject({
    ...callOptions,
    state: z.union([z.string(), jsonObject, z.array(z.json())]),
    questions: z.record(z.string().min(1).max(128), question),
  })
  .refine((options) => {
    const count = Object.keys(options.questions).length
    return count > 0 && count <= 100 && JSON.stringify([options.state, options.questions]).length <= 512_000
  })

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new AiError('INVALID_INPUT')
  return parsed.data
}

export function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}
