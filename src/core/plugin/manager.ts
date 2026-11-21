import { randomUUID } from 'node:crypto'
import { type Dirent, type FSWatcher, watch } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { App } from '../app.ts'
import { requirementsSchema } from '../capabilities.ts'
import { deleteConfigValue, writeConfigValue } from '../config/write.ts'
import { groupKeyOf } from '../dispatch/types.ts'
import { PluginConfigError, PluginError } from '../errors.ts'
import { type BotIdentity, groupIdentity } from '../identity.ts'
import { mergeConfig } from '../utils/merge.ts'
import { Context } from './context.ts'
import { type PluginDefinition, serviceDependencies } from './definition.ts'
import { pluginExecution } from './execution.ts'
import { importPlugin, registerPluginRoots } from './loader.ts'
import { type PackageManifest, type PackageOptions, PackageService, redact } from './packages.ts'
import type { PluginState } from './types.ts'
import { ManagementError, uploadContents } from './upload.ts'

interface Entry {
  state: PluginState
  definition?: PluginDefinition
  context?: Context<unknown>
  files: Set<string>
  release?: () => void
  failure?: 'dependency' | 'setup' | 'import' | 'duplicate'
  manifest?: PackageManifest
  optionalServices?: Map<string, { plugin: string; value: unknown } | undefined>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ignoredEntry(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.') || /\.(?:test|spec)\.|\.d\.ts$/.test(name)
}

function validateDefinition(value: unknown): PluginDefinition {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(value.name) ||
    value.name === 'core' ||
    !('setup' in value) ||
    typeof value.setup !== 'function'
  ) {
    throw new PluginError('Plugin must default-export a definition with a valid name and setup function')
  }
  if (
    'defaultOnNewBots' in value &&
    value.defaultOnNewBots !== undefined &&
    typeof value.defaultOnNewBots !== 'boolean'
  )
    throw new PluginError(`Invalid new bot default for plugin "${value.name}"`)
  if (
    'depends' in value &&
    value.depends !== undefined &&
    (!Array.isArray(value.depends) || !value.depends.every((item: unknown) => typeof item === 'string'))
  ) {
    throw new PluginError(`Invalid dependencies for plugin "${value.name}"`)
  }
  if ('inject' in value && value.inject !== undefined) {
    const strings = (item: unknown): item is string[] =>
      Array.isArray(item) && item.every((part: unknown) => typeof part === 'string')
    const inject = value.inject
    if (
      !strings(inject) &&
      !(
        typeof inject === 'object' &&
        inject !== null &&
        !Array.isArray(inject) &&
        Object.entries(inject).every(
          ([key, item]) => (key === 'required' || key === 'optional') && strings(item),
        )
      )
    ) {
      throw new PluginError(`Invalid service dependencies for plugin "${value.name}"`)
    }
  }
  if (
    'capabilities' in value &&
    value.capabilities !== undefined &&
    !requirementsSchema.safeParse(value.capabilities).success
  )
    throw new PluginError(`Invalid capability requirements for plugin "${value.name}"`)
  return value as PluginDefinition
}

/** 管理插件注册、依赖协调、启停、重载和服务。 */
export class PluginManager {
  private readonly app: App
  private readonly configPath?: string
  private readonly dirs: string[]
  readonly packages: PackageService
  private readonly entries = new Map<string, Entry>()
  private readonly services = new Map<string, { plugin: string; value: unknown }>()
  private readonly serviceProviders = new Map<string, string>()
  private readonly files = new Map<string, Entry>()
  private readonly duplicates: Entry[] = []
  private readonly uninstalling = new Set<string>()
  private readonly watchers: FSWatcher[] = []
  private readonly packageUpdateSubscribers = new Set<(state: PluginState) => void>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly groupConfigCache = new Map<string, unknown>()
  private releaseRoots?: () => void
  private queue: Promise<void> = Promise.resolve()
  private started = false
  private reconciling = false

  constructor(app: App, configPath?: string, packageOptions?: PackageOptions) {
    this.app = app
    this.configPath = configPath
    this.dirs = [
      ...new Set(
        [
          ...app.config.pluginLoader.dirs,
          ...(app.config.pluginLoader.uploadDir ? [app.config.pluginLoader.uploadDir] : []),
        ].map((dir) => resolve(dir)),
      ),
    ]
    this.packages = new PackageService(
      app.config.packages,
      {
        installedPackages: () => this.installedPackages(),
        latestChanged: (name) => {
          const entry = [...this.entries.values()].find((item) => item.manifest?.name === name)
          if (entry) {
            for (const subscriber of this.packageUpdateSubscribers) {
              try {
                subscriber({ ...entry.state })
              } catch (error) {
                this.app.logger.error(
                  { err: error, plugin: entry.state.name },
                  'Package update subscriber failed',
                )
              }
            }
          }
        },
        readmeFailed: (name, error) =>
          this.app.logger.warn(
            { package: name, reason: redact(errorMessage(error)) },
            'Package README unavailable',
          ),
        latestFailed: (name, error) =>
          this.app.logger.warn(
            { package: name, reason: redact(errorMessage(error)) },
            'Registry update check failed',
          ),
        subscriberFailed: (operation, error) =>
          this.app.logger.error(
            { err: error, package: operation.name, operation: operation.id },
            'Package operation subscriber failed',
          ),
        installPackage: (manifest, kind, log) => this.installPackage(manifest, kind, log),
        uninstallPackage: (name, purge, log) => this.uninstallPackage(name, purge, log),
      },
      packageOptions,
    )
  }

  register(definition: PluginDefinition): void {
    if (this.started) throw new PluginError('Built-in plugins must be registered before App.start()')
    this.add(validateDefinition(definition), 'builtin')
  }

