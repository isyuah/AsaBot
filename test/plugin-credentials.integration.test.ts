import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import releaseNotifier from '../plugins/_examples/release-notifier.ts'
import {
  type App,
  configSchema,
  createApp,
  definePlugin,
  type PluginCredentialInfo,
  type PluginCredentials,
  plainText,
} from '../src/index.ts'
import { createTestApp } from '../src/testing/index.ts'

const token = () => randomBytes(32).toString('base64url')
const password = token()
const server = { port: 0, panelPassword: password }

async function connect(app: App) {
  const port = app.server?.address()?.port
  if (port === undefined) throw new Error('Missing server')
  const origin = `http://127.0.0.1:${port}`
  const login = await fetch(`${origin}/api/panel/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('Missing cookie')
  return {
    origin,
    request: (path: string, method = 'GET', input: unknown = {}, headers?: HeadersInit) =>
      fetch(`${origin}/api/panel${path}`, {
        method,
        headers: { cookie, 'Content-Type': 'application/json', ...headers },
        body: method === 'GET' ? undefined : JSON.stringify(input),
      }),
  }
}

async function createCredential(
  panel: Awaited<ReturnType<typeof connect>>,
  plugin: string,
  group: string,
  value?: string,
) {
  const response = await panel.request(`/plugins/${plugin}/credentials`, 'POST', {
    group,
    label: `${group} key`,
    ...(value === undefined ? { mode: 'generate' } : { mode: 'import', value }),
  })
  expect(response.status).toBe(201)
  const item: PluginCredentialInfo = await response.json()
  expect(item).not.toHaveProperty('value')
  return item
}

describe('plugin credentials', () => {
  it('isolates credentials by plugin and purpose, persists them across restarts and rejects a missing or replaced key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'asabot-credential-vault-'))
    const groups = { hook: { title: 'Webhook' }, review: { title: 'Review' } }
    const contexts = new Map<string, PluginCredentials>()
    const makeApp = () => {
      const app = createApp(configSchema.parse({ dataDir, server, pluginLoader: { dirs: [] } }), {
        logger: pino({ level: 'silent' }),
      })
      for (const name of ['owner', 'other']) {
        app.plugins.register(
          definePlugin({
            name,
            credentials: groups,
            setup: (ctx) => {
              contexts.set(name, ctx.credentials)
            },
          }),
        )
      }
      return app
    }
    let app = makeApp()
    try {
      await app.start()
      const panel = await connect(app)
      const secret = token()
      const item = await createCredential(panel, 'owner', 'hook', secret)
      const route = '/plugins/owner/credentials'
      const reveal = `${route}/${item.id}/reveal`
      const views = await (await panel.request('/plugins')).json()
      const view = views.find((plugin: { name: string }) => plugin.name === 'owner')
      expect(view).toMatchObject({ hasCredentials: true })
      expect(view).not.toHaveProperty('credentialGroups')
      expect((await fetch(`${panel.origin}/api/panel${reveal}`, { method: 'POST' })).status).toBe(401)
      expect((await panel.request(reveal, 'POST', {}, { origin: 'https://other.example' })).status).toBe(403)
      const list = await panel.request(route)
      expect(list.headers.get('cache-control')).toBe('no-store')
      expect(await list.json()).toMatchObject({ items: [item] })
      expect((await panel.request(`/plugins/other/credentials/${item.id}/reveal`, 'POST')).status).toBe(404)
      expect((await panel.request(`/plugins/other/credentials/${item.id}`, 'DELETE')).status).toBe(404)
      expect(contexts.get('other')?.list()).toEqual([])
      expect(contexts.get('other')?.match(secret, { group: 'hook' })).toBeUndefined()
      expect(contexts.get('owner')?.match(secret, { group: 'review' })).toBeUndefined()
      const bearer = (value: string) => new Request(panel.origin, { headers: { authorization: value } })
      expect(contexts.get('owner')?.bearer(bearer(`bearer ${secret}`), { group: 'hook' })).toEqual(item)
      expect(
        contexts.get('owner')?.bearer(bearer(`Bearer ${secret}, Bearer ${secret}`), { group: 'hook' }),
      ).toBeUndefined()

      const duplicate = await panel.request(route, 'POST', {
        group: 'hook',
        mode: 'import',
        label: 'Duplicate',
        value: secret,
      })
      expect(duplicate.status).toBe(409)
      expect(await duplicate.text()).not.toContain(secret)
      const row = app.storage.db
        .prepare('SELECT ciphertext FROM plugin_credentials WHERE id = ?')
        .get(item.id)
      expect(row?.ciphertext).toBeInstanceOf(Uint8Array)
      expect(Buffer.from(row?.ciphertext as Uint8Array).includes(Buffer.from(secret))).toBe(false)
      const oldContext = contexts.get('owner')
      await app.stop()
      expect(() => oldContext?.list()).toThrow('disposed')

      app = makeApp()
      await app.start()
      const restarted = await connect(app)
      const recovered = await restarted.request(reveal, 'POST')
      expect(recovered.headers.get('cache-control')).toBe('no-store')
      expect(await recovered.json()).toEqual({ value: secret })
      expect(contexts.get('owner')?.readAll({ group: 'hook' })).toEqual([{ ...item, value: secret }])

      const keyFile = join(dataDir, 'plugin-credentials.key')
      const key = await readFile(keyFile)
      const add = () =>
        restarted.request('/plugins/other/credentials', 'POST', {
          group: 'hook',
          mode: 'generate',
          label: 'New key',
        })
      await rm(keyFile)
      expect((await restarted.request(reveal, 'POST')).status).toBe(503)
      expect((await add()).status).toBe(503)
      await expect(stat(keyFile)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(keyFile, randomBytes(32))
      expect((await add()).status).toBe(503)
      await writeFile(keyFile, key)
      expect((await restarted.request(`${route}/${item.id}`, 'DELETE')).status).toBe(204)
      expect((await restarted.request(reveal, 'POST')).status).toBe(404)
      expect(contexts.get('owner')?.match(secret, { group: 'hook' })).toBeUndefined()
    } finally {
      await app.stop()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps credentials through disable and uninstall, retires removed purposes, and clears them on purge', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asabot-credential-lifecycle-'))
    const pluginDir = join(directory, 'plugins')
    await mkdir(pluginDir)
    const filename = join(pluginDir, 'hook.ts')
    const writePlugin = (declaresPurpose: boolean) =>
      writeFile(
        filename,
        `export default {
      name: 'hook',
      ${declaresPurpose ? "credentials: { deploy: { title: 'Deployment' } }," : ''}
      setup() { throw new Error('Setup failed') },
    }`,
      )
    await writePlugin(true)
    const t = await createTestApp({ pluginDirs: [pluginDir], config: { server } })
    try {
      const panel = await connect(t.app)
      const route = '/plugins/hook/credentials'
      const list = () => panel.request(route).then((response) => response.json())
      expect(t.app.plugins.get('hook')?.state).toBe('failed')
      expect(await list()).toMatchObject({ groups: [{ id: 'deploy', title: 'Deployment' }], items: [] })
      const secret = token()
      const item = await createCredential(panel, 'hook', 'deploy', secret)
      await t.app.plugins.disable('hook')
      expect(await list()).toMatchObject({ items: [item] })
      await t.app.plugins.uninstall('hook')
      expect((await panel.request(route)).status).toBe(404)
      await writePlugin(true)
      await t.app.plugins.rescan()
      expect(await list()).toMatchObject({ items: [item] })

      await writePlugin(false)
      await t.app.plugins.reload('hook')
      expect(await list()).toMatchObject({ groups: [], items: [{ ...item, active: false }] })
      expect(await (await panel.request(`${route}/${item.id}/reveal`, 'POST')).json()).toEqual({
        value: secret,
      })
      expect(
        (await panel.request(route, 'POST', { group: 'deploy', mode: 'generate', label: 'New key' })).status,
      ).toBe(400)
      await writePlugin(true)
      await t.app.plugins.reload('hook')
      expect(await list()).toMatchObject({ groups: [{ id: 'deploy' }], items: [{ ...item, active: false }] })
      await t.app.plugins.uninstall('hook', true)
      await writePlugin(true)
      await t.app.plugins.rescan()
      expect(await list()).toMatchObject({ items: [] })
    } finally {
      await t.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sends webhook notifications only when the route validates its own authorization scheme', async () => {
    const t = await createTestApp({
      plugins: [releaseNotifier],
      config: { server, plugins: { 'release-notifier': { config: { target: 'virtual:group:10' } } } },
    })
    try {
      const panel = await connect(t.app)
      const deploy = await createCredential(panel, 'release-notifier', 'deploy')
      const deployRoute = `/plugins/release-notifier/credentials/${deploy.id}`
      const { value }: { value: string } = await (await panel.request(`${deployRoute}/reveal`, 'POST')).json()
      const signingSecret = token()
      await createCredential(panel, 'release-notifier', 'github', signingSecret)
      const webhook = (path: string, headers: Record<string, string>, body: string) =>
        fetch(`${panel.origin}/plugins/release-notifier/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body,
        })
      const deployBody = JSON.stringify({ service: 'AsaBot', version: '2.0' })
      const releaseBody =
        '{\n  "action": "published", "repository": {"full_name":"team/通知"}, "release":{"tag_name":"v2"}\n}\n'
      const signature = `sha256=${createHmac('sha256', signingSecret).update(releaseBody).digest('hex')}`
      const githubHeaders = { 'X-GitHub-Event': 'release', 'X-Hub-Signature-256': signature }
      expect((await webhook('deploy', { 'X-Deploy-Key': signingSecret }, deployBody)).status).toBe(401)
      expect((await webhook('github', githubHeaders, releaseBody.trim())).status).toBe(401)
      expect(t.mock.bot.sends).toHaveLength(0)
      expect((await webhook('deploy', { 'X-Deploy-Key': value }, deployBody)).status).toBe(204)
      expect((await webhook('github', githubHeaders, releaseBody)).status).toBe(204)
      expect(t.mock.bot.sends.map(({ message }) => plainText(message))).toEqual([
        '部署完成：AsaBot 2.0',
        '发布了新版本：team/通知 v2',
      ])
      expect((await panel.request(deployRoute, 'DELETE')).status).toBe(204)
      expect((await webhook('deploy', { 'X-Deploy-Key': value }, deployBody)).status).toBe(401)
      await t.app.plugins.disable('release-notifier')
      expect((await webhook('github', githubHeaders, releaseBody)).status).toBe(404)
      expect(t.mock.bot.sends).toHaveLength(2)
    } finally {
      await t.dispose()
    }
  })
})
