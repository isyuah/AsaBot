import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { seg } from '../../core/message/index.ts'
import { base64Media, download, localMedia, mediaName, remoteMedia } from '../media-source.ts'
import { type cdnSchema, type IlinkRequest, uploadSchema } from './protocol.ts'

type CdnMedia = z.output<typeof cdnSchema>
type MediaKind = 'image' | 'video' | 'file' | 'audio'
type MediaSegment = ReturnType<(typeof seg)[MediaKind]>
type OutboundMedia = Exclude<MediaSegment, { type: 'audio' }>

interface MediaReference {
  kind: MediaKind
  ref: CdnMedia
  imageKey?: string
}

const cdnBase = 'https://novac2c.cdn.weixin.qq.com/c2c'
const maxMedia = 25 * 1024 * 1024
const mediaTimeout = 30_000
const maxReferences = 1024
const mediaPrefix = 'weixin-media:'
const uploadTypes = { image: 1, video: 2, file: 3 } as const

function cdnUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !url.hostname.endsWith('.cdn.weixin.qq.com')
  )
    throw new Error('微信返回了不受信任的媒体地址')
  return url
}

function resolveCdnUrl(
  action: 'upload' | 'download',
  full: string | undefined,
  param: string | undefined,
  key?: string,
): URL {
  if (full) return cdnUrl(full)
  if (!param) throw new Error('微信未返回媒体传输地址')
  const url = new URL(`${cdnBase}/${action}`)
  url.searchParams.set('encrypted_query_param', param)
  if (key) url.searchParams.set('filekey', key)
  return url
}

function decodeKey(imageKey: string | undefined, mediaKey: string | undefined): Buffer | undefined {
  const hex = /^[a-f0-9]{32}$/i
  if (imageKey) {
    if (!hex.test(imageKey)) throw new Error('图片加密密钥格式不正确')
    return Buffer.from(imageKey, 'hex')
  }
  if (!mediaKey) return undefined
  const key = Buffer.from(mediaKey, 'base64')
  if (key.toString('base64').replace(/=+$/, '') !== mediaKey.replace(/=+$/, ''))
    throw new Error('媒体加密密钥格式不正确')
  if (key.length === 16) return key
  if (key.length === 32 && hex.test(key.toString('latin1'))) return Buffer.from(key.toString('latin1'), 'hex')
  throw new Error('媒体加密密钥长度不正确')
}

async function toWav(bytes: Buffer): Promise<Buffer> {
  const { decode, getDuration, isSilk } = await import('silk-wasm')
  if (bytes.length > 1024 * 1024 || !isSilk(bytes) || getDuration(bytes) > 5 * 60_000)
    throw new Error('不是可转换的 SILK 语音')
  const rate = 24_000
  const { data } = await decode(bytes, rate)
  if (!data.length || data.length > maxMedia - 44) throw new Error('语音解码结果超出范围')
  const wav = Buffer.alloc(44 + data.length)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(data.length, 40)
  wav.set(data, 44)
  return wav
}

export class WeixinMedia {
  readonly #references = new Map<string, MediaReference>()
  readonly #shutdown: AbortSignal

  constructor(shutdown: AbortSignal) {
    this.#shutdown = shutdown
  }

