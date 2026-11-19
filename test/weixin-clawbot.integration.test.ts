import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { encode } from 'silk-wasm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { isWeixinClawBot } from '../src/adapters/weixin-clawbot/index.ts'
import { createLogger } from '../src/core/logger.ts'
import { createApp, definePlugin, isSegment, loadConfig, type Session, seg } from '../src/index.ts'

const platform = 'weixin-clawbot'
const apiHost = 'ilinkai.weixin.qq.com'
const cdnHost = 'novac2c.cdn.weixin.qq.com'
const panelFetch = globalThis.fetch
const setups = '/connection-setups'

type Fields = Record<string, unknown>

class MockIlink {
  readonly password = randomUUID()
  readonly sent: { token: string; msg: Fields }[] = []
  readonly updateRequests: { token: string; cursor: unknown }[] = []
  readonly qrRequests: { id: string; host: string; code: string | null; signal: AbortSignal }[] = []
  readonly pendingQr: Fields[][] = []
  readonly nextUpdates = new Map<string, (Fields | Response)[]>()
  readonly assets = new Map<string, Buffer>()
  readonly mediaRequests: string[] = []
  readonly uploads = new Map<string, { key: string; type: number; raw: Buffer }>()
  readonly typing: Fields[] = []
  readonly typingTicket = randomUUID()
  private readonly qr = new Map<string, Fields[]>()
  private readonly uploadKeys = new Map<string, Fields>()

  mockFetch(): void {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      return url.hostname.endsWith('.weixin.qq.com') ? this.request(url, init) : panelFetch(input, init)
    })
  }

  authorization(selfId: string, token: string, userId?: string): Fields {
    return {
      status: 'confirmed',
      ilink_bot_id: selfId,
      bot_token: token,
      ilink_user_id: userId,
      baseurl: `https://${apiHost}`,
    }
  }

  update(token: string, updates: Fields | Response): void {
    const queue = this.nextUpdates.get(token) ?? []
    queue.push(updates)
    this.nextUpdates.set(token, queue)
  }

  message(
    token: string,
    userId: string,
    context: string,
    text: string,
    cursor: string,
    id = randomUUID(),
  ): void {
    this.update(token, {
      ret: 0,
      get_updates_buf: cursor,
      msgs: [
        {
          message_type: 1,
          from_user_id: userId,
          context_token: context,
          message_id: id,
          item_list: [{ type: 1, text_item: { text } }],
        },
      ],
    })
  }

  private async request(url: URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers)
    const token = headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
    const action = url.pathname.split('/').at(-1)
    const data: Fields = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (url.hostname === cdnHost) {
      expect(token).toBe('')
      const param = url.searchParams.get('encrypted_query_param') ?? ''
      this.mediaRequests.push(param)
      if (action === 'upload') {
        const metadata = this.uploadKeys.get(param)
        if (!metadata || !Buffer.isBuffer(init?.body)) throw new Error('Missing encrypted upload')
        const key = String(metadata.aeskey)
        const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key, 'hex'), null)
        const raw = Buffer.concat([decipher.update(init.body), decipher.final()])
        expect(metadata.rawfilemd5).toBe(createHash('md5').update(raw).digest('hex'))
        expect(metadata.rawsize).toBe(raw.length)
        expect(metadata.filesize).toBe(init.body.length)
        const signature = randomUUID()
        this.uploads.set(signature, { key, raw, type: Number(metadata.media_type) })
        this.assets.set(signature, init.body)
        return new Response(null, { headers: { 'x-encrypted-param': signature } })
      }
      const asset = this.assets.get(param)
      return asset ? new Response(Uint8Array.from(asset)) : new Response(null, { status: 404 })
    }
    switch (action) {
      case 'get_bot_qrcode': {
        expect(url.searchParams.get('bot_type')).toBe('3')
        expect(init?.method).toBe('POST')
        expect(data.local_token_list).toEqual([])
        expect(token).toBe('')
        const id = randomUUID()
        this.qr.set(id, this.pendingQr.shift() ?? [])
        return Response.json({ qrcode: id, qrcode_img_content: `https://weixin.qq.com/mock/${id}` })
      }
      case 'get_qrcode_status': {
        const id = url.searchParams.get('qrcode') ?? ''
        const signal = init?.signal
        if (!signal) throw new Error('Missing QR abort signal')
        this.qrRequests.push({ id, host: url.hostname, code: url.searchParams.get('verify_code'), signal })
        return this.qr.get(id)?.length
          ? Response.json(this.qr.get(id)?.shift())
          : sleep(60_000, Response.json({ status: 'wait' }), { signal })
      }
      case 'getupdates': {
        this.updateRequests.push({ token, cursor: data.get_updates_buf })
        const signal = init?.signal
        let next = this.nextUpdates.get(token)?.shift()
        while (!next) {
          await sleep(25, undefined, { signal: signal ?? undefined })
          next = this.nextUpdates.get(token)?.shift()
        }
        return next instanceof Response ? next : Response.json(next)
      }
      case 'sendmessage':
        this.sent.push({ token, msg: data.msg as Fields })
        return new Response(`{"ret":0,"message_id":${9223372036854775807n + BigInt(this.sent.length)}}`)
      case 'getuploadurl': {
        const param = randomUUID()
        this.uploadKeys.set(param, data)
        return data.media_type === 2
          ? Response.json({ upload_full_url: `https://${cdnHost}/c2c/upload?encrypted_query_param=${param}` })
          : Response.json({ upload_param: param })
      }
      case 'getconfig':
        this.typing.push({ method: action, ...data })
        return Response.json({ ret: 0, typing_ticket: this.typingTicket })
      case 'sendtyping':
        this.typing.push({ method: action, ...data })
        return Response.json({ ret: 0 })
      case 'notifystart':
      case 'notifystop':
        return Response.json({ ret: 0 })
      default:
        throw new Error('Unexpected iLink request')
    }
  }
}

