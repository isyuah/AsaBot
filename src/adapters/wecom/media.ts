import { randomUUID } from 'node:crypto'
import { decryptFile, type SendMediaMsgBody, type WeComMediaType } from '@wecom/aibot-node-sdk'
import { z } from 'zod'
import { type KnownSegment, seg } from '../../core/message/index.ts'
import { base64Media, localMedia, mediaName, remoteMedia } from '../media-source.ts'
import type { WecomTransport } from './transport.ts'

type MediaKind = 'image' | 'file' | 'video' | 'audio'
export type MediaSegment = Extract<KnownSegment, { type: MediaKind }>

export const attachmentSchema = z.object({
  url: z.string().min(1).max(8192),
  aeskey: z.string().regex(/^[A-Za-z0-9+/]{43}=?$/),
  filename: z.string().max(256).optional(),
})
type Attachment = z.output<typeof attachmentSchema>
type Reference = { attachment: Attachment; expiresAt: number }

const prefix = 'wecom-media:'
const lifetime = 5 * 60_000
const timeout = 30_000
const maxReferences = 2048
const mib = 1024 * 1024
const maxBytes: Record<MediaKind, number> = {
  image: 10 * mib,
  video: 10 * mib,
  audio: 2 * mib,
  file: 20 * mib,
}

function safeName(value: string | undefined, limit: number): string | undefined {
  let result = ''
  let size = 0
  for (const character of mediaName(value)
    ?.replace(/[\r\n]/g, '')
    .replaceAll('\0', '') ?? '') {
    size += Buffer.byteLength(character)
    if (size > limit) break
    result += character
  }
  return result || undefined
}

function extension(kind: MediaKind, bytes: Buffer): string {
  switch (kind) {
    case 'image':
      if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png'
      if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'jpg'
      if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'gif'
      throw new Error('企业微信图片仅支持 PNG、JPEG 或 GIF')
    case 'audio':
      if (/^#!AMR(?:-WB)?\n/.test(bytes.toString('ascii', 0, 9))) return 'amr'
      throw new Error('企业微信语音仅支持 AMR')
    case 'video':
      if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'mp4'
      throw new Error('企业微信视频仅支持 MP4')
    case 'file':
      return 'bin'
  }
}

function fileName(kind: MediaKind, bytes: Buffer, sourceName: string | undefined): string {
  const format = extension(kind, bytes)
  if (kind === 'file') return safeName(sourceName, 256) ?? `file.${format}`
  const stem = safeName(sourceName?.replace(/\.[^./\\]+$/, ''), 255 - format.length) ?? kind
  return `${stem}.${format}`
}

export class WecomMedia {
  readonly #references = new Map<string, Reference>()
  readonly #shutdown: AbortSignal

  constructor(shutdown: AbortSignal) {
    this.#shutdown = shutdown
    shutdown.addEventListener('abort', () => this.#references.clear(), { once: true })
  }

  remember(kind: Exclude<MediaKind, 'audio'>, attachment: Attachment, now: number): MediaSegment {
    for (const [handle, reference] of this.#references) {
      if (reference.expiresAt > now) break
      this.#references.delete(handle)
    }
    const handle = `${prefix}${randomUUID()}`
    this.#references.set(handle, { attachment, expiresAt: now + lifetime })
    const oldest = this.#references.keys().next()
    if (this.#references.size > maxReferences && !oldest.done) this.#references.delete(oldest.value)
    return kind === 'file'
      ? seg.file(handle, { name: safeName(attachment.filename, 256) })
      : seg[kind](handle)
  }

  async download(handle: string, limit = maxBytes.file): Promise<Buffer> {
    const reference = this.#references.get(handle)
    if (!reference || reference.expiresAt <= Date.now()) {
      this.#references.delete(handle)
      throw new Error('企业微信媒体已过期或不属于此机器人')
    }
    const signal = AbortSignal.any([this.#shutdown, AbortSignal.timeout(timeout)])
    try {
      const url = new URL(reference.attachment.url)
      if (url.protocol !== 'https:' || url.port || url.hash) throw new Error('媒体地址不受信任')
      const encrypted = await remoteMedia(url, signal, limit + 32)
      if (encrypted.length % 32 !== 0) throw new Error('媒体密文长度错误')
      const bytes = decryptFile(encrypted, reference.attachment.aeskey)
      if (!bytes.length || bytes.length > limit) throw new Error('媒体超过大小限制或内容为空')
      return bytes
    } catch {
      throw new Error(
        signal.aborted
          ? '企业微信媒体下载已取消或超时'
          : '企业微信媒体下载或解密失败，请检查地址、有效期和大小',
      )
    }
  }

  async upload(segment: MediaSegment, transport: WecomTransport) {
    const limit = maxBytes[segment.type]
    const signal = AbortSignal.any([this.#shutdown, AbortSignal.timeout(timeout)])
    const source = segment.data.file
    let bytes: Buffer
    let sourceName: string | undefined
    if (source.startsWith(prefix)) bytes = await this.download(source, limit)
    else {
      try {
        if (source.startsWith('base64://')) bytes = base64Media(source.slice(9), limit)
        else {
          const url = new URL(source)
          sourceName = decodeURIComponent(url.pathname)
          bytes =
            url.protocol === 'file:'
              ? await localMedia(url, signal, limit)
              : await remoteMedia(url, signal, limit)
        }
      } catch {
        throw new Error(
          signal.aborted ? '企业微信媒体读取已取消或超时' : '无法读取企业微信待发送媒体，请检查来源及大小',
        )
      }
    }
    if (bytes.length < 5 || bytes.length > limit)
      throw new Error(`企业微信${segment.type}素材大小须在 5 字节至 ${limit / mib} MiB 之间`)
    const filename = fileName(
      segment.type,
      bytes,
      segment.type === 'file' ? (segment.data.name ?? sourceName) : sourceName,
    )
    const kind: WeComMediaType = segment.type === 'audio' ? 'voice' : segment.type
    this.#shutdown.throwIfAborted()
    const mediaId = await transport.upload(bytes, { type: kind, filename })
    const body: SendMediaMsgBody = { msgtype: kind, [kind]: { media_id: mediaId } }
    const handle = source.startsWith(prefix) ? source : `wecom-sent:${randomUUID()}`
    const message = [
      segment.type === 'file' ? seg.file(handle, { name: filename }) : seg[segment.type](handle),
    ]
    return { body, message }
  }
}
