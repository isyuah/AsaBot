import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { strToU8, zipSync } from 'fflate'
import pino from 'pino'
import WebSocket from 'ws'
import { VirtualAdapter } from '../../src/adapters/virtual/index.ts'
import { createApp } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/core/config/load.ts'
import { plainText } from '../../src/core/message/index.ts'
import { type NpmExecutor, npmEnvironment, resolveWindowsNpm } from '../../src/core/plugin/packages.ts'

const temp = await mkdtemp(join(tmpdir(), 'asabot-m8-'))
const packDir = join(temp, 'packs')
await mkdir(packDir)
// This sandbox denies creating child-process pipes on Windows. Inherit the console for the real npm run.
class InheritNpm implements NpmExecutor {
  private readonly dir: string
  private readonly registry: string
  private gate?: { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
  constructor(dir: string, registry: string) {
    this.dir = dir
    this.registry = registry
  }
  pauseNext() {
    const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
    this.gate = gate
    return gate
  }
  async run(args: string[]): Promise<void> {
    const gate = this.gate
    this.gate = undefined
    if (gate) {
      gate.entered.resolve()
      await gate.release.promise
    }
    const windows = process.platform === 'win32'
    const parts = [windows ? await resolveWindowsNpm('npm') : 'npm', ...args]
    const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
    const parameters = windows ? ['/d', '/s', '/c', `"${parts.map((part) => `"${part}"`).join(' ')}"`] : args
    const env = npmEnvironment(this.dir, this.registry)
    env.npm_config_loglevel = 'error'
    await new Promise<void>((resolveRun, reject) => {
      const child = spawn(command, parameters, {
        cwd: this.dir,
        stdio: 'inherit',
        windowsHide: true,
        windowsVerbatimArguments: windows,
        env,
      })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolveRun() : reject(new Error(`npm exited ${code}`))))
    })
  }
}
const npm = new InheritNpm(packDir, 'http://127.0.0.1:1')
type Manifest = {
  name: string
  version: string
  keywords: string[]
  peerDependencies: { '@asabot/core': string }
  dist?: { tarball: string; shasum: string; integrity: string }
}
const versions = new Map<string, Map<string, { manifest: Manifest; bytes: Buffer }>>()
let registryUrl = ''
let latest = '1.0.0'

async function pack(
  source: string,
  changes?: { name: string; keywords?: string[]; peer?: string; pluginName?: string },
): Promise<void> {
  const working = join(temp, `source-${Math.random().toString(36).slice(2)}`)
  await cp(resolve(source), working, { recursive: true })
  const manifest = JSON.parse(await readFile(join(working, 'package.json'), 'utf8')) as Manifest
  if (changes) {
    manifest.name = changes.name
    if (changes.keywords) manifest.keywords = changes.keywords
    if (changes.peer) manifest.peerDependencies['@asabot/core'] = changes.peer
    if (changes.pluginName) {
      const code = await readFile(join(working, 'index.js'), 'utf8')
      await writeFile(
        join(working, 'index.js'),
        code.replace('m8-npm', changes.pluginName).replace('package-answer', `${changes.pluginName}-answer`),
      )
    }
    await writeFile(join(working, 'package.json'), JSON.stringify(manifest))
  }
  const before = new Set(await readdir(packDir))
  await npm.run(['pack', working, '--pack-destination', packDir, '--ignore-scripts', '--silent'])
  const tarball = (await readdir(packDir)).find((name) => name.endsWith('.tgz') && !before.has(name))
  assert.ok(tarball)
  const bytes = await readFile(join(packDir, tarball))
  const group = versions.get(manifest.name) ?? new Map()
  group.set(manifest.version, { manifest, bytes })
  versions.set(manifest.name, group)
}

