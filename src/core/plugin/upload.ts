import { crc32 } from 'node:zlib'
import { strFromU8, unzipSync } from 'fflate'
import { PluginError } from '../errors.ts'

export class ManagementError extends PluginError {
  readonly status: 400 | 404 | 409
  constructor(status: 400 | 404 | 409, message: string) {
    super(message)
    this.status = status
  }
}

const limit = 5 * 1024 * 1024
const validName = /^[a-z0-9][a-z0-9_-]*$/

export function uploadContents(
  filename: string,
  content: string,
): {
  name: string
  directory: boolean
  files: Map<string, Uint8Array>
} {
  const match = /^([a-z0-9][a-z0-9_-]*)\.(ts|js|zip)$/.exec(filename)
  if (!match || !validName.test(match[1] as string)) throw new ManagementError(400, 'Invalid filename')
  if (
    content.length > Math.ceil((2 * 1024 * 1024) / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
  )
    throw new ManagementError(400, 'Invalid or oversized base64 content')
  const bytes = Buffer.from(content, 'base64')
  if (bytes.length > 2 * 1024 * 1024) throw new ManagementError(400, 'Upload exceeds 2 MB')
  const name = match[1] as string
  if (match[2] !== 'zip') return { name, directory: false, files: new Map([[filename, bytes]]) }
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let end = bytes.length - 22
    while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--
    if (end < 0 || end + 22 + view.getUint16(end + 20, true) !== bytes.length) throw new Error('Invalid ZIP')
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('Multi-disk ZIP')
    const count = view.getUint16(end + 10, true)
    let offset = view.getUint32(end + 16, true)
    const directory = offset
    const directorySize = view.getUint32(end + 12, true)
    if (count === 0xffff || offset === 0xffffffff || view.getUint16(end + 8, true) !== count)
      throw new Error('Unsupported ZIP')
    if (directory + directorySize > end) throw new Error('Invalid ZIP directory')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const names = new Set<string>()
    const expected = new Map<string, { size: number; crc: number }>()
    let total = 0
    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid ZIP entry')
      const flags = view.getUint16(offset + 8, true)
      const compressed = view.getUint32(offset + 20, true)
      const size = view.getUint32(offset + 24, true)
      const crc = view.getUint32(offset + 16, true)
      const nameLength = view.getUint16(offset + 28, true)
      const extraLength = view.getUint16(offset + 30, true)
      const commentLength = view.getUint16(offset + 32, true)
      const mode = view.getUint32(offset + 38, true) >>> 16
      const local = view.getUint32(offset + 42, true)
      const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength)
      const entry = flags & 0x800 ? decoder.decode(rawName) : strFromU8(rawName, true)
      if (
        !entry ||
        entry.includes('\\') ||
        entry.startsWith('/') ||
        /^[A-Za-z]:/.test(entry) ||
        entry
          .split('/')
          .some(
            (part, index, parts) =>
              (part === '' && index !== parts.length - 1) ||
              part === '..' ||
              part === '.' ||
              /[. ]$/.test(part) ||
              /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
              part === '__proto__',
          ) ||
        entry.includes(':') ||
        [...entry].some((character) => character.charCodeAt(0) < 32) ||
        (mode & 0xf000) === 0xa000 ||
        flags & 1 ||
        compressed === 0xffffffff ||
        size === 0xffffffff ||
        local >= offset ||
        names.has(entry.toLowerCase())
      )
        throw new Error('Unsafe ZIP entry')
      if (
        local + 30 > directory ||
        view.getUint32(local, true) !== 0x04034b50 ||
        view.getUint16(local + 6, true) !== flags ||
        view.getUint16(local + 8, true) !== view.getUint16(offset + 10, true)
      )
        throw new Error('Invalid ZIP local header')
      const localNameLength = view.getUint16(local + 26, true)
      const dataStart = local + 30 + localNameLength + view.getUint16(local + 28, true)
      if (
        dataStart + compressed > directory ||
        !bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawName)
      )
        throw new Error('Invalid ZIP entry data')
      names.add(entry.toLowerCase())
      expected.set(entry, { size, crc })
      total += size
      if (total > limit) throw new Error('ZIP exceeds 5 MB')
      offset += 46 + nameLength + extraLength + commentLength
      if (offset > end) throw new Error('Invalid ZIP directory')
    }
    if (offset !== directory + directorySize) throw new Error('Invalid ZIP directory size')
    const extracted = unzipSync(bytes)
    for (const [path, metadata] of expected) {
      const data = extracted[path]
      if (!data || data.length !== metadata.size || crc32(data) !== metadata.crc)
        throw new Error('Invalid ZIP checksum or size')
    }
    const paths = Object.keys(extracted).filter((path) => !path.endsWith('/'))
    const rootIndex = paths.find((path) => path === 'index.ts' || path === 'index.js')
    let prefix = ''
    if (!rootIndex) {
      const roots = new Set(paths.map((path) => path.split('/')[0]))
      if (roots.size !== 1) throw new Error('ZIP needs a single root directory')
      prefix = `${paths[0]?.split('/')[0]}/`
      if (!paths.includes(`${prefix}index.ts`) && !paths.includes(`${prefix}index.js`))
        throw new Error('ZIP needs an index.ts or index.js')
    }
    const files = new Map<string, Uint8Array>()
    for (const path of paths) {
      if (!path.startsWith(prefix)) throw new Error('Invalid ZIP root')
      files.set(path.slice(prefix.length), extracted[path] as Uint8Array)
    }
    return { name, directory: true, files }
  } catch (error) {
    throw new ManagementError(400, `Invalid ZIP: ${error instanceof Error ? error.message : String(error)}`)
  }
}