  list(): PluginState[] {
    return [...this.entries.values(), ...this.duplicates].map((entry) => ({ ...entry.state }))
  }

  get(name: string): PluginState | undefined {
    const state = this.entries.get(name)?.state
    return state && { ...state }
  }

  provide(plugin: string, name: string, value: unknown): () => void {
    const existing = this.services.get(name)
    if (existing)
      throw new PluginError(
        `服务 ${name} 冲突：插件 "${existing.plugin}" 已提供，插件 "${plugin}" 无法重复提供`,
      )
    const service = { plugin, value }
    this.services.set(name, service)
    this.serviceProviders.set(name, plugin)
    const entry = this.require(plugin)
    entry.state.provides = [...entry.state.provides, name]
    if (entry.state.state === 'active') this.publishState(entry)
    this.requestReconcile()
    return () => {
      if (this.services.get(name) !== service) return
      this.services.delete(name)
      entry.state.provides = entry.state.provides.filter((item) => item !== name)
      if (entry.state.state === 'active') this.publishState(entry)
      this.requestReconcile()
    }
  }

  inject(name: string): unknown {
    const service = this.services.get(name)
    if (!service) throw new PluginError(`服务 ${name} 不可用`)
    return service.value
  }

  injectOptional(name: string): unknown {
    return this.services.get(name)?.value
  }

  getConfig(name: string): unknown {
    const entry = this.entries.get(name)
    const schema = entry?.definition?.config
    if (!schema) return undefined
    if (entry.context) return entry.context.config
    const value = this.app.config.plugins[name]?.config
    const result = schema.safeParse(value === undefined ? {} : value)
    return result.success ? result.data : undefined
  }

  getGroupConfig(name: string, groupKey: string): Record<string, unknown> | undefined {
    this.requireAvailable(name)
    return this.app.storage.getGroupConfig(name, groupKey)
  }

  setGroupConfig(name: string, groupKey: string, override: Record<string, unknown> | null): void {
    const entry = this.requireAvailable(name)
    const target = groupIdentity(groupKey)
    this.requireConfig(entry)
    this.validateConfig(entry, this.rawConfig(name, target, { group: override }))
    this.app.storage.setGroupConfig(name, groupKey, override)
    this.invalidateGroupConfigs(name)
  }

  setBotConfig(name: string, bot: BotIdentity, override: Record<string, unknown> | null): void {
    const entry = this.requireAvailable(name)
    this.requireConfig(entry)
    this.validateConfig(entry, this.rawConfig(name, bot, { bot: override }))
    for (const group of this.app.storage.listGroups(name)) {
      const target = groupIdentity(group.groupKey)
      if (target.platform === bot.platform && target.selfId === bot.selfId)
        this.validateConfig(entry, this.rawConfig(name, target, { bot: override }))
    }
    this.app.policies.setPlugin(bot, name, {
      ...this.app.policies.plugin(bot, name),
      config: override ?? undefined,
    })
    this.invalidateGroupConfigs(name)
  }

  setBotEnabled(name: string, bot: BotIdentity, enabled: boolean | null): void {
    this.requireAvailable(name)
    this.app.policies.setPlugin(bot, name, {
      ...this.app.policies.plugin(bot, name),
      enabled: enabled ?? undefined,
    })
  }

  private requireConfig(entry: Entry): void {
    if (!entry.definition?.config)
      throw new PluginConfigError([
        { path: `plugins.${entry.state.name}.config`, message: 'Plugin has no configuration schema' },
      ])
  }

  private rawConfig(
    name: string,
    target: BotIdentity & { groupId?: string },
    changes: {
      global?: unknown
      bot?: Record<string, unknown> | null
      group?: Record<string, unknown> | null
    } = {},
  ): unknown {
    const global = 'global' in changes ? changes.global : this.app.config.plugins[name]?.config
    const bot = 'bot' in changes ? changes.bot : this.app.policies.plugin(target, name).config
    const key = groupKeyOf(target)
    const group =
      'group' in changes
        ? changes.group
        : key === undefined
          ? undefined
          : this.app.storage.getGroupConfig(name, key)
    return mergeConfig(mergeConfig(global ?? {}, bot ?? {}), group ?? {})
  }

  configFor(name: string, target: string | (BotIdentity & { groupId?: string })): unknown {
    const destination = typeof target === 'string' ? groupIdentity(target) : target
    const key = JSON.stringify([name, destination.platform, destination.selfId, destination.groupId])
    if (this.groupConfigCache.has(key)) return this.groupConfigCache.get(key)
    const entry = this.requireAvailable(name)
    const result = this.validateConfig(entry, this.rawConfig(name, destination))
    this.groupConfigCache.set(key, result)
    return result
  }

