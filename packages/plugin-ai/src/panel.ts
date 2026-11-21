import { type Context, type HttpService, z } from '@asabot/core'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Audit } from './audit.ts'
import type { Catalog } from './catalog.ts'
import { capabilities } from './contracts.ts'
import { AiError, type AiErrorCode } from './errors.ts'
import { discover, Transport } from './providers.ts'
import {
  channelDraft,
  defaultDraft,
  id,
  modelDraft,
  parse,
  pluginName,
  policyDraft,
  requestQuery,
  sourceName,
  usageQuery,
} from './schema.ts'
import type { Gateway } from './service.ts'

const statuses: Record<AiErrorCode, ContentfulStatusCode> = {
  INVALID_INPUT: 400,
  MODEL_FORBIDDEN: 403,
  MODEL_UNAVAILABLE: 409,
  MODEL_NOT_CONFIGURED: 409,
  CAPABILITY_UNSUPPORTED: 400,
  CREDENTIAL_UNAVAILABLE: 409,
  CATALOG_UNSUPPORTED: 400,
  TIMEOUT: 504,
  CANCELLED: 409,
  INTERRUPTED: 500,
  UPSTREAM_AUTH: 502,
  UPSTREAM_RATE_LIMIT: 429,
  UPSTREAM_REQUEST: 502,
  UPSTREAM_OUTPUT: 502,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
}

async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new AiError('INVALID_INPUT')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 128 * 1024) {
        await reader.cancel()
        throw new AiError('INVALID_INPUT', { message: '请求正文过大' })
      }
      chunks.push(chunk.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch (error) {
    if (error instanceof AiError) throw error
    throw new AiError('INVALID_INPUT', { message: '请求正文必须为 JSON' })
  } finally {
    reader.releaseLock()
  }
}

const testInput = z.strictObject({ modelId: id, capability: z.enum(capabilities) })
const captureInput = z.strictObject({ source: sourceName.nullable() })

export function registerPanel(
  ctx: Context,
  catalog: Catalog,
  audit: Audit,
  gateway: Gateway,
  http: HttpService,
): void {
  const { signal, logger } = ctx
  ctx.panel.page({ title: 'AI 管理', icon: 'sparkles', root: new URL('../dist/panel/', import.meta.url) })
  ctx.panel.route((app) => {
    app.use('*', async (request, next) => {
      request.header('Cache-Control', 'no-store')
      await next()
    })
    app.onError((error, request) => {
      if (error instanceof AiError) {
        return request.json(
          { error: { code: error.code, message: error.message, requestId: error.requestId } },
          statuses[error.code],
        )
      }
      logger.error({ errorName: error.name }, 'AI panel operation failed')
      return request.json({ error: { code: 'INTERNAL', message: new AiError('INTERNAL').message } }, 500)
    })

    app.get('/catalog', (request) => request.json(catalog.snapshot(ctx.serviceConsumers('ai'))))
    app.post('/channels', async (request) =>
      request.json(catalog.saveChannel(parse(channelDraft, await body(request.req.raw))), 201),
    )
    app.put('/channels/:id', async (request) =>
      request.json(
        catalog.saveChannel(
          parse(channelDraft, await body(request.req.raw)),
          parse(id, request.req.param('id')),
        ),
      ),
    )
    app.delete('/channels/:id', (request) => {
      catalog.deleteChannel(parse(id, request.req.param('id')))
      return request.body(null, 204)
    })
    app.get('/channels/:id/discover', async (request) => {
      const channel = catalog.channel(parse(id, request.req.param('id')))
      if (!channel) throw new AiError('NOT_FOUND')
      const upstreamSignal = AbortSignal.any([
        signal,
        request.req.raw.signal,
        AbortSignal.timeout(channel.timeoutMs),
      ])
      return request.json(
        await discover(
          new Transport(http, channel, catalog.secret(channel), upstreamSignal),
          channel.protocol,
        ),
      )
    })

    app.post('/models', async (request) =>
      request.json(catalog.saveModel(parse(modelDraft, await body(request.req.raw))), 201),
    )
    app.put('/models/:id', async (request) =>
      request.json(
        catalog.saveModel(parse(modelDraft, await body(request.req.raw)), parse(id, request.req.param('id'))),
      ),
    )
    app.delete('/models/:id', (request) => {
      catalog.deleteModel(parse(id, request.req.param('id')))
      return request.body(null, 204)
    })
    app.put('/defaults', async (request) => {
      catalog.saveDefaults(parse(defaultDraft, await body(request.req.raw)))
      return request.body(null, 204)
    })
    app.put('/policies/:plugin', async (request) => {
      catalog.savePolicy(
        parse(pluginName, request.req.param('plugin')),
        parse(policyDraft, await body(request.req.raw)),
      )
      return request.body(null, 204)
    })
    app.delete('/policies/:plugin', (request) => {
      catalog.deletePolicy(parse(pluginName, request.req.param('plugin')))
      return request.body(null, 204)
    })

    app.get('/requests', (request) => request.json(audit.list(parse(requestQuery, request.req.query()))))
    app.get('/requests/:id', (request) => request.json(audit.detail(parse(id, request.req.param('id')))))
    app.get('/usage', (request) => request.json(audit.usage(parse(usageQuery, request.req.query()))))
    app.put('/capture', async (request) =>
      request.json(catalog.setCapture(parse(captureInput, await body(request.req.raw)).source)),
    )
    app.post('/test', async (request) => {
      const { modelId, capability } = parse(testInput, await body(request.req.raw))
      const ai = gateway.panel(request.req.raw.signal)
      const result = await (() => {
        switch (capability) {
          case 'chat':
            return ai.generate({ modelId, messages: [{ role: 'user', content: 'Respond briefly with OK.' }] })
          case 'image':
            return ai.generateImage({ modelId, prompt: 'A small orange kite on a clear blue sky.' })
          case 'speech':
            return ai.synthesizeSpeech({ modelId, text: 'Hello from AsaBot.' })
          case 'decision':
            return ai.decide({
              modelId,
              state: 'The sky is blue.',
              questions: {
                sky_is_blue: { type: 'noul', instructions: 'Does the statement say the sky is blue?' },
              },
            })
        }
      })()
      return request.json({ requestId: result.requestId })
    })
  })
}
