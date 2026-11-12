import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type NpmExecutor,
  npmEnvironment,
  type PackageManifest,
  PackageService,
  type RegistryClient,
} from './packages.ts'

describe('package operation contract', () => {
  it('caches latest metadata and leaves it absent when registry lookup fails', async () => {
    const manifest: PackageManifest = {
      name: 'asabot-example',
      version: '1.0.0',
      keywords: ['asabot-plugin'],
      peerDependencies: { asabot: '^0.1.0' },
    }
    let calls = 0
    let fail = false
    const registry: RegistryClient = {
      async fullMetadata() {
        throw new Error('not used')
      },
      async metadata() {
        calls++
        if (fail) throw new Error('registry unavailable')
        return { name: manifest.name, 'dist-tags': { latest: '2.0.0' }, versions: {} }
      },
      async search() {
        return { total: 0, items: [] }
      },
    }
    const host = {
      installedPackages: () => new Map([[manifest.name, { manifest, plugin: 'example' }]]),
      latestChanged() {},
      latestFailed() {},
      subscriberFailed() {},
      async installPackage() {
        return {
          name: 'example',
          source: 'package' as const,
          state: 'active' as const,
          enabled: true,
          provides: [],
          inject: [],
        }
      },
      async uninstallPackage() {},
    }
    const config = { dir: '.', registry: 'http://127.0.0.1:1', npm: 'npm', installTimeout: 1000 }
    const service = new PackageService(config, host, { registry })
    await service.ensureLatest()
    expect(service.info(manifest).latest).toBe('2.0.0')
    await service.ensureLatest()
    expect(calls).toBe(1)
    fail = true
    const offline = new PackageService(config, host, { registry })
    await offline.ensureLatest()
    expect(offline.info(manifest).latest).toBeUndefined()
  })

  it('limits and redacts operation logs and restores package.json on npm failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asabot-package-test-'))
    const manifest: PackageManifest = {
      name: 'asabot-example',
      version: '1.0.0',
      keywords: ['asabot-plugin'],
      peerDependencies: { asabot: '^0.1.0' },
    }
    const registry: RegistryClient = {
      async fullMetadata() {
        throw new Error('not used')
      },
      async metadata() {
        return {
          name: manifest.name,
          'dist-tags': { latest: manifest.version },
          versions: { '1.0.0': manifest },
        }
      },
      async search() {
        return { total: 0, items: [] }
      },
    }
    let fail = false
    const npm: NpmExecutor = {
      async run(_args, log) {
        if (fail) {
          await writeFile(join(dir, 'package.json'), '{"broken":true}')
          throw new Error('npm timed out')
        }
        for (let i = 0; i < 220; i++) log(`line ${i}`)
        log('_authToken=secret-value')
      },
    }
    let service: PackageService
    service = new PackageService(
      { dir, registry: 'http://127.0.0.1:1', npm: 'npm', installTimeout: 1000 },
      {
        installedPackages: () => new Map(),
        latestChanged() {},
        latestFailed() {},
        subscriberFailed() {},
        async installPackage(_manifest, _kind, log) {
          await service.runNpm(['install'], log)
          return {
            name: 'example',
            source: 'package',
            state: 'active',
            enabled: true,
            provides: [],
            inject: [],
          }
        },
        async uninstallPackage() {},
      },
      { registry, npm },
    )
    try {
      expect(npmEnvironment('data/packages', 'http://127.0.0.1:1').npm_config_cache).toBe(
        resolve('data/packages/.npm-cache'),
      )
      await service.init()
      const finished = new Promise<void>((resolve) => {
        service.subscribe((operation) => {
          if (operation.status === 'succeeded') resolve()
        })
      })
      await service.install(manifest.name)
      await finished
      const operation = service.list()[0]
      expect(operation?.log).toHaveLength(200)
      expect(operation?.log.at(-1)).toBe('_authToken=[Redacted]')
      const before = await readFile(join(dir, 'package.json'), 'utf8')
      fail = true
      await expect(service.runNpm(['install'], () => {})).rejects.toThrow('npm timed out')
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
