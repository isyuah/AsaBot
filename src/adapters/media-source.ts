import { lookup } from 'node:dns/promises'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { basename, win32 } from 'node:path'
import { Agent } from 'undici'

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

export async function limitedBytes(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  let done = false
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new Error('响应超过大小限制')
    for (;;) {
      const part = await reader.read()
      if (part.done) {
        done = true
        return Buffer.concat(chunks, size)
      }
      size += part.value.length
      if (size > limit) throw new Error('响应超过大小限制')
      chunks.push(part.value)
    }
  } finally {
    if (!done) await reader.cancel()
    reader.releaseLock()
  }
}

export async function download(
  url: URL,
  signal: AbortSignal,
  limit: number,
  dispatcher?: Agent,
): Promise<Buffer> {
  const init = { signal, redirect: 'error' as const, dispatcher }
  const response = await fetch(url, init)
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`媒体 HTTP ${response.status}`)
  }
  return limitedBytes(response, limit)
}

export async function remoteMedia(url: URL, signal: AbortSignal, limit: number): Promise<Buffer> {
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('媒体来源不受信任')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(hostname) && !publicAddress(hostname)) throw new Error('不能访问非公网媒体地址')
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
    return await download(url, signal, limit, dispatcher)
  } finally {
    await dispatcher.destroy()
  }
}

export async function localMedia(url: URL, signal: AbortSignal, limit: number): Promise<Buffer> {
  if (url.host) throw new Error('不支持网络文件路径')
  const file = await open(url, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit) throw new Error('媒体文件不可用或超过大小限制')
    signal.throwIfAborted()
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of file.createReadStream({ end: limit, signal, autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > limit) throw new Error('媒体超过大小限制')
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

export function base64Media(encoded: string, limit: number): Buffer {
  if (encoded.length > Math.ceil(limit / 3) * 4) throw new Error('媒体超过大小限制')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, ''))
    throw new Error('媒体 base64 格式错误')
  return bytes
}
