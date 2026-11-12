import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { getMimeType } from 'hono/utils/mime'
import type { PanelPage } from '../core/plugin/types.ts'

const pluginName = /^[a-z0-9][a-z0-9_-]*$/

function safeParts(path: string): boolean {
  return (
    !path.includes('\\') &&
    !path.includes(':') &&
    path
      .split('/')
      .every(
        (part, index, parts) =>
          (part !== '' || index === parts.length - 1) &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
          ![...part].some((character) => character.charCodeAt(0) < 32),
      )
  )
}

/** Check before the HTTP adapter normalizes dot segments in the request URL. */
export function unsafePluginPageUrl(url: string): boolean {
  const path = url.split('?', 1)[0] ?? ''
  try {
    const decoded = decodeURIComponent(path)
    if (!decoded.startsWith('/plugin-pages/')) return false
    if (/%2f|%5c/i.test(path)) return true
    return !safeParts(decoded.slice('/plugin-pages/'.length))
  } catch {
    return path.startsWith('/plugin-pages/')
  }
}

export function isPluginPageName(name: string): boolean {
  return pluginName.test(name)
}

function inside(root: string, path: string): boolean {
  const result = relative(root, path)
  return result === '' || (!isAbsolute(result) && result !== '..' && !result.startsWith(`..${sep}`))
}

export async function pluginPageFile(page: PanelPage, path: string): Promise<Response | undefined> {
  if (!safeParts(path) || !safeParts(page.entry) || isAbsolute(page.entry)) return undefined
  try {
    const root = await realpath(page.root)
    let file = await realpath(resolve(root, path))
    if (!inside(root, file)) return undefined
    if ((await stat(file)).isDirectory()) {
      file = await realpath(resolve(file, page.entry))
      if (!inside(root, file)) return undefined
    }
    if (!(await stat(file)).isFile()) return undefined
    const content = await readFile(file)
    return new Response(Uint8Array.from(content), {
      headers: {
        'Content-Type': getMimeType(file) ?? 'application/octet-stream',
        'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))
    )
      return undefined
    throw error
  }
}
