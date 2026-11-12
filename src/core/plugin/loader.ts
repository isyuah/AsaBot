import { registerHooks } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const roots = new Map<string, number>()
const dependencies = new Map<string, Set<string>>()
let registered = false
let nextVersion = 0
const frameworkUrl = import.meta.resolve('asabot')

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function registerPluginRoots(dirs: string[]): () => void {
  if (!registered) {
    registered = true
    registerHooks({
      // Plugin directories may live outside any package with "type": "module" (for example a deployment
      // folder). Without this, Node guesses CommonJS for their .ts files, re-parses them and prints
      // MODULE_TYPELESS_PACKAGE_JSON on every load.
      load(url, context, nextLoad) {
        if (url.startsWith('file:')) {
          const file = resolve(fileURLToPath(new URL(url)))
          if (
            file.endsWith('.ts') &&
            !file.endsWith('.d.ts') &&
            [...roots.keys()].some((root) => inside(root, file))
          )
            return nextLoad(url, { ...context, format: 'module-typescript' })
        }
        return nextLoad(url, context)
      },
      resolve(specifier, context, nextResolve) {
        if (specifier === 'asabot' && context.parentURL?.startsWith('file:')) {
          const parent = new URL(context.parentURL)
          if (
            parent.searchParams.has('v') &&
            [...roots.keys()].some((root) => inside(root, fileURLToPath(parent)))
          ) {
            return { url: frameworkUrl, shortCircuit: true }
          }
        }
        const result = nextResolve(specifier, context)
        if (!result.url.startsWith('file:') || !(specifier.startsWith('.') || specifier.startsWith('file:')))
          return result
        const parent = context.parentURL ? new URL(context.parentURL) : undefined
        const version = parent?.searchParams.get('v')
        if (!version) return result
        const url = new URL(result.url)
        const file = resolve(fileURLToPath(url))
        if (![...roots.keys()].some((root) => inside(root, file))) return result
        dependencies.get(version)?.add(file)
        url.searchParams.set('v', version)
        return { ...result, url: url.href }
      },
    })
  }
  const normalized = dirs.map((dir) => resolve(dir))
  for (const root of normalized) roots.set(root, (roots.get(root) ?? 0) + 1)
  return () => {
    for (const root of normalized) {
      const count = roots.get(root)
      if (count === 1) roots.delete(root)
      else if (count !== undefined) roots.set(root, count - 1)
    }
  }
}

export async function importPlugin(
  path: string,
): Promise<{ value: unknown; files: Set<string>; release: () => void }> {
  const version = `${process.pid}-${++nextVersion}`
  const files = new Set([resolve(path)])
  dependencies.set(version, files)
  const url = pathToFileURL(resolve(path))
  url.searchParams.set('v', version)
  try {
    const module: { default?: unknown } = await import(url.href)
    return { value: module.default, files, release: () => dependencies.delete(version) }
  } catch (error) {
    dependencies.delete(version)
    throw error
  }
}