  configSources(name: string, target: BotIdentity & { groupId?: string }): Record<string, string> {
    const key = groupKeyOf(target)
    const layers = [
      ['global', this.app.config.plugins[name]?.config],
      ['bot', this.app.policies.plugin(target, name).config],
      ['group', key === undefined ? undefined : this.app.storage.getGroupConfig(name, key)],
    ] as const
    const sources: Record<string, string> = {}
    const walk = (value: unknown, path: string[]) => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, item] of Object.entries(value)) walk(item, [...path, key])
        return
      }
      let source = 'default'
      for (const [name, config] of layers) {
        let current = config
        for (const part of path)
          current =
            current !== null && typeof current === 'object' && Object.hasOwn(current, part)
              ? (current as Record<string, unknown>)[part]
              : undefined
        if (current !== undefined) source = name
      }
      sources[path.join('.')] = source
    }
    walk(this.configFor(name, target), [])
    return sources
  }

  private invalidateGroupConfigs(name: string): void {
    for (const key of this.groupConfigCache.keys()) {
      if ((JSON.parse(key) as string[])[0] === name) this.groupConfigCache.delete(key)
    }
  }

  async start(): Promise<void> {
    this.started = true
    await this.packages.init()
    this.releaseRoots = registerPluginRoots([...this.dirs, this.packages.dir])
    for (const { definition } of this.entries.values()) {
      if (definition) await this.initializeDefaultOnNewBots(definition)
    }
    for (const dir of this.dirs) await this.discover(dir)
    for (const name of Object.keys(await this.packages.dependencies())) {
      let manifest: PackageManifest | undefined
      try {
        manifest = await this.packages.manifest(name)
        if (manifest.keywords?.includes('asabot-plugin')) await this.addPackage(manifest)
      } catch (error) {
        this.app.logger.error({ err: error, package: name }, 'Failed to load plugin package')
        if (manifest?.keywords?.includes('asabot-plugin')) {
          const base =
            name
              .replace(/^@/, '')
              .replace(/[^a-z0-9_-]+/g, '-')
              .replace(/^[^a-z0-9]+/, '') || 'package'
          let pluginName = base
          let suffix = 1
          while (this.entries.has(pluginName) || pluginName === 'core') pluginName = `${base}-${suffix++}`
          const state: PluginState = {
            name: pluginName,
            source: 'package',
            state: 'failed',
            enabled: this.app.config.plugins[pluginName]?.enabled ?? true,
            provides: [],
            inject: [],
            error: errorMessage(error),
          }
          this.entries.set(pluginName, { state, manifest, files: new Set(), failure: 'import' })
        }
      }
    }
    await this.reconcile()
  }

  async watch(): Promise<void> {
    const enabled = this.app.config.pluginLoader.hotReload
    if (enabled === false || (enabled === 'auto' && process.env.NODE_ENV === 'production')) return
    for (const dir of this.dirs) {
      await mkdir(dir, { recursive: true })
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (filename !== null && ignoredEntry(filename.toString().split(/[\\/]/, 1)[0] as string)) return
        const path = filename === null ? dir : resolve(dir, filename.toString())
        const existing = this.timers.get(path)
        if (existing) clearTimeout(existing)
        this.timers.set(
          path,
          setTimeout(() => {
            this.timers.delete(path)
            void this.serial(async () => this.handleChange(dir, path)).catch((error: unknown) => {
              this.app.logger.error({ err: error, path }, 'Plugin hot reload failed')
            })
          }, 300),
        )
      })
      watcher.on('error', (error) => this.app.logger.error({ err: error, dir }, 'Plugin watcher failed'))
      this.watchers.push(watcher)
    }
  }

  async stopWatching(): Promise<void> {
    for (const watcher of this.watchers.splice(0)) watcher.close()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await this.queue
  }

  async stop(): Promise<void> {
    await this.stopWatching()
    await this.packages.whenIdle()
    this.started = false
    for (const entry of this.ordered().reverse()) {
      if (entry.context) await this.unload(entry)
      this.setState(entry, 'disabled')
    }
    for (const entry of [...this.entries.values(), ...this.duplicates]) entry.release?.()
    this.releaseRoots?.()
    this.releaseRoots = undefined
  }

  enable(name: string): Promise<void> {
    return this.serial(async () => {
      const entry = this.requireAvailable(name)
      await this.persist(name, 'enabled', true)
      this.entryConfig(name).enabled = true
      entry.state.enabled = true
      entry.failure = undefined
      await this.reconcile()
    })
  }

  disable(name: string): Promise<void> {
    return this.serial(async () => {
      const entry = this.requireAvailable(name)
      await this.persist(name, 'enabled', false)
      this.entryConfig(name).enabled = false
      entry.state.enabled = false
      await this.reconcile()
    })
  }

  reload(name: string): Promise<void> {
    return this.serial(async () => {
      const entry = this.requireAvailable(name)
      if (entry.manifest && !entry.definition && !entry.state.path) {
        const path = await this.packageEntry(entry.manifest)
        entry.state.path = path
        this.files.set(path, entry)
      }
      await this.reloadEntry(entry)
    })
  }

  rescan(): Promise<{ added: string[]; removed: string[] }> {
    return this.serial(async () => this.rescanFiles())
  }

  upload(filename: string, content: string, overwrite = false): Promise<PluginState> {
    return this.serial(async () => {
      const upload = uploadContents(filename, content)
      const configured = this.app.config.pluginLoader.uploadDir
      if (!configured) throw new ManagementError(400, 'No upload directory is configured')
      const root = resolve(configured)
      await mkdir(root, { recursive: true })
      const target = join(root, upload.directory ? upload.name : filename)
      let existing = false
      try {
        const info = await lstat(target)
        if (info.isSymbolicLink()) throw new ManagementError(409, 'Plugin destination is a symbolic link')
        existing = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (existing && !overwrite) throw new ManagementError(409, 'Plugin destination already exists')
      const old = [...this.files.values()].find(
        (entry) =>
          entry.state.source === 'file' &&
          entry.state.path &&
          (entry.state.path === target || dirname(entry.state.path) === target),
      )
      const staging = await mkdtemp(join(root, '.upload-'))
      try {
        if (upload.directory) {
          for (const [path, bytes] of upload.files) {
            const destination = resolve(staging, ...path.split('/'))
            this.ensureInside(staging, destination)
            await mkdir(dirname(destination), { recursive: true })
            await writeFile(destination, bytes, { flag: 'wx' })
          }
          if (existing) {
            await this.ensureRealInside(root, target)
            await rm(target, { recursive: true, force: true })
          }
          await rename(staging, target)
        } else {
          const temporary = join(staging, filename)
          await writeFile(temporary, upload.files.get(filename) as Uint8Array, { flag: 'wx' })
          if (existing) {
            await this.ensureRealInside(root, target)
            await rm(target, { recursive: true, force: true })
          }
          await rename(temporary, target)
        }
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      if (old) {
        const newPath = upload.directory
          ? join(target, upload.files.has('index.ts') ? 'index.ts' : 'index.js')
          : target
        if (old.state.path !== newPath) {
          if (old.state.path) this.files.delete(old.state.path)
          old.state.path = newPath
          this.files.set(newPath, old)
        }
        try {
          await this.reloadEntry(old)
        } catch (error) {
          await this.unload(old)
          old.definition = undefined
          old.failure = 'import'
          this.setState(old, 'failed', errorMessage(error))
          await this.reconcile()
        }
      } else await this.rescanFiles()
      const entry = [...this.files.values()].find(
        (item) => item.state.path && (item.state.path === target || dirname(item.state.path) === target),
      )
      if (!entry) throw new ManagementError(400, 'Uploaded plugin entry was not found')
      if (entry.failure === 'duplicate') {
        await this.removeEntries([entry])
        await this.ensureRealInside(root, target)
        await rm(target, { recursive: true, force: true })
        await this.reconcile()
        throw new ManagementError(409, 'Duplicate plugin name')
      }
      return { ...entry.state }
    })
  }

  uninstall(name: string, purge = false): Promise<void> {
    const entry = this.requireAvailable(name)
    if (entry.manifest) return this.packages.uninstallAndWait(entry.manifest.name, purge)
    return this.serial(async () => {
      const entry = this.requireAvailable(name)
      if (entry.state.source === 'builtin')
        throw new ManagementError(409, 'Built-in plugins cannot be uninstalled')
      if (entry.manifest) throw new ManagementError(409, 'Plugin source changed during uninstall')
      const path = entry.state.path as string
      const root = this.dirs.find((dir) => this.isInside(dir, path))
      if (!root) throw new ManagementError(409, 'Plugin is outside plugin directories')
      const target = basename(path) === 'index.ts' || basename(path) === 'index.js' ? dirname(path) : path
      await this.ensureRealInside(root, target)
      const enabled = entry.state.enabled
      await this.removeEntries([entry])
      try {
        await rm(target, { recursive: true, force: true })
      } catch (error) {
        entry.state.enabled = enabled
        this.entries.set(name, entry)
        this.files.set(path, entry)
        await this.reconcile()
        throw error
      }
      if (purge) await this.purge(name)
      await this.reconcile()
    })
  }

  packageInfo(name: string) {
    const manifest = this.entries.get(name)?.manifest
    return manifest ? this.packages.info(manifest) : undefined
  }

  packageReadme(name: string): Promise<string | undefined> {
    const manifest = this.entries.get(name)?.manifest
    if (!manifest) throw new ManagementError(404, 'Plugin package is not installed')
    return this.packages.installedReadme(manifest)
  }

  subscribePackageUpdates(subscriber: (state: PluginState) => void): () => void {
    this.packageUpdateSubscribers.add(subscriber)
    return () => this.packageUpdateSubscribers.delete(subscriber)
  }

  updateConfig(name: string, value: unknown): Promise<void> {
    return this.serial(async () => {
      const entry = this.requireAvailable(name)
      this.validateConfig(entry, value)
      for (const bot of this.app.policies.configured(name))
        this.validateConfig(entry, this.rawConfig(name, bot, { global: value }))
      for (const group of this.app.storage.listGroups(name))
        this.validateConfig(entry, this.rawConfig(name, groupIdentity(group.groupKey), { global: value }))
      await this.persist(name, 'config', value)
      this.entryConfig(name).config = value
      this.invalidateGroupConfigs(name)
      await this.reloadEntry(entry)
    })
  }

  setDefaultOnNewBots(name: string, enabled: boolean): Promise<void> {
    return this.serial(async () => {
      const entry = this.requireAvailable(name)
      await this.persist(name, 'defaultOnNewBots', enabled)
      this.entryConfig(name).defaultOnNewBots = enabled
      this.publishState(entry)
    })
  }

  defaultsForNewBot(): string[] {
    return [...this.entries.keys()].filter((name) => this.app.config.plugins[name]?.defaultOnNewBots)
  }

  setGroupEnabled(name: string, groupKey: string, enabled: boolean): void {
    this.requireAvailable(name)
    this.app.storage.setGroupEnabled(name, groupKey, enabled)
  }

  isEnabledOnBot(name: string, bot: BotIdentity): boolean {
    return (
      name === 'core' ||
      (this.entries.get(name)?.state.enabled !== false &&
        (this.app.policies.plugin(bot, name).enabled ?? this.app.policies.defaultPluginEnabled(bot, name)))
    )
  }

  isEnabledFor(name: string, event: BotIdentity & { groupId?: string }): boolean {
    if (name === 'core') return true
    const groupKey = groupKeyOf(event)
    return (
      this.isEnabledOnBot(name, event) &&
      (groupKey === undefined || this.app.storage.isGroupEnabled(name, groupKey))
    )
  }

  serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work)
    this.queue = result
      .then(() => undefined)
      .catch((error: unknown) => {
        this.app.logger.debug({ err: error }, 'Plugin operation failed')
      })
    return result
  }

  private requestReconcile(): void {
    if (!this.started || this.reconciling) return
    void this.serial(() => this.reconcile()).catch((error: unknown) => {
      this.app.logger.error({ err: error }, 'Service reconciliation failed')
    })
  }

  private require(name: string): Entry {
    const entry = this.entries.get(name)
    if (!entry) throw new PluginError(`Unknown plugin "${name}"`)
    return entry
  }

  private requireAvailable(name: string): Entry {
    const entry = this.require(name)
    if (this.uninstalling.has(name)) throw new ManagementError(409, 'Plugin package is being uninstalled')
    return entry
  }

  private entryConfig(name: string) {
    this.app.config.plugins[name] ??= { enabled: true }
    return this.app.config.plugins[name]
  }

  private async initializeDefaultOnNewBots({ name, defaultOnNewBots = false }: PluginDefinition) {
    if (this.app.config.plugins[name]?.defaultOnNewBots !== undefined) return
    await this.persist(name, 'defaultOnNewBots', defaultOnNewBots)
    this.entryConfig(name).defaultOnNewBots = defaultOnNewBots
  }

  private async persist(
    name: string,
    field: 'enabled' | 'defaultOnNewBots' | 'config',
    value: unknown,
  ): Promise<void> {
    if (this.configPath) {
      await writeConfigValue(
        this.configPath,
        ['plugins', name, field],
        value,
        field === 'config' ? { previousValue: this.app.config.plugins[name]?.config } : undefined,
      )
    } else this.app.logger.debug({ plugin: name, field }, 'Plugin configuration changed in memory only')
  }

  private add(
    definition: PluginDefinition,
    source: 'builtin' | 'file' | 'package',
    path?: string,
    files = new Set<string>(),
    release?: () => void,
  ): Entry {
    const name = definition.name
    const state: PluginState = {
      name,
      source,
      ...(path === undefined ? {} : { path }),
      state: 'disabled',
      enabled: this.app.config.plugins[name]?.enabled ?? true,
      provides: [],
      inject: [],
      capabilities: definition.capabilities,
    }
    const entry: Entry = { state, definition, files, release }
    this.metadata(entry)
    if (this.entries.has(name)) {
      entry.failure = 'duplicate'
      entry.state.state = 'failed'
      entry.state.error = `Duplicate plugin name "${name}"`
      this.duplicates.push(entry)
    } else this.entries.set(name, entry)
    if (path) this.files.set(path, entry)
    return entry
  }

  private metadata(entry: Entry): void {
    const definition = entry.definition
    if (!definition) return
    entry.state.capabilities = definition.capabilities
    entry.state.version = definition.version
    entry.state.description = definition.description
    entry.state.depends = definition.depends
    const dependencies = serviceDependencies(definition.inject)
    entry.state.inject = [
      ...dependencies.required.map((name) => ({ name, optional: false })),
      ...dependencies.optional.map((name) => ({ name, optional: true })),
    ]
    entry.state.configSchema = definition.config
      ? z.toJSONSchema(definition.config, { unrepresentable: 'any' })
      : undefined
  }

  private async discover(dir: string): Promise<void> {
    let names: Dirent<string>[]
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const item of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignoredEntry(item.name)) continue
      let path: string | undefined
      if (item.isFile() && /\.(ts|js)$/.test(item.name) && !item.name.endsWith('.d.ts'))
        path = join(dir, item.name)
      else if (item.isDirectory()) {
        for (const index of [join(dir, item.name, 'index.ts'), join(dir, item.name, 'index.js')]) {
          try {
            if ((await stat(index)).isFile()) {
              path = index
              break
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
      if (!path || this.files.has(path)) continue
      try {
        const imported = await importPlugin(path)
        try {
          const definition = validateDefinition(imported.value)
          if (!this.entries.has(definition.name)) await this.initializeDefaultOnNewBots(definition)
          this.add(definition, 'file', path, imported.files, imported.release)
        } catch (error) {
          imported.release()
          throw error
        }
      } catch (error) {
        const name = /^index\.(ts|js)$/.test(basename(path))
          ? basename(resolve(path, '..'))
          : basename(path, extname(path))
        const state: PluginState = {
          name,
          source: 'file',
          path,
          state: 'failed',
          enabled: this.app.config.plugins[name]?.enabled ?? true,
          provides: [],
          inject: [],
          error: errorMessage(error),
        }
        const entry: Entry = { state, files: new Set([path]), failure: 'import' }
        if (this.entries.has(name)) this.duplicates.push(entry)
        else this.entries.set(name, entry)
        this.files.set(path, entry)
        this.app.logger.error({ err: error, path }, 'Failed to import plugin')
      }
    }
  }

  private isInside(root: string, path: string): boolean {
    const rel = relative(root, path)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  }

  private ensureInside(root: string, path: string): void {
    if (!this.isInside(root, path)) throw new ManagementError(400, 'Path is outside the plugin directory')
  }

  private async ensureRealInside(root: string, path: string): Promise<void> {
    const [actualRoot, actualPath] = await Promise.all([realpath(root), realpath(path)])
    if (!this.isInside(actualRoot, actualPath))
      throw new ManagementError(409, 'Plugin path is outside its directory')
  }

  private async purge(name: string): Promise<void> {
    if (this.configPath) await deleteConfigValue(this.configPath, ['plugins', name])
    delete this.app.config.plugins[name]
    this.app.storage.purgePlugin(name)
    this.app.policies.load()
    this.invalidateGroupConfigs(name)
    const path = join(this.app.config.dataDir, 'plugins', name)
    try {
      await this.ensureRealInside(this.app.config.dataDir, path)
      await rm(path, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async removeEntries(entries: Entry[]): Promise<void> {
    for (const entry of entries) entry.state.enabled = false
    await this.reconcile()
    for (const entry of entries) {
      if (this.entries.get(entry.state.name) === entry) this.entries.delete(entry.state.name)
      const duplicate = this.duplicates.indexOf(entry)
      if (duplicate !== -1) this.duplicates.splice(duplicate, 1)
      if (entry.state.path) this.files.delete(entry.state.path)
      entry.release?.()
    }
  }

  private async rescanFiles(): Promise<{ added: string[]; removed: string[] }> {
    const previous = new Set(this.files.keys())
    const missing: Entry[] = []
    for (const [path, entry] of this.files) {
      if (entry.state.source !== 'file') continue
      try {
        if (!(await stat(path)).isFile()) missing.push(entry)
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        missing.push(entry)
      }
    }
    if (missing.length) await this.removeEntries(missing)
    for (const dir of this.dirs) await this.discover(dir)
    await this.reconcile()
    return {
      added: [...this.files]
        .filter(([path, entry]) => !previous.has(path) && entry.state.source === 'file')
        .map(([, entry]) => entry.state.name),
      removed: missing.map((entry) => entry.state.name),
    }
  }

  private installedPackages(): Map<string, { manifest: PackageManifest; plugin: string }> {
    const result = new Map<string, { manifest: PackageManifest; plugin: string }>()
    for (const entry of this.entries.values()) {
      if (entry.manifest)
        result.set(entry.manifest.name, { manifest: entry.manifest, plugin: entry.state.name })
    }
    return result
  }

  private async packageEntry(manifest: PackageManifest): Promise<string> {
    if (manifest.type !== 'module') throw new ManagementError(400, 'Plugin package must be ESM')
    const select = (value: unknown): string | undefined => {
      if (typeof value === 'string') return value
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = select(item)
          if (found) return found
        }
      } else if (value && typeof value === 'object') {
        for (const [condition, item] of Object.entries(value)) {
          if (['import', 'node', 'default'].includes(condition)) {
            const found = select(item)
            if (found) return found
          }
        }
      }
      return undefined
    }
    let exports = manifest.exports
    if (
      exports &&
      typeof exports === 'object' &&
      !Array.isArray(exports) &&
      Object.keys(exports).some((key) => key.startsWith('.'))
    )
      exports = (exports as Record<string, unknown>)['.']
    const target = manifest.exports === undefined ? (manifest.main ?? 'index.js') : select(exports)
    if (!target || !/\.(?:js|mjs)$/.test(target))
      throw new ManagementError(400, 'Plugin package entry must be JavaScript')
    const root = this.packages.packageRoot(manifest.name)
    const path = resolve(root, target)
    this.ensureInside(root, path)
    await this.ensureRealInside(root, path)
    return path
  }

  private async addPackage(manifest: PackageManifest, existing?: Entry): Promise<Entry> {
    const path = await this.packageEntry(manifest)
    const imported = await importPlugin(path)
    try {
      const definition = validateDefinition(imported.value)
      const conflict = this.entries.get(definition.name)
      if (conflict && conflict !== existing)
        throw new ManagementError(409, `Duplicate plugin name "${definition.name}"`)
      if (existing?.definition && definition.name !== existing.state.name)
        throw new ManagementError(409, 'Updated package changed its plugin name')
      if (!existing) {
        await this.initializeDefaultOnNewBots(definition)
        const entry = this.add(definition, 'package', path, imported.files, imported.release)
        entry.manifest = manifest
        return entry
      }
      const oldPath = existing.state.path
      const oldManifest = existing.manifest
      existing.state.path = path
      existing.manifest = manifest
      // reloadEntry imports the validated path and cascades to dependents.
      try {
        await this.reloadEntry(existing)
      } catch (error) {
        existing.state.path = oldPath
        existing.manifest = oldManifest
        throw error
      }
      if (oldPath) this.files.delete(oldPath)
      this.files.set(path, existing)
      imported.release()
      return existing
    } catch (error) {
      imported.release()
      throw error
    }
  }

  private async installPackage(
    manifest: PackageManifest,
    kind: 'install' | 'update',
    log: (line: string) => void,
  ): Promise<PluginState> {
    const previous = [...this.entries.values()].find((entry) => entry.manifest?.name === manifest.name)
    if (kind === 'update' && !previous) throw new ManagementError(404, 'Package is not installed')
    const oldManifest = previous?.manifest
    const spec = `${manifest.name}@${kind === 'update' ? 'latest' : manifest.version}`
    await this.packages.runNpm(this.packages.installArgs(spec), log)
    try {
      return await this.serial(async () => {
        const installed = await this.packages.manifest(manifest.name)
        if (
          installed.name !== manifest.name ||
          installed.version !== manifest.version ||
          !installed.keywords?.includes('asabot-plugin')
        )
          throw new ManagementError(409, 'Installed package does not match registry metadata')
        if (previous && this.entries.get(previous.state.name) !== previous)
          throw new ManagementError(409, 'Plugin changed during package installation')
        const entry = await this.addPackage(installed, previous)
        await this.reconcile()
        return { ...entry.state }
      })
    } catch (error) {
      try {
        if (oldManifest)
          await this.packages.runNpm(
            this.packages.installArgs(`${oldManifest.name}@${oldManifest.version}`),
            log,
          )
        else
          await this.packages.runNpm(
            ['uninstall', manifest.name, '--ignore-scripts', '--no-audit', '--no-fund'],
            log,
          )
      } catch (rollback) {
        throw new Error(`${errorMessage(error)}; npm rollback failed: ${errorMessage(rollback)}`)
      }
      throw error
    }
  }

  private async uninstallPackage(name: string, purge: boolean, log: (line: string) => void): Promise<void> {
    const { entry, enabled } = await this.serial(async () => {
      const entry = [...this.entries.values()].find((item) => item.manifest?.name === name)
      if (!entry) throw new ManagementError(404, 'Package is not installed')
      const enabled = entry.state.enabled
      this.uninstalling.add(entry.state.name)
      entry.state.enabled = false
      try {
        await this.reconcile()
      } catch (error) {
        entry.state.enabled = enabled
        this.uninstalling.delete(entry.state.name)
        throw error
      }
      return { entry, enabled }
    })
    try {
      await this.packages.runNpm(['uninstall', name, '--ignore-scripts', '--no-audit', '--no-fund'], log)
    } catch (error) {
      await this.serial(async () => {
        entry.state.enabled = enabled
        this.uninstalling.delete(entry.state.name)
        await this.reconcile()
      })
      throw error
    }
    await this.serial(async () => {
      this.uninstalling.delete(entry.state.name)
      await this.removeEntries([entry])
      if (purge) await this.purge(entry.state.name)
      await this.reconcile()
    })
  }

  private ordered(): Entry[] {
    const result: Entry[] = []
    const visited = new Set<string>()
    const visit = (entry: Entry): void => {
      if (visited.has(entry.state.name)) return
      visited.add(entry.state.name)
      for (const dependency of entry.definition?.depends ?? []) {
        const target = this.entries.get(dependency)
        if (target) visit(target)
      }
      for (const { name: service } of entry.state.inject) {
        const provider = this.services.get(service)?.plugin ?? this.serviceProviders.get(service)
        const target = provider && this.entries.get(provider)
        if (target) visit(target)
      }
      result.push(entry)
    }
    for (const entry of this.entries.values()) visit(entry)
    return result
  }

  private cycleNames(): Set<string> {
    const visiting: string[] = []
    const done = new Set<string>()
    const cycles = new Set<string>()
    const visit = (name: string): void => {
      const index = visiting.indexOf(name)
      if (index !== -1) {
        for (const item of visiting.slice(index)) cycles.add(item)
        return
      }
      if (done.has(name)) return
      visiting.push(name)
      for (const dependency of this.entries.get(name)?.definition?.depends ?? []) {
        if (this.entries.has(dependency)) visit(dependency)
      }
      visiting.pop()
      done.add(name)
    }
    for (const name of this.entries.keys()) visit(name)
    return cycles
  }

  private async reconcile(): Promise<void> {
    this.reconciling = true
    try {
      while (true) {
        const before = JSON.stringify([...this.entries.values()].map((entry) => [entry.state, entry.failure]))
        const ordered = this.ordered()
        const cycles = this.cycleNames()
        const unavailable = new Set<string>()
        for (const entry of ordered) {
          if (
            !entry.state.enabled ||
            cycles.has(entry.state.name) ||
            !entry.definition ||
            (entry.failure !== undefined && entry.failure !== 'dependency')
          )
            unavailable.add(entry.state.name)
        }
        let changed = true
        while (changed) {
          changed = false
          for (const entry of ordered) {
            if (unavailable.has(entry.state.name)) continue
            const badDependency = entry.definition?.depends?.some(
              (dep) => !this.entries.has(dep) || unavailable.has(dep),
            )
            const badService = serviceDependencies(entry.definition?.inject).required.some((name) => {
              const provider = this.services.get(name)
              return !provider || unavailable.has(provider.plugin)
            })
            if (badDependency || badService) {
              unavailable.add(entry.state.name)
              changed = true
            }
          }
        }
        const affected = new Set<string>()
        for (const entry of ordered) {
          if (!entry.context) continue
          for (const name of serviceDependencies(entry.definition?.inject).optional) {
            const service = this.services.get(name)
            const available = service && !unavailable.has(service.plugin) ? service : undefined
            if (entry.optionalServices?.get(name) !== available) affected.add(entry.state.name)
          }
        }
        let cascading = true
        while (cascading) {
          cascading = false
          for (const entry of ordered) {
            if (!entry.context || affected.has(entry.state.name)) continue
            const depends = entry.definition?.depends?.some((name) => affected.has(name))
            const injects = entry.state.inject.some(({ name }) => {
              const service = this.services.get(name)
              return service !== undefined && affected.has(service.plugin)
            })
            if (depends || injects) {
              affected.add(entry.state.name)
              cascading = true
            }
          }
        }
        for (const entry of [...ordered].reverse()) {
          if (entry.context && (unavailable.has(entry.state.name) || affected.has(entry.state.name))) {
            await this.unload(entry)
          }
        }
        for (const entry of ordered) {
          if (!entry.state.enabled) {
            entry.failure = undefined
            this.setState(entry, 'disabled')
            continue
          }
          if (cycles.has(entry.state.name)) {
            entry.failure = 'dependency'
            this.setState(entry, 'failed', 'Dependency cycle detected')
            continue
          }
          if (!entry.definition || (entry.failure && entry.failure !== 'dependency')) continue
          const missing = entry.definition.depends?.find(
            (name) => this.entries.get(name)?.state.state !== 'active',
          )
          if (missing) {
            if (entry.context) await this.unload(entry)
            entry.failure = 'dependency'
            this.setState(entry, 'failed', `依赖 ${missing} 未激活`)
            continue
          }
          const missingService = serviceDependencies(entry.definition.inject).required.find(
            (name) => !this.services.has(name),
          )
          if (missingService) {
            if (entry.context) await this.unload(entry)
            entry.failure = 'dependency'
            this.setState(entry, 'failed', `服务 ${missingService} 不可用`)
            continue
          }
          if (!entry.context) await this.load(entry)
        }
        const after = JSON.stringify([...this.entries.values()].map((entry) => [entry.state, entry.failure]))
        if (before === after) break
      }
    } finally {
      this.reconciling = false
    }
  }

  private validateConfig(entry: Entry, value: unknown): unknown {
    const schema = entry.definition?.config
    if (!schema) return undefined
    const result = schema.safeParse(value === undefined ? {} : value)
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: `plugins.${entry.state.name}.config${issue.path.map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`)).join('')}`,
        message: issue.message,
      }))
      throw new PluginConfigError(issues)
    }
    return result.data
  }

  private async load(entry: Entry): Promise<void> {
    this.setState(entry, 'loading')
    let context: Context<unknown> | undefined
    try {
      const value = this.app.config.plugins[entry.state.name]?.config
      if (!entry.definition?.config && value !== undefined)
        this.app.logger.warn({ plugin: entry.state.name }, 'Plugin has configuration but no schema')
      const parsed = this.validateConfig(entry, value)
      entry.optionalServices = new Map(
        serviceDependencies(entry.definition?.inject).optional.map((name) => [name, this.services.get(name)]),
      )
      context = new Context(this.app, entry.state.name, parsed, entry.definition?.inject)
      let timedOut = false
      let timer: NodeJS.Timeout | undefined
      const setup = Promise.resolve().then(() =>
        pluginExecution.run(entry.state.name, () => entry.definition?.setup(context as Context<unknown>)),
      )
      void setup.catch((error: unknown) => {
        if (timedOut)
          this.app.logger.error({ err: error, plugin: entry.state.name }, 'Plugin setup failed after timeout')
      })
      try {
        await Promise.race([
          setup,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true
              reject(new PluginError('setup 超时'))
            }, this.app.config.pluginLoader.setupTimeout)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
      entry.context = context
      entry.failure = undefined
      this.setState(entry, 'active')
      context.activateTasks()
    } catch (error) {
      await context?.dispose()
      entry.failure = 'setup'
      this.setState(entry, 'failed', errorMessage(error))
      this.app.logger.error({ err: error, plugin: entry.state.name }, 'Plugin setup failed')
    }
  }

  private async unload(entry: Entry): Promise<void> {
    const context = entry.context
    entry.context = undefined
    await context?.dispose()
  }

  private async reloadEntry(entry: Entry): Promise<void> {
    this.invalidateGroupConfigs(entry.state.name)
    let definition = entry.definition
    let files = entry.files
    let release: (() => void) | undefined
    if (entry.state.path) {
      try {
        const imported = await importPlugin(entry.state.path)
        release = imported.release
        definition = validateDefinition(imported.value)
        if (definition.name !== entry.state.name && (entry.definition || this.entries.has(definition.name)))
          throw new PluginError(`Plugin name changed from "${entry.state.name}" to "${definition.name}"`)
        await this.initializeDefaultOnNewBots(definition)
        if (definition.name !== entry.state.name) {
          this.entries.delete(entry.state.name)
          entry.state.name = definition.name
          entry.state.enabled = this.app.config.plugins[definition.name]?.enabled ?? true
          this.entries.set(definition.name, entry)
        }
        files = imported.files
      } catch (error) {
        release?.()
        this.app.logger.error(
          { err: error, plugin: entry.state.name },
          'Plugin import failed; previous instance retained',
        )
        throw error
      }
    }
    const affected = new Set([entry.state.name])
    const ordered = this.ordered()
    let changed = true
    while (changed) {
      changed = false
      for (const item of ordered) {
        if (
          !affected.has(item.state.name) &&
          (item.definition?.depends?.some((dep) => affected.has(dep)) ||
            item.state.inject.some(({ name }) => {
              const provider = this.services.get(name)
              return provider !== undefined && affected.has(provider.plugin)
            }))
        ) {
          affected.add(item.state.name)
          changed = true
        }
      }
    }
    for (const item of [...ordered].reverse()) {
      if (affected.has(item.state.name)) {
        await this.unload(item)
        item.failure = undefined
        this.setState(item, 'disabled')
      }
    }
    entry.definition = definition
    entry.files = files
    entry.release?.()
    entry.release = release
    this.metadata(entry)
    await this.reconcile()
  }

  private async handleChange(dir: string, path: string): Promise<void> {
    const removed: Entry[] = []
    for (const [entryPath, entry] of this.files) {
      if (entry.state.source !== 'file') continue
      try {
        if (!(await stat(entryPath)).isFile()) removed.push(entry)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
        removed.push(entry)
      }
    }
    if (removed.length > 0) {
      // Reconcile before removing entries so dependents are disposed before their dependencies.
      for (const entry of removed) entry.state.enabled = false
      await this.reconcile()
      for (const entry of removed) {
        if (this.entries.get(entry.state.name) === entry) this.entries.delete(entry.state.name)
        const duplicate = this.duplicates.indexOf(entry)
        if (duplicate !== -1) this.duplicates.splice(duplicate, 1)
        if (entry.state.path) this.files.delete(entry.state.path)
        entry.release?.()
      }
    }
    const previous = new Set(this.files.keys())
    await this.discover(dir)
    const affected = [...this.entries.values()].filter(
      (entry) =>
        entry.state.path &&
        previous.has(entry.state.path) &&
        (entry.files.has(path) || entry.state.path === path),
    )
    for (const entry of affected) {
      try {
        await this.reloadEntry(entry)
      } catch (error) {
        this.app.logger.debug({ err: error, plugin: entry.state.name }, 'Plugin change could not be applied')
      }
    }
    await this.reconcile()
  }

  private setState(entry: Entry, state: PluginState['state'], error?: string): void {
    if (entry.state.state === state && entry.state.error === error) return
    entry.state.state = state
    entry.state.error = error
    this.publishState(entry)
  }

  private publishState(entry: Entry): void {
    const bot = this.app.bots.list().find((item) => item.status === 'online')
    this.app.emitPluginState({
      id: randomUUID(),
      platform: bot?.platform ?? 'core',
      selfId: bot?.selfId ?? '',
      time: Date.now(),
      kind: 'internal',
      name: 'plugin.state',
      raw: undefined,
      ...(bot ? { bot } : {}),
      plugin: { ...entry.state },
    })
  }
}
