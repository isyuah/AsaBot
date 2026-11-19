import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { botIdentitySchema } from '../../core/identity.ts'
import { limitedBytes } from '../media-source.ts'

export const platform = 'weixin-clawbot'
export const apiOrigin = 'https://ilinkai.weixin.qq.com'
const revision = '2.4.10'
const appHeaders = {
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10),
}
const jsonLimit = 8 * 1024 * 1024

export function ilinkOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.hostname !== 'ilinkai.wechat.com' && !/^(?:ilinkai|idc-\d+)\.weixin\.qq\.com$/.test(url.hostname))
  )
    throw new Error('微信返回了不受信任的 iLink 地址')
  return url.origin
}

export const accountSchema = z.strictObject({
  selfId: botIdentitySchema.shape.selfId.max(512),
  token: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .regex(/^[ -~]+$/)
    .meta({ writeOnly: true }),
  apiBaseUrl: z
    .string()
    .refine((value) => {
      try {
        ilinkOrigin(value)
        return true
      } catch {
        return false
      }
    }, '请使用微信 iLink HTTPS 地址')
    .default(apiOrigin)
    .meta({ writeOnly: true }),
})

export type Account = z.output<typeof accountSchema>

const messageId = z.string().min(1).max(128)
export const cdnSchema = z.object({
  encrypt_query_param: z.string().max(8192).optional(),
  aes_key: z.string().max(128).optional(),
  full_url: z.string().max(8192).optional(),
})
const mediaFields = { media: cdnSchema.optional() }
const contentSchema = z.object({
  type: z.int().optional(),
  msg_id: messageId.optional(),
  text_item: z.object({ text: z.string().max(16_000).optional() }).optional(),
  image_item: z.object({ ...mediaFields, aeskey: z.string().max(128).optional() }).optional(),
  video_item: z.object(mediaFields).optional(),
  file_item: z.object({ ...mediaFields, file_name: z.string().max(1024).optional() }).optional(),
  voice_item: z.object({ ...mediaFields, text: z.string().max(16_000).optional() }).optional(),
})
export const itemSchema = contentSchema.extend({
  ref_msg: z
    .object({
      message_item: contentSchema.optional(),
      svr_id: messageId.optional(),
      title: z.string().max(4096).optional(),
    })
    .optional()
    .catch(undefined),
})
const inboundSchema = z.object({
  message_id: messageId.optional(),
  message_type: z.int().optional(),
  from_user_id: z.string().regex(/^\S+$/).max(512).optional(),
  group_id: z.string().optional(),
  create_time_ms: z.number().optional(),
  context_token: z.string().max(16384).optional(),
  item_list: z.array(z.unknown()).max(128).optional(),
})
export type Inbound = z.output<typeof inboundSchema>
export const updatesSchema = z.object({
  get_updates_buf: z.string().optional(),
  longpolling_timeout_ms: z.int().positive().optional(),
  msgs: z.array(z.unknown()).optional(),
})
export type Item = z.output<typeof itemSchema>

export function readInbound(value: unknown): Inbound | undefined {
  const message = inboundSchema.safeParse(value)
  return message.success && message.data.message_type === 1 && !message.data.group_id
    ? message.data
    : undefined
}

export const sentSchema = z.object({ message_id: messageId.optional() })
export const errorSchema = z.object({ ret: z.int().optional(), errcode: z.int().optional() })
export const uploadSchema = z.object({
  upload_full_url: z.string().max(8192).optional(),
  upload_param: z.string().max(8192).optional(),
})
export const typingSchema = z.object({ typing_ticket: z.string().min(1).max(4096) })

export type IlinkRequest = <T extends z.ZodType>(
  operation: string,
  schema: T,
  data: Record<string, unknown>,
  timeout?: number,
  signal?: AbortSignal,
) => Promise<z.output<T>>

export class IlinkError extends Error {
  readonly expired: boolean
  readonly retryable: boolean
  readonly httpStatus?: number
  readonly platformCode?: number

  constructor(
    operation: string,
    details: string,
    {
      expired = false,
      retryable = false,
      httpStatus,
      platformCode,
    }: { expired?: boolean; retryable?: boolean; httpStatus?: number; platformCode?: number } = {},
  ) {
    super(`微信 ${operation} ${details}`)
    this.expired = expired
    this.retryable = retryable
    this.httpStatus = httpStatus
    this.platformCode = platformCode
  }
}

export async function ilink<T extends z.ZodType>(
  url: URL,
  operation: string,
  schema: T,
  signal: AbortSignal,
  options: { data?: Record<string, unknown>; token?: string; timeout?: number } = {},
): Promise<z.output<T>> {
  const { data, token, timeout = 15_000 } = options
  const deadline = AbortSignal.timeout(timeout)
  const headers = new Headers(appHeaders)
  if (data) {
    headers.set('Content-Type', 'application/json')
    headers.set('AuthorizationType', 'ilink_bot_token')
    headers.set('X-WECHAT-UIN', Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'))
  }
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let bytes: Buffer
  try {
    const response = await fetch(url, {
      method: data ? 'POST' : 'GET',
      redirect: 'error',
      headers,
      signal: AbortSignal.any([signal, deadline]),
      ...(data && {
        body: JSON.stringify(
          token ? { ...data, base_info: { channel_version: revision, bot_agent: 'AsaBot/0.1.0' } } : data,
        ),
      }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      const status = response.status
      throw new IlinkError(operation, `失败（HTTP ${status}）`, {
        expired: !!token && status === 401,
        httpStatus: status,
        retryable: status === 408 || status === 429 || status >= 500,
      })
    }
    bytes = await limitedBytes(response, jsonLimit)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof IlinkError) throw error
    if (deadline.aborted) throw deadline.reason
    throw new IlinkError(operation, '请求失败', { retryable: true })
  }
  let result: unknown
  try {
    result = JSON.parse(
      bytes.toString('utf8'),
      (key: string, value: unknown, context?: { source: string }) =>
        typeof value === 'number' && (key === 'message_id' || key === 'msg_id' || key === 'svr_id')
          ? context?.source
          : value,
    )
  } catch {
    throw new IlinkError(operation, '响应格式不正确')
  }
  const status = errorSchema.safeParse(result)
  if (status.success) {
    const { ret, errcode } = status.data
    if (ret === -14 || errcode === -14)
      throw new IlinkError(operation, '授权已失效，请重新扫码', { expired: true, platformCode: -14 })
    const code = ret || errcode
    if (code) throw new IlinkError(operation, `失败（错误码 ${code}）`, { platformCode: code })
  }
  const parsed = schema.safeParse(result)
  if (!status.success || !parsed.success) throw new IlinkError(operation, '响应格式不正确')
  return parsed.data
}
