import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'fflate'
import { maxSatisfying, rcompare, satisfies, valid, validRange } from 'semver'
import { z } from 'zod'
import { pluginIconFromKeywords } from './icon.ts'
import type { PluginState } from './types.ts'
import { ManagementError } from './upload.ts'

export interface PackageManifest {
  name: string
  version: string
  description?: string
  keywords?: string[]
  peerDependencies?: Record<string, string>
  type?: string
  main?: string
  exports?: unknown
}

export interface Packument {
  name: string
  'dist-tags': Record<string, string>
  versions: Record<string, unknown>
}

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  type: z.string().optional(),
  main: z.string().optional(),
  exports: z.unknown().optional(),
})

const packumentSchema = z.object({
  name: z.string(),
  'dist-tags': z.record(z.string(), z.string()),
  versions: z.record(z.string(), z.unknown()),
})

const fullPackumentSchema = packumentSchema.extend({
  description: z.string().optional(),
  license: z.union([z.string(), z.object({ type: z.string() })]).optional(),
  homepage: z.string().optional(),
  repository: z.union([z.string(), z.object({ url: z.string() })]).optional(),
  readme: z.string().optional(),
  time: z.record(z.string(), z.string()).optional(),
})
type FullPackument = z.output<typeof fullPackumentSchema>

export interface PackageSearchItem {
  name: string
  version: string
  description?: string
  iconUrl?: string
  author?: string
  date?: string
  links: { npm: string; homepage?: string; repository?: string }
  installed: boolean
  installedVersion?: string
}

export interface RegistryClient {
  metadata(name: string): Promise<Packument>
  fullMetadata(name: string): Promise<FullPackument>
  /** Downloads a package tarball (a URL taken from the registry's own packument). */
  tarball(url: string): Promise<Uint8Array>
  search(
    query: string,
  ): Promise<{ total: number; items: Omit<PackageSearchItem, 'installed' | 'installedVersion'>[] }>
}

export type PackageSort = 'relevance' | 'updated' | 'name'

export interface NpmExecutor {
  run(args: string[], onLine: (line: string) => void): Promise<void>
}

export interface PackageOperation {
  id: string
  kind: 'install' | 'update' | 'uninstall'
  name: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  startedAt: number
  finishedAt?: number
  log: string[]
  error?: string
  plugin?: PluginState
}

export interface PackageInfo {
  name: string
  version: string
  latest?: string
  peerRange?: string
  compatible: boolean
}

export interface PackageOptions {
  registry?: RegistryClient
  npm?: NpmExecutor
}

const frameworkVersion = (
  JSON.parse(await readFile(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as {
    version: string
  }
).version

export function validPackageName(name: string): boolean {
  return name.length <= 214 && /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)
}

export async function resolveWindowsNpm(command: string): Promise<string> {
  const name = command.toLowerCase() === 'npm' ? 'npm.cmd' : command
  if (isAbsolute(name) || /[\\/]/.test(name)) return resolve(name)
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory || '.', name)
    try {
      await access(candidate)
      return candidate
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  throw new Error(`npm executable not found: ${name}`)
}

export function npmEnvironment(dir: string, registry: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (
      [
        'npm_config_registry',
        'npm_config_cache',
        'npm_config_legacy_peer_deps',
        'npm_config_logs_max',
        'npm_config_offline',
      ].includes(key.toLowerCase())
    )
      delete env[key]
  }
  env.npm_config_registry = registry
  env.npm_config_cache = join(resolve(dir), '.npm-cache')
  // --omit=peer still resolves peers, including the unpublished framework package.
  env.npm_config_legacy_peer_deps = 'true'
  env.npm_config_logs_max = '0'
  env.npm_config_offline = 'false'
  return env
}