async function login(base: string, password: string) {
  const response = await panelFetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('Missing panel cookie')
  return (path: string, method = 'GET', body?: unknown, headers?: Fields) =>
    panelFetch(`${base}${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
}

type Panel = Awaited<ReturnType<typeof login>>

async function start(panel: Panel, connectionId?: string): Promise<string> {
  const response = await panel(setups, 'POST', { adapter: platform, connectionId })
  expect(response.status).toBe(201)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return (await response.json()).id
}

async function status(panel: Panel, id: string, expected: string) {
  return vi.waitFor(
    async () => {
      const response = await panel(`${setups}/${id}`)
      const state = await response.json()
      expect(state.status).toBe(expected)
      return state
    },
    { timeout: 4000, interval: 25 },
  )
}

async function fixture(mock: MockIlink, connections: Fields[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'asabot-weixin-'))
  const path = join(dir, 'asabot.yaml')
  await writeFile(
    path,
    stringify({
      dataDir: dir,
      server: { port: 0, panelPassword: mock.password },
      pluginLoader: { dirs: [], hotReload: false },
      command: { privateRequirePrefix: true },
      connections,
    }),
  )
  const sessions: Session[] = []
  const log: string[] = []
  mock.mockFetch()
  const create = async () => {
    const app = createApp(await loadConfig(path), {
      configPath: path,
      logger: createLogger({ level: 'debug', destination: { write: (value) => log.push(value) } }),
    })
    app.plugins.register(
      definePlugin({
        name: 'weixin-fixture',
        setup(ctx) {
          ctx.on('message.private', (session) => {
            sessions.push(session)
          })
          ctx.match('ping', () => 'pong')
          ctx
            .command('manage')
            .permission('bot.admin')
            .action(() => 'managed')
        },
      }),
    )
    await app.start()
    return app
  }
  let app = await create()
  const base = () => `http://127.0.0.1:${app.server?.address()?.port}/api/panel`
  return {
    path,
    sessions,
    log,
    get app() {
      return app
    },
    panel: () => login(base(), mock.password),
    async restart() {
      await app.stop()
      app = await create()
    },
    async dispose() {
      await app.stop()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function sentTexts(mock: MockIlink) {
  return mock.sent.map(({ msg }) => ({ to: msg.to_user_id, items: msg.item_list }))
}

function encryptedAsset(mock: MockIlink, bytes: Buffer, rawKey = false) {
  const key = randomBytes(16)
  const param = randomUUID()
  const cipher = createCipheriv('aes-128-ecb', key, null)
  mock.assets.set(param, Buffer.concat([cipher.update(bytes), cipher.final()]))
  return {
    key,
    param,
    ref: {
      encrypt_query_param: param,
      aes_key: (rawKey ? key : Buffer.from(key.toString('hex'))).toString('base64'),
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('微信 ClawBot', () => {
  it('checks regional handoff and verification, then saves once and grants only bot.admin', async () => {
    const mock = new MockIlink()
    const token = randomUUID()
    const context = randomUUID()
    const selfId = 'first@im.bot'
    mock.pendingQr.push([
      { status: 'wait' },
      { status: 'scaned_but_redirect', redirect_host: 'ilinkai-sg.weixin.qq.com' },
      { status: 'need_verifycode' },
      { status: 'need_verifycode' },
      mock.authorization(selfId, token, 'scanner'),
    ])
    const t = await fixture(mock)
    try {
      const panel = await t.panel()
      const catalog = await (await panel('/adapters')).json()
      expect(catalog.find((item: Fields) => item.id === platform).setup).toEqual({ kind: 'qr' })
      const id = await start(panel)
      const waiting = await status(panel, id, 'waiting')
      expect(waiting.image).toMatch(/^data:image\/png;base64,/)
      await status(panel, id, 'verification')
      const other = await t.panel()
      expect((await other(`${setups}/${id}`)).status).toBe(404)
      expect((await other(`${setups}/${id}`, 'DELETE', {})).status).toBe(404)
      expect(
        (
          await panel(
            `${setups}/${id}/verify`,
            'POST',
            { code: '1111' },
            { origin: 'https://example.invalid' },
          )
        ).status,
      ).toBe(403)
      expect((await panel(`${setups}/${id}/save`, 'POST', {})).status).toBe(409)
      expect((await panel(`${setups}/${id}/verify`, 'POST', { code: '1111' })).status).toBe(200)
      expect((await status(panel, id, 'verification')).retry).toBe(true)
      expect((await panel(`${setups}/${id}/verify`, 'POST', { code: '2468' })).status).toBe(200)
      const authorized = await status(panel, id, 'authorized')
      expect(authorized).toMatchObject({ selfId, missingAdmin: false })
      expect(JSON.stringify(authorized)).not.toContain(token)
      expect(JSON.stringify(authorized)).not.toContain('weixin.qq.com')
      expect(mock.qrRequests.map(({ host, code }) => [host, code])).toEqual([
        [apiHost, null],
        [apiHost, null],
        ['ilinkai-sg.weixin.qq.com', null],
        ['ilinkai-sg.weixin.qq.com', '1111'],
        ['ilinkai-sg.weixin.qq.com', '2468'],
      ])
      expect(t.app.config.connections).toEqual([])
      expect(mock.updateRequests).toEqual([])
      expect(await readFile(t.path, 'utf8')).not.toContain(token)

      mock.update(
        token,
        new Response(
          `{"ret":0,"get_updates_buf":"first-cursor","msgs":[{"message_id":9223372036854775810,"from_user_id":"scanner","message_type":1,"context_token":"${context}","item_list":[{"type":1,"text_item":{"text":"/manage"}}]}]}`,
        ),
      )
      mock.message(token, 'ordinary', 'ordinary-context', '/manage', 'second-cursor')
      mock.message(token, 'ordinary', 'ordinary-context', 'ping', 'third-cursor')
      const saves = await Promise.all([
        panel(`${setups}/${id}/save`, 'POST', { name: 'Weixin' }),
        panel(`${setups}/${id}/save`, 'POST', { name: 'Weixin' }),
      ])
      expect(saves.map((response) => response.status)).toEqual([200, 200])
      const results = await Promise.all(saves.map((response) => response.json()))
      expect(results[0]).toEqual(results[1])
      expect(t.app.config.connections).toHaveLength(1)
      await vi.waitFor(() => expect(mock.sent).toHaveLength(3), { timeout: 3000 })
      expect(sentTexts(mock)).toEqual([
        { to: 'scanner', items: [{ type: 1, text_item: { text: 'managed' } }] },
        { to: 'ordinary', items: [{ type: 1, text_item: { text: '权限不足' } }] },
        { to: 'ordinary', items: [{ type: 1, text_item: { text: 'pong' } }] },
      ])
      expect(mock.sent[0]?.msg.context_token).toBe(context)
      expect(t.sessions[0]).toMatchObject({
        messageId: '9223372036854775810',
        isBotAdmin: true,
        isSuperuser: false,
      })
      expect(t.app.policies.admins({ platform, selfId })).toEqual(['scanner'])
      const bot = t.app.getBot(platform, selfId)
      if (!bot) throw new Error('Missing Weixin Bot')
      await expect(bot.sendPrivate('unknown', 'hello')).rejects.toThrow('请先让对方')
      expect(await bot.sendPrivate('scanner', '再次回复')).toEqual({ messageId: '9223372036854775811' })
      t.app.storage.access.add('block', 'user', `${platform}:ordinary`)
      mock.message(token, 'ordinary', 'ordinary-context', 'ping', 'blocked-cursor')
      await vi.waitFor(() => expect(mock.updateRequests.at(-1)?.cursor).toBe('blocked-cursor'))
      expect(mock.sent).toHaveLength(4)
      const visible = JSON.stringify([await (await panel('/connections')).json(), t.sessions, t.log])
      for (const secret of [token, context, 'first-cursor', 'ordinary-context', 'https://ilinkai'])
        expect(visible).not.toContain(secret)
    } finally {
      await t.dispose()
    }
  }, 12_000)

  it('stops upstream QR polling when expired, cancelled or logged out', async () => {
    const mock = new MockIlink()
    mock.pendingQr.push([{ status: 'expired' }], [{ status: 'binded_redirect' }], [], [])
    const t = await fixture(mock)
    try {
      const panel = await t.panel()
      const expired = await start(panel)
      await status(panel, expired, 'expired')
      expect((await panel(`${setups}/${expired}/save`, 'POST', {})).status).toBe(409)
      const bound = await start(panel)
      await status(panel, bound, 'already-bound')
      expect((await panel(`${setups}/${bound}/save`, 'POST', {})).status).toBe(409)
      const cancelled = await start(panel)
      await status(panel, cancelled, 'waiting')
      expect((await panel(`${setups}/${cancelled}`, 'DELETE', {})).status).toBe(204)
      expect(mock.qrRequests.at(-1)?.signal.aborted).toBe(true)
      expect((await panel(`${setups}/${cancelled}`)).status).toBe(404)
      const loggedOut = await start(panel)
      await status(panel, loggedOut, 'waiting')
      expect((await panel('/logout', 'POST', {})).status).toBe(200)
      expect(mock.qrRequests.at(-1)?.signal.aborted).toBe(true)
      expect((await panel(`${setups}/${loggedOut}`)).status).toBe(401)
      expect(t.app.config.connections).toEqual([])
    } finally {
      await t.dispose()
    }
  })

  it('isolates accounts, preserves revoked admins on renewal and confirms replacement', async () => {
    const mock = new MockIlink()
    const token = randomUUID()
    const otherToken = randomUUID()
    const renewed = randomUUID()
    const replacement = randomUUID()
    const first = { platform, selfId: 'first@im.bot' }
    const second = { platform, selfId: 'second@im.bot' }
    const third = { platform, selfId: 'third@im.bot' }
    const config = (id: string, selfId: string, token: string) => ({
      id,
      name: `Connection ${id}`,
      adapter: platform,
      enabled: true,
      config: { selfId, token },
    })
    mock.message(token, 'peer', 'first-context', 'one', 'first-cursor')
    mock.message(otherToken, 'peer', 'second-context', 'two', 'second-cursor')
    mock.pendingQr.push(
      [mock.authorization(second.selfId, otherToken, 'scanner')],
      [mock.authorization(first.selfId, renewed, 'revoked')],
      [mock.authorization(third.selfId, replacement)],
    )
    const t = await fixture(mock, [
      config('one', first.selfId, token),
      config('two', second.selfId, otherToken),
    ])
    try {
      const panel = await t.panel()
      await vi.waitFor(() => expect(t.sessions).toHaveLength(2))
      const duplicate = await start(panel, 'one')
      expect((await status(panel, duplicate, 'authorized')).replaces).toBe(first.selfId)
      expect((await panel(`${setups}/${duplicate}/save`, 'POST', { replace: true })).status).toBe(409)

      t.app.policies.setAdmins(first, ['revoked'])
      t.app.policies.setAdmins(first, ['retained'])
      t.app.policies.setPlugin(first, 'weixin-fixture', { enabled: false })
      const renewal = await start(panel, 'one')
      expect((await status(panel, renewal, 'authorized')).replaces).toBeUndefined()
      mock.update(renewed, { ret: 0 })
      expect((await panel(`${setups}/${renewal}/save`, 'POST', {})).status).toBe(200)
      expect(t.app.policies.admins(first)).toEqual(['retained'])
      expect(t.app.policies.plugin(first, 'weixin-fixture')).toEqual({ enabled: false })
      await vi.waitFor(() => expect(t.app.getBot(platform, first.selfId)?.status).toBe('online'))
      expect(mock.updateRequests.find((entry) => entry.token === renewed)?.cursor).toBe('first-cursor')
      await t.app.getBot(platform, first.selfId)?.sendPrivate('peer', 'still first')
      await t.app.getBot(platform, second.selfId)?.sendPrivate('peer', 'still second')
      expect(mock.sent.map(({ token, msg }) => [token, msg.context_token])).toEqual([
        [renewed, 'first-context'],
        [otherToken, 'second-context'],
      ])

      const change = await start(panel, 'one')
      expect(await status(panel, change, 'authorized')).toMatchObject({
        missingAdmin: true,
        replaces: first.selfId,
      })
      expect((await panel(`${setups}/${change}/save`, 'POST', {})).status).toBe(409)
      mock.update(replacement, { ret: 0 })
      expect(
        (await panel(`${setups}/${change}/save`, 'POST', { replace: true, name: 'ignored', enabled: false }))
          .status,
      ).toBe(200)
      await vi.waitFor(() => expect(t.app.getBot(platform, third.selfId)?.status).toBe('online'))
      expect(t.app.getBot(platform, first.selfId)).toBeUndefined()
      expect(t.app.connections.list().find(({ id }) => id === 'one')).toMatchObject({
        name: 'Connection one',
        enabled: true,
        bots: [third],
      })
      expect(t.app.policies.admins(third)).toEqual([])
      expect(t.app.policies.plugin(third, 'weixin-fixture')).toEqual({})
      expect(mock.updateRequests.find((entry) => entry.token === replacement)?.cursor).toBe('')
      await expect(
        t.app.getBot(platform, third.selfId)?.sendPrivate('peer', 'not inherited'),
      ).rejects.toThrow('请先让对方')
    } finally {
      await t.dispose()
    }
  }, 12_000)

  it('resumes the stored cursor after restart and pauses on expired credentials', async () => {
    const mock = new MockIlink()
    const token = randomUUID()
    const selfId = 'one@im.bot'
    mock.message(token, 'peer', 'resume-context', 'one', 'resume-cursor')
    const t = await fixture(mock, [{ id: 'one', name: 'One', adapter: platform, config: { selfId, token } }])
    try {
      await vi.waitFor(() => expect(t.sessions).toHaveLength(1))
      await t.restart()
      mock.update(token, new Response('upstream-secret', { status: 502 }))
      await vi.waitFor(() => expect(t.app.connections.list()[0]?.state).toBe('retrying'))
      expect(mock.updateRequests.at(-1)?.cursor).toBe('resume-cursor')
      mock.update(token, { ret: 0 })
      await vi.waitFor(() => expect(t.app.connections.list()[0]?.state).toBe('online'), { timeout: 2000 })
      await t.app.getBot(platform, selfId)?.sendPrivate('peer', 'resumed')
      expect(mock.sent.at(-1)?.msg.context_token).toBe('resume-context')
      mock.update(token, { ret: -1, errcode: -14, errmsg: 'upstream-secret' })
      await vi.waitFor(() => expect(t.app.connections.list()[0]?.state).toBe('reauthorize'))
      expect(t.app.getBot(platform, selfId)?.status).toBe('offline')
      const count = mock.updateRequests.length
      await sleep(300)
      expect(mock.updateRequests).toHaveLength(count)
      expect(JSON.stringify(t.log)).not.toContain('upstream-secret')

      const renewed = randomUUID()
      const panel = await t.panel()
      mock.pendingQr.push([mock.authorization(selfId, renewed, 'scanner')])
      const id = await start(panel, 'one')
      await status(panel, id, 'authorized')
      mock.update(renewed, { ret: 0 })
      expect((await panel(`${setups}/${id}/save`, 'POST', {})).status).toBe(200)
      await vi.waitFor(() => expect(t.app.connections.list()[0]?.state).toBe('online'))
      expect(mock.updateRequests.find((entry) => entry.token === renewed)?.cursor).toBe('resume-cursor')
    } finally {
      await t.dispose()
    }
  }, 12_000)

  it('decrypts attachments lazily, sends ordered parts, restores quotes and changes typing status', async () => {
    const mock = new MockIlink()
    const token = randomUUID()
    const context = randomUUID()
    const selfId = 'media@im.bot'
    const image = encryptedAsset(mock, Buffer.from('mock image'))
    const video = encryptedAsset(mock, Buffer.from('mock video'), true)
    const file = encryptedAsset(mock, Buffer.from('mock file'))
    const voiceBytes = Buffer.from((await encode(Buffer.alloc(24_000), 24_000)).data)
    const voice = encryptedAsset(mock, voiceBytes)
    const quotedId = '9223372036854775922'
    const msg = (peer: string, parts: Fields[], fields: Fields = {}) => ({
      from_user_id: peer,
      message_type: 1,
      context_token: context,
      item_list: parts,
      ...fields,
    })
    mock.update(token, {
      ret: 0,
      msgs: [
        msg('peer', [
          {
            type: 2,
            image_item: { aeskey: image.key.toString('hex'), media: { ...image.ref, aes_key: 'bad' } },
          },
          {
            type: 5,
            video_item: {
              media: {
                aes_key: video.ref.aes_key,
                full_url: `https://${cdnHost}/c2c/download?encrypted_query_param=${video.param}`,
              },
            },
          },
          { type: 4, file_item: { media: file.ref, file_name: 'nested/name.txt' } },
          { type: 3, voice_item: { media: voice.ref, text: '微信语音转写' } },
        ]),
        msg('peer', [{ type: 1, text_item: { text: '/should-not-run' } }], { message_id: quotedId }),
        msg('peer', [{ type: 1, text_item: { text: '引用新消息' }, ref_msg: { svr_id: quotedId } }]),
        msg('other', [{ type: 1, text_item: { text: '其他会话' }, ref_msg: { svr_id: quotedId } }]),
      ],
    })
    const t = await fixture(mock, [
      { id: 'media', name: 'Media', adapter: platform, config: { selfId, token } },
    ])
    try {
      await vi.waitFor(() => expect(t.sessions).toHaveLength(4))
      expect(mock.mediaRequests).toEqual([])
      const bot = t.app.getBot(platform, selfId)
      if (!bot || !isWeixinClawBot(bot)) throw new Error('Missing Weixin platform API')
      const segments = t.sessions[0]?.message ?? []
      expect(segments.map((segment) => segment.type)).toEqual(['image', 'video', 'file', 'audio', 'text'])
      expect(segments[2]).toMatchObject({ data: { name: 'name.txt' } })
      expect(t.sessions[0]?.text).toBe('微信语音转写')
      const [imageId, videoId, fileId, voiceId] = segments.flatMap((segment) =>
        isSegment(segment, 'image') ||
        isSegment(segment, 'video') ||
        isSegment(segment, 'file') ||
        isSegment(segment, 'audio')
          ? [segment.data.file]
          : [],
      )
      if (!imageId || !videoId || !fileId || !voiceId) throw new Error('Missing media handles')
      await expect(bot.weixin.downloadMedia(String(imageId))).resolves.toEqual(Buffer.from('mock image'))
      await expect(bot.weixin.downloadMedia(String(videoId))).resolves.toEqual(Buffer.from('mock video'))
      await expect(bot.weixin.downloadMedia(String(fileId))).resolves.toEqual(Buffer.from('mock file'))
      await expect(bot.weixin.downloadMedia(String(voiceId))).resolves.toEqual(voiceBytes)
      const wav = await bot.weixin.downloadMedia(String(voiceId), 'wav')
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
      expect(wav.readUInt32LE(24)).toBe(24_000)
      expect(t.sessions[2]?.message[0]).toEqual({
        type: 'reply',
        data: { id: quotedId, message: [seg.text('/should-not-run')] },
      })
      expect(t.sessions[2]?.text).toBe('引用新消息')
      expect(t.sessions[3]?.message[0]).toEqual(seg.reply(quotedId))

      const text = `${'a'.repeat(3999)}😀b`
      const path = join(t.app.config.dataDir, 'upload.txt')
      await writeFile(path, 'outbound file')
      const before = mock.sent.length
      await bot.sendPrivate('peer', [
        seg.markdown('**开头**'),
        seg.image(Buffer.from('outbound image')),
        seg.text(text),
        seg.video(Buffer.from('outbound video')),
        seg.file(pathToFileURL(path)),
        seg.button('帮助', { command: '/help' }),
      ])
      const items = mock.sent.slice(before).flatMap(({ msg }) => msg.item_list as Fields[])
      expect(items.map((item) => item.type)).toEqual([1, 2, 1, 1, 5, 4, 1])
      expect(items[0]?.text_item).toEqual({ text: '开头' })
      expect(items[2]?.text_item).toEqual({ text: text.slice(0, 3999) })
      expect(items[3]?.text_item).toEqual({ text: '😀b' })
      expect(items[6]?.text_item).toEqual({ text: '帮助：发送 /help' })
      expect([...mock.uploads.values()].map(({ type, raw }) => [type, raw.toString()])).toEqual([
        [1, 'outbound image'],
        [2, 'outbound video'],
        [3, 'outbound file'],
      ])
      await bot.weixin.setTyping('peer')
      await bot.weixin.setTyping('peer', false)
      expect(mock.typing).toMatchObject([
        { method: 'getconfig', ilink_user_id: 'peer', context_token: context },
        { method: 'sendtyping', status: 1, typing_ticket: mock.typingTicket },
        { method: 'sendtyping', status: 2, typing_ticket: mock.typingTicket },
      ])

      const panel = await t.panel()
      const missing = await panel('/send', 'POST', {
        target: `${platform}:${selfId}:private:unknown`,
        message: 'hi',
      })
      expect(missing.status).toBe(409)
      expect((await missing.json()).error.message).toContain('请先让对方')
      const history = await panel('/ext/history/messages')
      expect(history.status).toBe(200)
      const records = await history.json()
      expect(records.items).toContainEqual(expect.objectContaining({ direction: 'out', text: '开头' }))
      const visible = JSON.stringify([await (await panel('/connections')).json(), records, t.sessions, t.log])
      for (const secret of [
        token,
        context,
        image.param,
        video.param,
        voice.param,
        image.key.toString('hex'),
        mock.typingTicket,
        ...mock.uploads.keys(),
      ])
        expect(visible).not.toContain(secret)
    } finally {
      await t.dispose()
    }
  }, 12_000)

  it('rejects untrusted redirects and remote private media without exposing upstream parameters', async () => {
    const mock = new MockIlink()
    const token = randomUUID()
    const secret = randomUUID()
    const selfId = 'one@im.bot'
    mock.pendingQr.push([
      { status: 'scaned_but_redirect', redirect_host: `example.invalid?secret=${secret}` },
    ])
    mock.update(token, {
      ret: 0,
      msgs: [
        {
          message_type: 1,
          from_user_id: 'peer',
          context_token: 'known',
          item_list: [
            { type: 2, image_item: { media: { full_url: `https://127.0.0.1/download?secret=${secret}` } } },
          ],
        },
      ],
    })
    const t = await fixture(mock, [{ id: 'one', name: 'One', adapter: platform, config: { selfId, token } }])
    try {
      const panel = await t.panel()
      const id = await start(panel)
      expect(JSON.stringify(await status(panel, id, 'failed'))).not.toContain(secret)
      expect(mock.qrRequests).toHaveLength(1)
      await vi.waitFor(() => expect(t.sessions).toHaveLength(1))
      const bot = t.app.getBot(platform, selfId)
      const image = t.sessions[0]?.message[0]
      if (!bot || !isWeixinClawBot(bot) || !image || !isSegment(image, 'image'))
        throw new Error('Missing image event')
      await expect(bot.weixin.downloadMedia(image.data.file)).rejects.toThrow('微信媒体下载、解密或转码失败')
      await expect(
        bot.sendPrivate('peer', seg.image(`http://127.0.0.1/media?secret=${secret}`)),
      ).rejects.toThrow('无法读取微信待发送媒体')
      expect(mock.mediaRequests).toEqual([])
      expect(mock.sent).toEqual([])
      expect(JSON.stringify(t.log)).not.toContain(secret)
    } finally {
      await t.dispose()
    }
  })
})