const registry = createServer((req, res) => {
  const url = new URL(req.url ?? '/', registryUrl)
  res.setHeader('Cache-Control', 'no-store')
  if (url.pathname === '/-/v1/search') {
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        total: 1,
        objects: [
          {
            package: {
              name: 'asabot-m8-e2e',
              version: latest,
              links: { npm: 'https://example.test/package' },
            },
          },
        ],
      }),
    )
    return
  }
  const tarball = /^\/tar\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (tarball) {
    const item = versions.get(tarball[1] as string)?.get(tarball[2] as string)
    if (!item) {
      res.writeHead(404).end()
      return
    }
    res.setHeader('Content-Type', 'application/octet-stream')
    res.end(item.bytes)
    return
  }
  const name = decodeURIComponent(url.pathname.slice(1))
  const group = versions.get(name)
  if (!group) {
    res.writeHead(404).end()
    return
  }
  const list = Object.fromEntries(
    [...group].map(([version, item]) => [
      version,
      {
        ...item.manifest,
        dist: {
          tarball: `${registryUrl}/tar/${name}/${version}`,
          shasum: createHash('sha1').update(item.bytes).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(item.bytes).digest('base64')}`,
        },
      },
    ]),
  )
  res.setHeader('Content-Type', 'application/json')
  res.end(
    JSON.stringify({
      name,
      'dist-tags': { latest: name === 'asabot-m8-e2e' ? latest : '1.0.0' },
      versions: list,
    }),
  )
})

let app: ReturnType<typeof createApp> | undefined
try {
  await pack('test/fixtures/package-v1')
  await pack('test/fixtures/package-v2')
  await pack('test/fixtures/package-v1', {
    name: 'asabot-no-keyword',
    keywords: ['other'],
    pluginName: 'no-keyword',
  })
  await pack('test/fixtures/package-v1', {
    name: 'asabot-incompatible',
    peer: '^99.0.0',
    pluginName: 'incompatible',
  })
  await pack('test/fixtures/package-v1', { name: 'asabot-duplicate' })
  await new Promise<void>((resolveListen) => registry.listen(0, '127.0.0.1', resolveListen))
  const address = registry.address()
  assert.ok(address && typeof address === 'object')
  registryUrl = `http://127.0.0.1:${address.port}`
  const pluginDir = join(temp, 'plugins')
  const dataDir = join(temp, 'data')
  const configPath = join(temp, 'config.yaml')
  await mkdir(pluginDir)
  await writeFile(
    configPath,
    `dataDir: ${JSON.stringify(dataDir)}\npluginLoader:\n  dirs: [${JSON.stringify(pluginDir)}]\n  hotReload: false\npackages:\n  registry: ${JSON.stringify(registryUrl)}\n  installTimeout: 60s\nserver:\n  port: 0\n  panelPassword: panel-secret\nplugins:\n  data-test:\n    enabled: true\n    config:\n      keep: true\n`,
  )
  const installedNpm = new InheritNpm(join(dataDir, 'packages'), registryUrl)
  app = createApp(await loadConfig(configPath), {
    configPath,
    logger: pino({ level: 'silent' }),
    packages: { npm: installedNpm },
  })
  let mock = new VirtualAdapter(app)
  app.useAdapter(mock)
  await app.start()
  let base = `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'panel-secret' }),
  })
  let cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert.ok(cookie)
  const request = (path: string, method = 'GET', value?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { Cookie: cookie, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(value ?? {}) }),
    })
  const say = async (text: string, superuser = false) =>
    (await mock.receive(text, { user: '20', group: '10', superuser })).map((sent) => plainText(sent.message))
  const waitOperation = async (id: string) => {
    for (let i = 0; i < 600; i++) {
      const operations = (await (await request('/packages/operations')).json()) as {
        id: string
        status: string
        error?: string
        plugin?: unknown
      }[]
      const item = operations.find((op) => op.id === id)
      if (item?.status === 'succeeded' || item?.status === 'failed') return item
      await delay(100)
    }
    throw new Error(`Operation ${id} timed out`)
  }
  const begin = async (path: string, payload: unknown) => {
    const response = await request(path, 'POST', payload)
    assert.equal(response.status, 202, await response.clone().text())
    return (await response.json()) as { id: string }
  }

  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, { headers: { Cookie: cookie } })
  const frames: { type: string; operation?: { status: string } }[] = []
  socket.on('message', (data) =>
    frames.push(JSON.parse(data.toString()) as { type: string; operation?: { status: string } }),
  )
  await new Promise<void>((resolveOpen, reject) => {
    socket.once('open', resolveOpen)
    socket.once('error', reject)
  })
  assert.deepEqual(await say('/plugin scan'), ['权限不足'])
  const beforeChat = mock.bot.sends.length
  assert.ok((await say('/plugin install asabot-no-keyword', true))[0]?.includes('开始安装'))
  for (let i = 0; i < 100 && mock.bot.sends.length < beforeChat + 2; i++) await delay(10)
  assert.ok(plainText(mock.bot.sends[beforeChat + 1]?.message ?? []).includes('安装 asabot-no-keyword 失败'))
  const beforeUpdateChat = mock.bot.sends.length
  assert.ok((await say('/plugin update asabot-no-keyword', true))[0]?.includes('开始升级'))
  for (let i = 0; i < 100 && mock.bot.sends.length < beforeUpdateChat + 2; i++) await delay(10)
  assert.ok(
    plainText(mock.bot.sends[beforeUpdateChat + 1]?.message ?? []).includes('升级 asabot-no-keyword 失败'),
  )
  assert.equal((await request('/packages/install', 'POST', { name: 'asabot-no-keyword' })).status, 400)
  assert.equal((await request('/packages/install', 'POST', { name: 'asabot-missing' })).status, 404)
  assert.equal((await request('/packages/install', 'POST', { name: 'asabot-incompatible' })).status, 409)
  const gate = installedNpm.pauseNext()
  const forced = await begin('/packages/install', { name: 'asabot-incompatible', force: true })
  await gate.entered.promise
  const queuedInstall = await begin('/packages/install', { name: 'asabot-m8-e2e', version: '^1.0.0' })
  const queuedOperations = (await (await request('/packages/operations')).json()) as {
    id: string
    status: string
  }[]
  assert.equal(queuedOperations.find((operation) => operation.id === queuedInstall.id)?.status, 'queued')
  const queuedUpload = request('/plugins/upload', 'POST', {
    filename: 'queued.js',
    content: Buffer.from(
      `import { definePlugin, z } from '@asabot/core'; export default definePlugin({ name: 'queued', config: z.object({ label: z.string().default('initial') }), setup() {} })`,
    ).toString('base64'),
  })
  try {
    const response = await Promise.race([
      queuedUpload,
      delay(5000).then(() => {
        throw new Error('Plugin management blocked by npm')
      }),
    ])
    assert.equal(response.status, 201)
    assert.equal((await request('/plugins/queued/disable', 'POST')).status, 200)
    assert.equal((await request('/plugins/queued/enable', 'POST')).status, 200)
    assert.equal((await request('/plugins/queued/reload', 'POST')).status, 200)
    assert.equal(
      (await request('/plugins/queued/config', 'PUT', { config: { label: 'changed' } })).status,
      200,
    )
  } finally {
    gate.release.resolve()
  }
  assert.equal((await waitOperation(forced.id)).status, 'succeeded')
  assert.equal((await waitOperation(queuedInstall.id)).status, 'succeeded')
  assert.deepEqual(await say('/incompatible-answer'), ['package-v1-relative-v1'])
  const removeGate = installedNpm.pauseNext()
  const forcedRemove = await begin('/packages/uninstall', { name: 'asabot-incompatible', purge: false })
  await removeGate.entered.promise
  try {
    assert.equal(app.plugins.get('incompatible')?.state, 'disabled')
    assert.equal(
      (
        await request('/plugins/upload', 'POST', {
          filename: 'conflict.js',
          content: Buffer.from(`export default { name: 'incompatible', setup() {} }`).toString('base64'),
        })
      ).status,
      409,
    )
    assert.equal((await request('/plugins/queued/disable', 'POST')).status, 200)
    assert.equal((await request('/plugins/queued/enable', 'POST')).status, 200)
  } finally {
    removeGate.release.resolve()
  }
  assert.equal((await waitOperation(forcedRemove.id)).status, 'succeeded')
  assert.deepEqual(await say('/package-answer'), ['package-v1-relative-v1'])
  const search = (await (await request('/packages/search?q=e2e&from=0')).json()) as {
    items: { installed: boolean; installedVersion: string }[]
  }
  assert.equal(search.items[0]?.installed, true)
  assert.equal(search.items[0]?.installedVersion, '1.0.0')
  const duplicate = await begin('/packages/install', { name: 'asabot-duplicate' })
  assert.equal((await waitOperation(duplicate.id)).status, 'failed')
  assert.ok(!(await readFile(join(dataDir, 'packages', 'package.json'), 'utf8')).includes('asabot-duplicate'))
  latest = '2.0.0'
  const update = await begin('/packages/update', { name: 'asabot-m8-e2e' })
  const updated = await waitOperation(update.id)
  assert.equal(updated.status, 'succeeded', updated.error ?? '')
  assert.deepEqual(await say('/package-answer'), ['package-v2-relative-v2'])
  const pluginList = (await (await request('/plugins')).json()) as {
    name: string
    removable: boolean
    package?: { name: string; version: string; latest?: string; compatible: boolean }
  }[]
  assert.deepEqual(pluginList.find((plugin) => plugin.name === 'm8-npm')?.package, {
    name: 'asabot-m8-e2e',
    version: '2.0.0',
    latest: '2.0.0',
    peerRange: '^0.1.0',
    compatible: true,
  })
  assert.equal(pluginList.find((plugin) => plugin.name === 'm8-npm')?.removable, true)
  assert.ok(frames.some((frame) => frame.type === 'package' && frame.operation?.status === 'succeeded'))
  socket.terminate()
  await app.stop()
  app = createApp(await loadConfig(configPath), {
    configPath,
    logger: pino({ level: 'silent' }),
    packages: { npm: new InheritNpm(join(dataDir, 'packages'), registryUrl) },
  })
  mock = new VirtualAdapter(app)
  app.useAdapter(mock)
  await app.start()
  base = `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
  const secondLogin = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'panel-secret' }),
  })
  cookie = secondLogin.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert.ok(cookie)
  assert.deepEqual(await say('/package-answer'), ['package-v2-relative-v2'])
  const uninstall = await begin('/packages/uninstall', { name: 'asabot-m8-e2e', purge: false })
  assert.equal((await waitOperation(uninstall.id)).status, 'succeeded')
  assert.deepEqual(await say('/package-answer'), [])

  const code = (answer: string) =>
    `import { definePlugin } from '@asabot/core'; export default definePlugin({ name: 'data-test', setup(ctx) { ctx.store.set('key', 'value'); ctx.migrate(['CREATE TABLE p_data-test_wrong (x)']); ctx.task('later', () => {}).schedule({value: 1}, {delay: '1d', key: 'persisted'}); ctx.command('data-test').action(() => '${answer}') } })`
  const goodCode = (answer: string) => code(answer).replace('p_data-test_wrong', '"p_data-test_rows"')
  const upload = (filename: string, bytes: Uint8Array, overwrite = false) =>
    request('/plugins/upload', 'POST', {
      filename,
      content: Buffer.from(bytes).toString('base64'),
      overwrite,
    })
  assert.equal((await upload('data-test.js', Buffer.from(goodCode('one')))).status, 201)
  assert.deepEqual(await say('/data-test'), ['one'])
  assert.equal((await upload('data-test.js', Buffer.from(goodCode('two')))).status, 409)
  assert.equal((await upload('data-test.js', Buffer.from(goodCode('two')), true)).status, 201)
  assert.deepEqual(await say('/data-test'), ['two'])
  const zip = zipSync({
    'folder/index.js': strToU8(
      `export default { name: 'zip-test', setup(ctx) { ctx.command('zip-test').action(() => 'zip') } }`,
    ),
  })
  assert.equal((await upload('zip-test.zip', zip)).status, 201)
  assert.deepEqual(await say('/zip-test'), ['zip'])
  const zipOverwrite = zipSync({
    'index.ts': strToU8(
      `export default { name: 'zip-test', setup(ctx) { ctx.command('zip-test').action(() => 'changed') } }`,
    ),
  })
  assert.equal((await upload('zip-test.zip', zipOverwrite, true)).status, 201)
  assert.deepEqual(await say('/zip-test'), ['changed'])
  assert.equal(
    (await upload('escape.zip', zipSync({ '../escape.js': strToU8('bad'), 'index.js': strToU8('bad') })))
      .status,
    400,
  )
  assert.equal(
    (
      await upload(
        'symlink.zip',
        zipSync({ 'index.js': strToU8('bad'), link: [strToU8('target'), { os: 3, attrs: 0xa1ff0000 }] }),
      )
    ).status,
    400,
  )
  assert.equal(
    (await upload('duplicate.js', Buffer.from(`export default { name: 'admin', setup() {} }`))).status,
    409,
  )
  assert.equal(
    (await upload('bomb.zip', zipSync({ 'index.js': strToU8('bad'), big: new Uint8Array(5 * 1024 * 1024) })))
      .status,
    400,
  )
  assert.equal((await upload('large.js', Buffer.alloc(2 * 1024 * 1024))).status, 400)
  const broken = await upload('broken.js', Buffer.from('export default !!!'))
  assert.equal(broken.status, 201)
  assert.equal(((await broken.json()) as { state: string }).state, 'failed')
  assert.equal(await readFile(join(pluginDir, 'broken.js'), 'utf8'), 'export default !!!')
  const repaired = await upload(
    'broken.js',
    Buffer.from(`export default { name: 'broken', setup() {} }`),
    true,
  )
  assert.equal(((await repaired.json()) as { state: string }).state, 'active')
  assert.equal((await request('/plugins/admin/uninstall', 'POST', { purge: false })).status, 409)
  app.plugins.setGroupEnabled('data-test', 'virtual:10', false)
  await mkdir(join(dataDir, 'plugins', 'data-test'), { recursive: true })
  await writeFile(join(dataDir, 'plugins', 'data-test', 'data'), 'stored')
  assert.equal((await request('/plugins/data-test/uninstall', 'POST', { purge: false })).status, 200)
  assert.equal(app.storage.store('data-test').get('key'), 'value')
  assert.ok(app.storage.db.prepare("SELECT key FROM scheduled_tasks WHERE plugin = 'data-test'").get())
  assert.ok((await readFile(configPath, 'utf8')).includes('data-test:'))
  assert.equal(await readFile(join(dataDir, 'plugins', 'data-test', 'data'), 'utf8'), 'stored')
  assert.equal((await upload('data-test.js', Buffer.from(goodCode('three')))).status, 201)
  assert.equal((await request('/plugins/data-test/uninstall', 'POST', { purge: true })).status, 200)
  assert.equal(app.storage.store('data-test').get('key'), undefined)
  assert.equal(
    app.storage.db.prepare("SELECT key FROM scheduled_tasks WHERE plugin = 'data-test'").get(),
    undefined,
  )
  assert.equal(app.storage.listGroups('data-test').length, 0)
  assert.equal(
    app.storage.db.prepare("SELECT name FROM sqlite_master WHERE name = 'p_data-test_rows'").get(),
    undefined,
  )
  assert.equal(
    app.storage.db.prepare("SELECT plugin FROM migrations WHERE plugin = 'data-test'").get(),
    undefined,
  )
  assert.ok(!(await readFile(configPath, 'utf8')).includes('data-test:'))
  await assert.rejects(readFile(join(dataDir, 'plugins', 'data-test', 'data')))
  await writeFile(
    join(pluginDir, 'scan.js'),
    `export default { name: 'scan', setup(ctx) { ctx.command('scan-test').action(() => 'found') } }`,
  )
  const added = (await (await request('/plugins/rescan', 'POST')).json()) as {
    added: string[]
    removed: string[]
  }
  assert.ok(added.added.includes('scan'))
  assert.deepEqual(await say('/scan-test'), ['found'])
  await writeFile(
    join(pluginDir, 'scan.js'),
    `export default { name: 'scan', setup(ctx) { ctx.command('scan-test').action(() => 'changed') } }`,
  )
  const unchanged = (await (await request('/plugins/rescan', 'POST')).json()) as {
    added: string[]
    removed: string[]
  }
  assert.deepEqual(unchanged.added, [])
  assert.deepEqual(await say('/scan-test'), ['found'])
  await rm(join(pluginDir, 'scan.js'))
  const removed = (await (await request('/plugins/rescan', 'POST')).json()) as {
    added: string[]
    removed: string[]
  }
  assert.ok(removed.removed.includes('scan'))
  assert.deepEqual(await say('/scan-test'), [])
  process.stdout.write('PLUGIN_MANAGEMENT_OK\n')
} finally {
  await app?.stop()
  if (registry.listening)
    await new Promise<void>((resolveClose, reject) =>
      registry.close((error) => (error ? reject(error) : resolveClose())),
    )
  await rm(temp, { recursive: true, force: true })
}