export function redact(value: string): string {
  let result = value
    .replace(
      /(\b(?:_authToken|_auth|authorization|password|token|access_token)\b\s*[=:]\s*)(?:bearer\s+)?[^\s,;]+/gi,
      '$1[Redacted]',
    )
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[Redacted]@')
    .replace(/([?&](?:token|access_token|password|secret)=)[^&\s]+/gi, '$1[Redacted]')
  for (const [key, secret] of Object.entries(process.env)) {
    if (/(?:TOKEN|PASSWORD|SECRET|_AUTH)$/i.test(key) && secret && secret.length >= 4)
      result = result.replaceAll(secret, '[Redacted]')
  }
  return result
}

const maxTarballBytes = 5 * 1024 * 1024
const maxReadmeBytes = 200 * 1024
const readmeFilename = /^readme(?:\.(?:md|markdown|txt))?$/i

function decodeReadme(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.subarray(0, maxReadmeBytes), {
    stream: bytes.length > maxReadmeBytes,
  })
}

/** The top-level README of an npm tarball (gzipped ustar), or undefined when there is none. */
export function readmeFromTarball(tgz: Uint8Array): string | undefined {
  const tar = gunzipSync(tgz)
  const decoder = new TextDecoder()
  const field = (offset: number, length: number): string => {
    const bytes = tar.subarray(offset, offset + length)
    const end = bytes.indexOf(0)
    return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end))
  }
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = field(offset, 100)
    if (!name) break // end-of-archive block
    const size = Number.parseInt(field(offset + 124, 12).trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid tar entry size')
    const type = field(offset + 156, 1)
    const prefix = field(offset + 345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const start = offset + 512
    const slash = path.indexOf('/')
    if ((type === '' || type === '0') && slash > 0 && readmeFilename.test(path.slice(slash + 1)))
      return decoder.decode(tar.subarray(start, start + size))
    offset = start + Math.ceil(size / 512) * 512
  }
  return undefined
}

export class FetchRegistry implements RegistryClient {
  private readonly registry: string
  constructor(registry: string) {
    this.registry = registry.endsWith('/') ? registry : `${registry}/`
  }

  async metadata(name: string): Promise<Packument> {
    const response = await fetch(new URL(encodeURIComponent(name), this.registry), {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404) throw new ManagementError(404, 'Package not found')
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`)
    return packumentSchema.parse(await response.json())
  }

  async fullMetadata(name: string): Promise<FullPackument> {
    const response = await fetch(new URL(encodeURIComponent(name), this.registry), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404) throw new ManagementError(404, 'Package not found')
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`)
    return fullPackumentSchema.parse(await response.json())
  }

  async tarball(url: string): Promise<Uint8Array> {
    if (!/^https?:\/\//i.test(url)) throw new Error('Tarball URL must be http(s)')
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`)
    if (Number(response.headers.get('content-length') ?? 0) > maxTarballBytes)
      throw new Error('Tarball is too large to read a README from')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > maxTarballBytes) throw new Error('Tarball is too large to read a README from')
    return bytes
  }

  async search(
    query: string,
  ): Promise<{ total: number; items: Omit<PackageSearchItem, 'installed' | 'installedVersion'>[] }> {
    const url = new URL('-/v1/search', this.registry)
    url.searchParams.set('text', `keywords:asabot-plugin ${query}`.trim())
    url.searchParams.set('from', '0')
    url.searchParams.set('size', '250')
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`)
    const result = (await response.json()) as {
      total: number
      objects: {
        package: {
          name: string
          version: string
          description?: string
          keywords?: unknown
          author?: { name?: string } | string
          date?: string
          links: PackageSearchItem['links']
        }
      }[]
    }
    return {
      total: result.total,
      items: result.objects.map(({ package: item }) => ({
        name: item.name,
        version: item.version,
        ...(item.description === undefined ? {} : { description: item.description }),
        iconUrl: pluginIconFromKeywords(item.keywords),
        ...(item.author === undefined
          ? {}
          : { author: typeof item.author === 'string' ? item.author : item.author.name }),
        ...(item.date === undefined ? {} : { date: item.date }),
        links: item.links,
      })),
    }
  }
}

