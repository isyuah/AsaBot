import { createHmac, timingSafeEqual } from 'node:crypto'
import { definePlugin, parseTarget, z } from '@asabot/core'

const deployPayload = z.object({ service: z.string().min(1).max(100), version: z.string().min(1).max(100) })
const releasePayload = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string().min(1).max(200) }),
  release: z.object({ tag_name: z.string().min(1).max(100) }),
})

const maxBodySize = 1024 * 1024
async function rawBody(request: Request): Promise<Buffer | undefined> {
  const reader = request.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks, size)
    size += value.length
    if (size > maxBodySize) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

export default definePlugin({
  name: 'release-notifier',
  description: '把 CI 部署结果和 GitHub Release 发布通知发到指定会话',
  config: z.object({
    target: z.string().min(1).meta({ title: '通知目标', description: '例如 onebot11:group:123456' }),
  }),
  credentials: {
    deploy: { title: '部署通知', description: 'CI 请求在 X-Deploy-Key 请求头中传入。' },
    github: { title: 'GitHub Webhook', description: '与 GitHub Webhook 设置中的 Secret 使用同一个值。' },
  },
  setup(ctx) {
    const target = parseTarget(ctx.config.target)
    ctx.route((app) => {
      app.post('/deploy', async (c) => {
        if (!ctx.credentials.match(c.req.header('X-Deploy-Key'), { group: 'deploy' }))
          return c.json({ error: 'Invalid credential' }, 401)
        const bytes = await rawBody(c.req.raw)
        if (!bytes) return c.json({ error: 'Request body is too large' }, 413)
        const payload = deployPayload.safeParse(parseJson(bytes))
        if (!payload.success) return c.json({ error: 'Expected service and version' }, 400)
        await ctx.send(target, `部署完成：${payload.data.service} ${payload.data.version}`)
        return c.body(null, 204)
      })

      app.post('/github', async (c) => {
        const signature = /^sha256=([0-9a-f]{64})$/i.exec(c.req.header('X-Hub-Signature-256') ?? '')?.[1]
        if (!signature) return c.json({ error: 'Invalid signature' }, 401)
        const bytes = await rawBody(c.req.raw)
        if (!bytes) return c.json({ error: 'Request body is too large' }, 413)

        const received = Buffer.from(signature, 'hex')
        let verified = false
        for (const { value } of ctx.credentials.readAll({ group: 'github' })) {
          const expected = createHmac('sha256', value).update(bytes).digest()
          if (timingSafeEqual(received, expected)) verified = true
        }
        if (!verified) return c.json({ error: 'Invalid signature' }, 401)
        if (c.req.header('X-GitHub-Event') !== 'release') return c.body(null, 204)
        const payload = releasePayload.safeParse(parseJson(bytes))
        if (!payload.success) return c.json({ error: 'Invalid release payload' }, 400)
        if (payload.data.action === 'published')
          await ctx.send(
            target,
            `发布了新版本：${payload.data.repository.full_name} ${payload.data.release.tag_name}`,
          )
        return c.body(null, 204)
      })
    })
  },
})
