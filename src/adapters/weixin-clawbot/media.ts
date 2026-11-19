import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { basename, win32 } from 'node:path'
import { Agent } from 'undici'
import type { z } from 'zod'
import { seg } from '../../core/message/index.ts'
import { type cdnSchema, type IlinkRequest, limitedBytes, uploadSchema } from './protocol.ts'

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
const privateV4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  privateV4.addSubnet(address, prefix)
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const reservedV6 = new BlockList()
reservedV6.addSubnet('2001::', 23, 'ipv6')
reservedV6.addSubnet('2001:db8::', 32, 'ipv6')
reservedV6.addSubnet('2002::', 16, 'ipv6')
reservedV6.addSubnet('3fff::', 20, 'ipv6')

function publicAddress(address: string): boolean {
  return isIP(address) === 4
    ? !privateV4.check(address)
    : globalV6.check(address, 'ipv6') && !reservedV6.check(address, 'ipv6')
}

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

async function download(url: URL, signal: AbortSignal, limit: number, dispatcher?: Agent): Promise<Buffer> {
  const init = { signal, redirect: 'error' as const, dispatcher }
  const response = await fetch(url, init)
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`媒体 HTTP ${response.status}`)
  }
  return limitedBytes(response, limit)
}

async function remoteMedia(url: URL, signal: AbortSignal): Promise<Buffer> {
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('媒体来源不受信任')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  if (family && !publicAddress(hostname)) throw new Error('不能访问非公网媒体地址')
  const dispatcher = new Agent({
    connect: {
      lookup(host, options, callback) {
        void lookup(host, { all: true, family: options.family, hints: options.hints }).then(
          (addresses) => {
            const first = addresses[0]
            if (!first || addresses.some(({ address }) => !publicAddress(address))) {
              callback(new Error('不能访问非公网媒体地址'), '')
            } else if (options.all) callback(null, addresses)
            else callback(null, first.address, first.family)
          },
          (error: Error) => callback(error, ''),
        )
      },
    },
  })
  try {
    return await download(url, signal, maxMedia, dispatcher)
  } finally {
    await dispatcher.destroy()
  }
}

async function localMedia(url: URL, signal: AbortSignal): Promise<Buffer> {
  if (url.host) throw new Error('不支持网络文件路径')
  const file = await open(url, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxMedia) throw new Error('媒体文件不可用或超过大小限制')
    signal.throwIfAborted()
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of file.createReadStream({ end: maxMedia, signal, autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > maxMedia) throw new Error('媒体超过大小限制')
      chunks.push(bytes)
    }
    return Buffer.concat(chunks, length)
  } finally {
    await file.close()
  }
}

export function mediaName(value: string | undefined): string | undefined {
  const name = value && win32.basename(basename(value)).trim().slice(0, 255)
  return name && name !== '.' && name !== '..' ? name : undefined
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
      else if (source.startsWith('base64://')) {
        const encoded = source.slice(9)
        if (encoded.length > Math.ceil(maxMedia / 3) * 4) throw new Error('媒体超过大小限制')
        bytes = Buffer.from(encoded, 'base64')
        if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, ''))
          throw new Error('媒体 base64 格式错误')
      } else {
        const url = new URL(source)
        sourceName = mediaName(decodeURIComponent(url.pathname))
        bytes = url.protocol === 'file:' ? await localMedia(url, signal) : await remoteMedia(url, signal)
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