export class ProcessNpm implements NpmExecutor {
  private readonly dir: string
  private readonly registry: string
  private readonly npm: string
  private readonly timeout: number
  constructor(config: { dir: string; registry: string; npm: string; installTimeout: number }) {
    this.dir = resolve(config.dir)
    this.registry = config.registry
    this.npm = config.npm
    this.timeout = config.installTimeout
  }

  async run(args: string[], onLine: (line: string) => void): Promise<void> {
    const windows = process.platform === 'win32'
    let executable = this.npm
    let parameters = args
    if (windows && (this.npm.toLowerCase() === 'npm' || /\.(?:cmd|bat)$/i.test(this.npm))) {
      const command = await resolveWindowsNpm(this.npm)
      const parts = [command, ...args]
      if (parts.some((part) => /["&|<>^%!\r\n]/.test(part))) throw new Error('Unsafe npm command argument')
      executable = process.env.ComSpec ?? 'cmd.exe'
      parameters = ['/d', '/s', '/c', `"${parts.map((part) => `"${part}"`).join(' ')}"`]
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, parameters, {
        cwd: this.dir,
        env: npmEnvironment(this.dir, this.registry),
        windowsVerbatimArguments: windows && executable !== this.npm,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        if (windows && child.pid) {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          killer.on('error', () => child.kill())
          killer.on('exit', (code) => {
            if (code !== 0) child.kill()
          })
        } else child.kill('SIGKILL')
      }, this.timeout)
      for (const stream of [child.stdout, child.stderr]) {
        let pending = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          pending += chunk
          const lines = pending.split(/\r\n|\r|\n/)
          pending = (lines.pop() ?? '').slice(0, 16_384)
          for (const line of lines) if (line) onLine(redact(line).slice(0, 4096))
        })
        stream.on('end', () => {
          if (pending) onLine(redact(pending).slice(0, 4096))
        })
      }
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (timedOut) reject(new Error(`npm timed out after ${this.timeout}ms`))
        else if (code !== 0) reject(new Error(`npm exited with code ${code}`))
        else resolve()
      })
    })
  }
}

interface PackageHost {
  installedPackages(): Map<string, { manifest: PackageManifest; plugin: string }>
  latestChanged(name: string): void
  latestFailed(name: string, error: unknown): void
  readmeFailed(name: string, error: unknown): void
  subscriberFailed(operation: PackageOperation, error: unknown): void
  installPackage(
    manifest: PackageManifest,
    kind: 'install' | 'update',
    log: (line: string) => void,
  ): Promise<PluginState>
  uninstallPackage(name: string, purge: boolean, log: (line: string) => void): Promise<void>
}