  remember(kind: MediaKind, ref: CdnMedia, name?: string, imageKey?: string): MediaSegment | undefined {
    if (!ref.full_url && !ref.encrypt_query_param) return undefined
    const handle = `${mediaPrefix}${randomUUID()}`
    this.#references.set(handle, { kind, ref, imageKey })
    const first = this.#references.keys().next()
    if (this.#references.size > maxReferences && !first.done) this.#references.delete(first.value)
    return kind === 'file' ? seg.file(handle, { name }) : seg[kind](handle)
  }

  async download(handle: string, format: 'original' | 'wav', signal = this.#signal()): Promise<Buffer> {
    const entry = this.#references.get(handle)
    if (!entry) throw new Error('微信媒体已过期或不属于此机器人')
    if (format === 'wav' && entry.kind !== 'audio') throw new Error('只有 SILK 语音可转换为 WAV')
    try {
      const url = resolveCdnUrl('download', entry.ref.full_url, entry.ref.encrypt_query_param)
      const key = decodeKey(entry.imageKey, entry.ref.aes_key)
      if (!key && entry.kind !== 'image') throw new Error('微信未提供媒体加密密钥')
      let bytes = await download(url, signal, maxMedia + (key ? 16 : 0))
      if (key) {
        const cipher = createDecipheriv('aes-128-ecb', key, null)
        bytes = Buffer.concat([cipher.update(bytes), cipher.final()])
      }
      if (bytes.length > maxMedia) throw new Error('媒体超过大小限制')
      const result = format === 'wav' ? await toWav(bytes) : bytes
      signal.throwIfAborted()
      return result
    } catch {
      throw new Error(signal.aborted ? '微信媒体下载已取消或超时' : '微信媒体下载、解密或转码失败')
    }
  }

  async upload(userId: string, segment: OutboundMedia, request: IlinkRequest) {
    const signal = this.#signal()
    const source = segment.data.file
    let bytes: Buffer
    let sourceName: string | undefined
    try {
      signal.throwIfAborted()
      if (source.startsWith(mediaPrefix)) bytes = await this.download(source, 'original', signal)
      else if (source.startsWith('base64://')) bytes = base64Media(source.slice(9), maxMedia)
      else {
        const url = new URL(source)
        sourceName = mediaName(decodeURIComponent(url.pathname))
        bytes =
          url.protocol === 'file:'
            ? await localMedia(url, signal, maxMedia)
            : await remoteMedia(url, signal, maxMedia)
      }
      if (!bytes.length || bytes.length > maxMedia) throw new Error('媒体超过大小限制或内容为空')
    } catch {
      throw new Error(
        signal.aborted ? '微信媒体读取已取消或超时' : '无法读取微信待发送媒体，请检查来源及大小',
      )
    }

    const filekey = randomBytes(16).toString('hex')
    const aeskey = randomBytes(16)
    const hexKey = aeskey.toString('hex')
    const cipher = createCipheriv('aes-128-ecb', aeskey, null)
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()])
    signal.throwIfAborted()
    const params = await request(
      'getuploadurl',
      uploadSchema,
      {
        filekey,
        media_type: uploadTypes[segment.type],
        to_user_id: userId,
        rawsize: bytes.length,
        rawfilemd5: createHash('md5').update(bytes).digest('hex'),
        filesize: encrypted.length,
        no_need_thumb: true,
        aeskey: hexKey,
      },
      15_000,
      signal,
    )
    let encryptedParam: string
    try {
      const url = resolveCdnUrl('upload', params.upload_full_url, params.upload_param, filekey)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: encrypted,
        signal,
        redirect: 'error',
      })
      const param = response.headers.get('x-encrypted-param')
      await response.body?.cancel()
      if (response.status !== 200 || !param || param.length > 8192) throw new Error('媒体上传未完成')
      encryptedParam = param
    } catch {
      throw new Error(signal.aborted ? '微信媒体上传已取消或超时' : '微信媒体上传失败')
    }
    const media = {
      encrypt_query_param: encryptedParam,
      aes_key: Buffer.from(hexKey).toString('base64'),
      encrypt_type: 1,
    }
    const name =
      segment.type === 'file' ? (mediaName(segment.data.name) ?? sourceName ?? 'file.bin') : undefined
    const saved = this.remember(segment.type, media, name)
    if (!saved) throw new Error('微信媒体上传后缺少下载标识')
    const item =
      segment.type === 'image'
        ? { type: 2, image_item: { media, mid_size: encrypted.length } }
        : segment.type === 'video'
          ? { type: 5, video_item: { media, video_size: encrypted.length } }
          : { type: 4, file_item: { media, file_name: name, len: String(bytes.length) } }
    return { item, segment: saved }
  }

  #signal(): AbortSignal {
    return AbortSignal.any([this.#shutdown, AbortSignal.timeout(mediaTimeout)])
  }
}
