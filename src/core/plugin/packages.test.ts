import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  type NpmExecutor,
  npmEnvironment,
  type PackageManifest,
  PackageService,
  type RegistryClient,
  readmeFromTarball,
} from './packages.ts'

describe('package operation contract', () => {
  it('caches latest metadata and leaves it absent when registry lookup fails', async () => {
    const manifest: PackageManifest = {
      name: 'asabot-example',
      version: '1.0.0',
      keywords: ['asabot-plugin'],
      peerDependencies: { '@asabot/core': '^0.1.0' },
    }
    let calls = 0
    let fail = false
    const registry: RegistryClient = {
      async fullMetadata() {
        throw new Error('not used')
      },
      async tarball() {
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
      readmeFailed() {},
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
      peerDependencies: { '@asabot/core': '^0.2.0' },
    }
    const registry: RegistryClient = {
      async fullMetadata() {
        return {
          name: manifest.name,
          'dist-tags': { latest: manifest.version },
          versions: { '1.0.0': manifest },
        }
      },
      async tarball() {
        throw new Error('not used')
      },
      async metadata() {
        throw new Error('not used')
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
        readmeFailed() {},
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

/** A gzipped ustar archive with the given regular files (checksums are not verified by the reader). */
function tarball(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder()
  const blocks: Uint8Array[] = []
  for (const [path, content] of Object.entries(files)) {
    const data = encoder.encode(content)
    const header = new Uint8Array(512)
    header.set(encoder.encode(path), 0)
    header.set(encoder.encode(`${data.length.toString(8).padStart(11, '0')}\0`), 124)
    header[156] = '0'.charCodeAt(0)
    const body = new Uint8Array(Math.ceil(data.length / 512) * 512)
    body.set(data)
    blocks.push(header, body)
  }
  blocks.push(new Uint8Array(1024))
  const tar = new Uint8Array(blocks.reduce((size, block) => size + block.length, 0))
  let offset = 0
  for (const block of blocks) {
    tar.set(block, offset)
    offset += block.length
  }
  return gzipSync(tar)
}

describe('package README', () => {
  it('reads only the top-level README from a tarball', () => {
    const readme = `# 示例\n${'x'.repeat(700)}`
    expect(
      readmeFromTarball(
        tarball({
          'package/package.json': '{}',
          'package/docs/README.md': 'nested',
          'package/Readme.md': readme,
        }),
      ),
    ).toBe(readme)
    expect(readmeFromTarball(tarball({ 'package/docs/README.md': 'nested' }))).toBeUndefined()
  })

  it('falls back to the latest tarball when the packument has no README', async () => {
    const failures: unknown[] = []
    const registry: RegistryClient = {
      async metadata() {
        throw new Error('not used')
      },
      async fullMetadata(name) {
        return {
          name,
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': { dist: { tarball: `https://registry.invalid/${name}.tgz` } } },
        }
      },
      async tarball(url) {
        if (url.includes('broken')) throw new Error('HTTP 500')
        return tarball({ 'package/README.md': '# From tarball' })
      },
      async search() {
        return { total: 0, items: [] }
      },
    }
    const service = new PackageService(
      { dir: '.', registry: 'http://127.0.0.1:1', npm: 'npm', installTimeout: 1000 },
      {
        installedPackages: () => new Map(),
        latestChanged() {},
        latestFailed() {},
        readmeFailed: (_name, error) => failures.push(error),
        subscriberFailed() {},
        async installPackage() {
          throw new Error('not used')
        },
        async uninstallPackage() {},
      },
      { registry },
    )
    expect((await service.marketInfo('asabot-plugin-ok')).readme).toBe('# From tarball')
    const broken = await service.marketInfo('asabot-plugin-broken')
    expect(broken.readme).toBeUndefined()
    expect(failures).toHaveLength(1)
  })
})