export class PackageService {
  readonly dir: string
  readonly registry: RegistryClient
  readonly npm: NpmExecutor
  private readonly registryUrl: string
  private readonly host: PackageHost
  private readonly operations: PackageOperation[] = []
  private readonly subscribers = new Set<(operation: PackageOperation) => void>()
  private readonly latestCache = new Map<string, { value?: string; expires: number }>()
  private readonly latestPending = new Map<string, Promise<void>>()
  private readonly searchCache = new Map<
    string,
    { value: Awaited<ReturnType<RegistryClient['search']>>; expires: number }
  >()
  private readonly searchPending = new Map<string, Promise<Awaited<ReturnType<RegistryClient['search']>>>>()
  private readonly infoCache = new Map<string, { value: FullPackument; expires: number }>()
  private readonly infoPending = new Map<string, Promise<FullPackument>>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    config: { dir: string; registry: string; npm: string; installTimeout: number },
    host: PackageHost,
    options: PackageOptions = {},
  ) {
    this.dir = resolve(config.dir)
    this.registryUrl = config.registry
    this.host = host
    this.registry = options.registry ?? new FetchRegistry(config.registry)
    this.npm = options.npm ?? new ProcessNpm({ ...config, dir: this.dir })
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    try {
      await writeFile(
        join(this.dir, 'package.json'),
        `${JSON.stringify({ name: 'asabot-packages', private: true, type: 'module', dependencies: {} }, null, 2)}\n`,
        { flag: 'wx' },
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  async dependencies(): Promise<Record<string, string>> {
    const data = JSON.parse(await readFile(join(this.dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return data.dependencies ?? {}
  }

  packageRoot(name: string): string {
    return join(this.dir, 'node_modules', ...name.split('/'))
  }

  async manifest(name: string): Promise<PackageManifest> {
    if (!validPackageName(name)) throw new ManagementError(400, 'Invalid package name')
    const data: unknown = JSON.parse(await readFile(join(this.packageRoot(name), 'package.json'), 'utf8'))
    const parsed = manifestSchema.safeParse(data)
    if (!parsed.success || parsed.data.name !== name || !valid(parsed.data.version))
      throw new ManagementError(400, 'Invalid installed package metadata')
    return parsed.data
  }

  async installedReadme(manifest: PackageManifest): Promise<string | undefined> {
    const root = this.packageRoot(manifest.name)
    try {
      const files = await readdir(root, { withFileTypes: true })
      const readme = files.find((file) => file.isFile() && readmeFilename.test(file.name))
      if (!readme) return undefined
      const stream = createReadStream(join(root, readme.name), { end: maxReadmeBytes })
      const chunks: Buffer[] = await stream.toArray()
      return decodeReadme(Buffer.concat(chunks))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  info(manifest: PackageManifest): PackageInfo {
    const peerRange = manifest.peerDependencies?.['@asabot/core']
    const cached = this.latestCache.get(manifest.name)
    if (!cached || cached.expires <= Date.now()) void this.refreshLatest(manifest.name)
    return {
      name: manifest.name,
      version: manifest.version,
      ...(cached?.value && cached.expires > Date.now() ? { latest: cached.value } : {}),
      ...(peerRange === undefined ? {} : { peerRange }),
      compatible: !!peerRange && !!validRange(peerRange) && satisfies(frameworkVersion, peerRange),
    }
  }

  private refreshLatest(name: string): Promise<void> {
    const cached = this.latestCache.get(name)
    if (cached && cached.expires > Date.now()) return Promise.resolve()
    const existing = this.latestPending.get(name)
    if (existing) return existing
    const pending = this.registry
      .metadata(name)
      .then((data) => {
        this.latestCache.set(name, { value: data['dist-tags']?.latest, expires: Date.now() + 3_600_000 })
        this.host.latestChanged(name)
      })
      .catch((error: unknown) => {
        this.latestCache.set(name, { expires: Date.now() + 3_600_000 })
        this.host.latestFailed(name, error)
      })
      .finally(() => this.latestPending.delete(name))
    this.latestPending.set(name, pending)
    return pending
  }

  async ensureLatest(): Promise<void> {
    await Promise.all([...this.host.installedPackages().keys()].map((name) => this.refreshLatest(name)))
  }

  async search(
    query: string,
    from: number,
    sort: PackageSort = 'relevance',
  ): Promise<{ total: number; items: PackageSearchItem[] }> {
    let cached = this.searchCache.get(query)
    if (!cached || cached.expires <= Date.now()) {
      let pending = this.searchPending.get(query)
      if (!pending) {
        pending = this.registry
          .search(query)
          .then((value) => {
            this.searchCache.set(query, { value, expires: Date.now() + 300_000 })
            return value
          })
          .finally(() => this.searchPending.delete(query))
        this.searchPending.set(query, pending)
      }
      cached = { value: await pending, expires: Date.now() + 300_000 }
    }
    const result = cached.value
    const sorted = result.items.slice(0, 250)
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    else if (sort === 'updated')
      sorted.sort((a, b) => (Date.parse(b.date ?? '') || 0) - (Date.parse(a.date ?? '') || 0))
    const installed = this.host.installedPackages()
    return {
      total: Math.min(result.total, 250),
      items: sorted.slice(from, from + 20).map((item) => {
        const entry = installed.get(item.name)
        return { ...item, installed: !!entry, ...(entry ? { installedVersion: entry.manifest.version } : {}) }
      }),
    }
  }

  /**
   * The npm registry no longer embeds READMEs in packuments (mirrors such as npmmirror still do), so fall back
   * to the README inside the latest tarball. A missing README never fails the details request.
   */
  private async readme(name: string, metadata: FullPackument): Promise<string | undefined> {
    if (metadata.readme?.trim()) return metadata.readme
    const latest = metadata['dist-tags'].latest
    const dist = z
      .object({ dist: z.object({ tarball: z.string() }) })
      .safeParse(latest === undefined ? undefined : metadata.versions[latest])
    if (!dist.success) return undefined
    try {
      return readmeFromTarball(await this.registry.tarball(dist.data.dist.tarball))
    } catch (error) {
      this.host.readmeFailed(name, error)
      return undefined
    }
  }

  async marketInfo(name: string) {
    if (!validPackageName(name)) throw new ManagementError(400, 'Invalid package name')
    let cached = this.infoCache.get(name)
    if (!cached || cached.expires <= Date.now()) {
      let pending = this.infoPending.get(name)
      if (!pending) {
        pending = this.registry
          .fullMetadata(name)
          .then(async (metadata) => {
            const value = { ...metadata, readme: await this.readme(name, metadata) }
            this.infoCache.set(name, { value, expires: Date.now() + 600_000 })
            return value
          })
          .finally(() => this.infoPending.delete(name))
        this.infoPending.set(name, pending)
      }
      cached = { value: await pending, expires: Date.now() + 600_000 }
    }
    const data = cached.value
    const installed = this.host.installedPackages().get(name)?.manifest.version
    const repository = typeof data.repository === 'string' ? data.repository : data.repository?.url
    const readme = data.readme === undefined ? undefined : decodeReadme(Buffer.from(data.readme, 'utf8'))
    const versions = Object.keys(data.versions)
      .filter((version) => valid(version))
      .sort(rcompare)
      .slice(0, 50)
      .map((version) => {
        const value = z
          .object({
            peerDependencies: z.record(z.string(), z.string()).optional(),
            deprecated: z.string().optional(),
            keywords: z.unknown().optional(),
          })
          .safeParse(data.versions[version])
        const peerRange = value.success ? value.data.peerDependencies?.['@asabot/core'] : undefined
        const deprecated = value.success ? value.data.deprecated : undefined
        const date = data.time?.[version]
        return {
          version,
          iconUrl: value.success ? pluginIconFromKeywords(value.data.keywords) : undefined,
          ...(date === undefined ? {} : { date }),
          ...(peerRange === undefined ? {} : { peerRange }),
          compatible: !!peerRange && !!validRange(peerRange) && satisfies(frameworkVersion, peerRange),
          ...(deprecated === undefined ? {} : { deprecated }),
        }
      })
    return {
      name: data.name,
      ...(data.description === undefined ? {} : { description: data.description }),
      ...(data.license === undefined
        ? {}
        : { license: typeof data.license === 'string' ? data.license : data.license.type }),
      links: {
        npm: `https://www.npmjs.com/package/${name}`,
        ...(data.homepage === undefined ? {} : { homepage: data.homepage }),
        ...(repository === undefined ? {} : { repository }),
      },
      ...(readme === undefined ? {} : { readme }),
      ...(data['dist-tags'].latest === undefined ? {} : { latest: data['dist-tags'].latest }),
      ...(installed === undefined ? {} : { installed }),
      versions,
    }
  }

  async prepare(name: string, version: string | undefined, force: boolean): Promise<PackageManifest> {
    if (
      !validPackageName(name) ||
      (version !== undefined &&
        (version.length > 256 || (!validRange(version) && !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(version))))
    )
      throw new ManagementError(400, 'Invalid package name or version')
    // The abbreviated npm packument omits keywords from version manifests.
    const metadata = await this.registry.fullMetadata(name)
    this.latestCache.set(name, { value: metadata['dist-tags']?.latest, expires: Date.now() + 3_600_000 })
    const selected =
      version === undefined
        ? metadata['dist-tags']?.latest
        : (metadata['dist-tags']?.[version] ??
          (Object.hasOwn(metadata.versions, version)
            ? version
            : maxSatisfying(Object.keys(metadata.versions), version)))
    const result = manifestSchema.safeParse(selected ? metadata.versions?.[selected] : undefined)
    if (!result.success || !valid(result.data.version) || result.data.name !== name)
      throw new ManagementError(404, 'Package version not found')
    const manifest = result.data
    if (!manifest.keywords?.includes('asabot-plugin'))
      throw new ManagementError(400, 'Package is missing the asabot-plugin keyword')
    const peer = manifest.peerDependencies?.['@asabot/core']
    if (!force && (!peer || !validRange(peer) || !satisfies(frameworkVersion, peer)))
      throw new ManagementError(
        409,
        `Package requires @asabot/core ${redact(peer ?? '(peer dependency missing)')}; current version is ${frameworkVersion}`,
      )
    return manifest
  }

  async install(name: string, version?: string, force = false): Promise<PackageOperation> {
    const manifest = await this.prepare(name, version, force)
    return this.enqueue('install', name, (log) => this.host.installPackage(manifest, 'install', log))
  }

  async update(name: string): Promise<PackageOperation> {
    if (!this.host.installedPackages().has(name)) throw new ManagementError(404, 'Package is not installed')
    const manifest = await this.prepare(name, undefined, false)
    return this.enqueue('update', name, (log) => this.host.installPackage(manifest, 'update', log))
  }

  uninstall(name: string, purge: boolean): PackageOperation {
    if (!this.host.installedPackages().has(name)) throw new ManagementError(404, 'Package is not installed')
    return this.enqueue('uninstall', name, async (log) => {
      await this.host.uninstallPackage(name, purge, log)
      return undefined
    })
  }

  uninstallAndWait(name: string, purge: boolean): Promise<void> {
    return this.serial(() => this.host.uninstallPackage(name, purge, () => {}))
  }

  async whenIdle(): Promise<void> {
    await this.queue
  }

  list(): PackageOperation[] {
    return this.operations.map((op) => this.snapshot(op))
  }
  subscribe(listener: (operation: PackageOperation) => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  async runNpm(args: string[], log: (line: string) => void): Promise<void> {
    const path = join(this.dir, 'package.json')
    const before = await readFile(path)
    try {
      await this.npm.run(args, log)
    } catch (error) {
      await writeFile(path, before)
      throw error
    }
  }

  installArgs(spec: string): string[] {
    return [
      'install',
      spec,
      '--save',
      '--omit=peer',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry',
      this.registryUrl,
    ]
  }

  private enqueue(
    kind: PackageOperation['kind'],
    name: string,
    work: (log: (line: string) => void) => Promise<PluginState | undefined>,
  ): PackageOperation {
    const op: PackageOperation = {
      id: randomUUID(),
      kind,
      name,
      status: 'queued',
      startedAt: Date.now(),
      log: [],
    }
    this.operations.unshift(op)
    this.operations.splice(20)
    this.emit(op)
    void this.serial(async () => {
      op.status = 'running'
      this.emit(op)
      try {
        const plugin = await work((line) => {
          op.log.push(redact(line).slice(0, 4096))
          if (op.log.length > 200) op.log.shift()
          if (!this.timers.has(op.id))
            this.timers.set(
              op.id,
              setTimeout(() => {
                this.timers.delete(op.id)
                this.emit(op)
              }, 300),
            )
        })
        if (plugin) op.plugin = plugin
        op.status = 'succeeded'
      } catch (error) {
        op.status = 'failed'
        op.error = redact(error instanceof Error ? error.message : String(error))
      }
      op.finishedAt = Date.now()
      const timer = this.timers.get(op.id)
      if (timer) clearTimeout(timer)
      this.timers.delete(op.id)
      this.emit(op)
    })
    return this.snapshot(op)
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work)
    // The caller receives the rejection; keep the queue usable for subsequent operations.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private snapshot(op: PackageOperation): PackageOperation {
    return { ...op, log: [...op.log] }
  }
  private emit(op: PackageOperation): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(this.snapshot(op))
      } catch (error) {
        this.host.subscriberFailed(op, error)
      }
    }
  }
}
