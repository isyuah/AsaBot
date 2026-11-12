import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { maxSatisfying, satisfies, valid, validRange } from 'semver'
import { z } from 'zod'
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

export interface PackageSearchItem {
  name: string
  version: string
  description?: string
  author?: string
  date?: string
  links: { npm: string; homepage?: string; repository?: string }
  installed: boolean
  installedVersion?: string
}

export interface RegistryClient {
  metadata(name: string): Promise<Packument>
  search(
    query: string,
    from: number,
  ): Promise<{ total: number; items: Omit<PackageSearchItem, 'installed' | 'installedVersion'>[] }>
}

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

  async search(
    query: string,
    from: number,
  ): Promise<{ total: number; items: Omit<PackageSearchItem, 'installed' | 'installedVersion'>[] }> {
    const url = new URL('-/v1/search', this.registry)
    url.searchParams.set('text', `keywords:asabot-plugin ${query}`.trim())
    url.searchParams.set('from', String(from))
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`)
    const result = (await response.json()) as {
      total: number
      objects: {
        package: {
          name: string
          version: string
          description?: string
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
  serial<T>(work: () => Promise<T>): Promise<T>
  installedPackages(): Map<string, { manifest: PackageManifest; plugin: string }>
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
  private readonly timers = new Map<string, NodeJS.Timeout>()

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

  async manifest(name: string): Promise<PackageManifest> {
    if (!validPackageName(name)) throw new ManagementError(400, 'Invalid package name')
    const data: unknown = JSON.parse(
      await readFile(join(this.dir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'),
    )
    const parsed = manifestSchema.safeParse(data)
    if (!parsed.success || parsed.data.name !== name || !valid(parsed.data.version))
      throw new ManagementError(400, 'Invalid installed package metadata')
    return parsed.data
  }

  info(manifest: PackageManifest): PackageInfo {
    const peerRange = manifest.peerDependencies?.asabot
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
        this.latestCache.set(name, { value: data?.['dist-tags']?.latest, expires: Date.now() + 3_600_000 })
      })
      .catch(() => {
        this.latestCache.set(name, { expires: Date.now() + 3_600_000 })
      })
      .finally(() => this.latestPending.delete(name))
    this.latestPending.set(name, pending)
    return pending
  }

  async ensureLatest(): Promise<void> {
    await Promise.all([...this.host.installedPackages().keys()].map((name) => this.refreshLatest(name)))
  }

  async search(query: string, from: number): Promise<{ total: number; items: PackageSearchItem[] }> {
    const result = await this.registry.search(query, from)
    const installed = this.host.installedPackages()
    return {
      total: result.total,
      items: result.items.map((item) => {
        const entry = installed.get(item.name)
        return { ...item, installed: !!entry, ...(entry ? { installedVersion: entry.manifest.version } : {}) }
      }),
    }
  }

  async prepare(name: string, version: string | undefined, force: boolean): Promise<PackageManifest> {
    if (
      !validPackageName(name) ||
      (version !== undefined &&
        (version.length > 256 || (!validRange(version) && !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(version))))
    )
      throw new ManagementError(400, 'Invalid package name or version')
    const metadata = await this.registry.metadata(name)
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
    const peer = manifest.peerDependencies?.asabot
    if (!force && (!peer || !validRange(peer) || !satisfies(frameworkVersion, peer)))
      throw new ManagementError(
        409,
        `Package requires asabot ${redact(peer ?? '(peer dependency missing)')}; current version is ${frameworkVersion}`,
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
    void this.host.serial(async () => {
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

  private snapshot(op: PackageOperation): PackageOperation {
    return { ...op, log: [...op.log] }
  }
  private emit(op: PackageOperation): void {
    for (const subscriber of this.subscribers) subscriber(this.snapshot(op))
  }
}
