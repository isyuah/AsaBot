import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import { definePlugin } from '@asabot/core'
import { createTestApp, type TestApp } from '@asabot/core/testing'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Audit } from './audit.ts'
import type {
  AiGenerateOptions,
  AiService,
  AiStreamEvent,
  CatalogView,
  ChannelDraft,
  ChannelView,
  ModelDraft,
  ModelView,
  RequestDetail,
  RequestPage,
  UsageReport,
} from './contracts.ts'
import ai from './index.ts'

const panelPassword = 'ai-test-panel-password'
const fixtureKey = 'fixture-key-not-a-real-credential'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKp0AAAAASUVORK5CYII='
const prompt: AiGenerateOptions = { messages: [{ role: 'user', content: 'Hello from a consumer' }] }
const schema = {
  type: 'object',
  properties: { region: { type: 'string' } },
  required: ['region'],
  additionalProperties: false,
} as const

interface UpstreamCall {
  path: string
  method: string | undefined
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

function bodyJson(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
}

function wav() {
  const sampleRate = 24_000
  const dataSize = sampleRate * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

function providerResponse(call: UpstreamCall, response: ServerResponse) {
  const name = String(call.body.model)
  if (call.path === '/chat/v1/models') {
    bodyJson(response, { data: [{ id: 'chat-fixture' }] })
  } else if (call.path === '/messages/v1/models?limit=100') {
    bodyJson(response, { data: [{ id: 'claude-fixture', display_name: 'Claude fixture' }], has_more: false })
  } else if (call.path === '/google/v1beta/models?pageSize=100') {
    bodyJson(response, {
      models: [{ name: 'models/gemini-fixture', displayName: 'Gemini fixture' }],
      nextPageToken: 'page-2',
    })
  } else if (call.path === '/google/v1beta/models?pageSize=100&pageToken=page-2') {
    bodyJson(response, { models: [{ name: 'models/gemini-tts-fixture' }] })
  } else if (call.path === '/chat/v1/chat/completions' || call.path === '/missing/v1/chat/completions') {
    if (name === 'cancel-fixture') return
    if (name === 'fail-fixture') {
      bodyJson(response, { error: { message: `upstream echo ${fixtureKey}`, type: 'invalid_api_key' } }, 401)
      return
    }
    if (call.body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const base = { id: 'completion-fixture', created: 1, model: name, object: 'chat.completion.chunk' }
      const data = (payload: object) => response.write(`data: ${JSON.stringify({ ...base, ...payload })}\n\n`)
      data({ choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })
      if (name === 'stream-hangs') return
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      data({
        choices: [],
        usage: {
          prompt_tokens: 9,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens: 3,
          total_tokens: 12,
        },
      })
      response.end('data: [DONE]\n\n')
      return
    }
    const toolAsk = name === 'tool-fixture' && !JSON.stringify(call.body.messages).includes('role":"tool')
    bodyJson(response, {
      id: 'completion-fixture',
      model: name,
      created: 1,
      choices: [
        {
          index: 0,
          finish_reason: toolAsk ? 'tool_calls' : 'stop',
          message: toolAsk
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    type: 'function',
                    id: 'call_1',
                    function: { name: 'lookup', arguments: '{"region":"zh"}' },
                  },
                ],
              }
            : {
                role: 'assistant',
                content:
                  name === 'echo-fixture'
                    ? `authorization: Bearer ${fixtureKey}`
                    : name === 'invalid-json'
                      ? '{"region":5}'
                      : name === 'json-fixture'
                        ? '{"region":"zh"}'
                        : 'OK',
              },
        },
      ],
      ...(name === 'no-usage' ? {} : { usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }),
    })
  } else if (call.path === '/responses/v1/responses') {
    bodyJson(response, {
      id: 'resp_fixture',
      created_at: 1,
      model: 'responses-versioned',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          id: 'message-fixture',
          content: [{ type: 'output_text', text: 'Responses OK', annotations: [] }],
        },
      ],
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
    })
  } else if (call.path === '/messages/v1/messages') {
    bodyJson(response, {
      type: 'message',
      id: 'msg-fixture',
      model: name,
      role: 'assistant',
      content: [{ type: 'text', text: 'Messages OK' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 2 },
    })
  } else if (call.path.startsWith('/google/v1beta/models/') && call.path.endsWith(':generateContent')) {
    const config = call.body.generationConfig as { responseModalities?: string[] } | undefined
    const part = config?.responseModalities?.includes('AUDIO')
      ? { inlineData: { data: Buffer.alloc(48_000).toString('base64'), mimeType: 'audio/L16;rate=24000' } }
      : config?.responseModalities?.includes('IMAGE')
        ? { inlineData: { data: png, mimeType: 'image/png' } }
        : { text: 'Gemini OK' }
    bodyJson(response, {
      candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [part] } }],
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, totalTokenCount: 8 },
    })
  } else if (call.path === '/chat/v1/images/generations') {
    bodyJson(response, {
      created: 1,
      data: [{ b64_json: png }],
      usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
    })
  } else if (call.path === '/chat/v1/audio/speech') {
    response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(wav())
  } else if (call.path === '/jev/v1/systemone') {
    const questions = call.body.questions as Record<string, { type: string }>
    const answers = Object.fromEntries(
      Object.entries(questions).map(([key, question]) => [
        key,
        question.type === 'choice'
          ? {
              type: 'choice',
              choice: 'billing',
              confidence: 0.8,
              probabilities: { billing: 0.9, support: 0.1 },
            }
          : question.type === 'score'
            ? {
                type: 'score',
                score: 0.7,
                confidence: 0.4,
                probabilities: { '0': 0.3, '1': 0.7 },
                legend: { '0': 'low', '1': 'high' },
              }
            : { type: 'noul', noul: 0.8 },
      ]),
    )
    bodyJson(response, {
      model: 'jev-fixture-version',
      answers,
      usage: { input_tokens: 7, output_tokens: 1 },
    })
  } else {
    bodyJson(response, { error: { message: 'mock endpoint not found' } }, 404)
  }
}

let upstream: Server
let remote: string
let calls: UpstreamCall[]
let testApp: TestApp
let origin: string
let cookie: string
const consumers = new Map<string, AiService>()

function client(name: string) {
  const service = consumers.get(name)
  if (!service) throw new Error(`Missing service for ${name}`)
  return service
}

function consume(name: string, optional = false) {
  return definePlugin({
    name,
    inject: optional ? { optional: ['ai'] } : ['ai'],
    defaultOnNewBots: true,
    setup(ctx) {
      const service = optional ? ctx.injectOptional('ai') : ctx.inject('ai')
      expectTypeOf(service).toEqualTypeOf<AiService | undefined>()
      if (!service) return
      consumers.set(name, service)
      ctx
        .command(`${name}-chat`)
        .action(async ({ signal }) => (await service.generate({ ...prompt, signal })).text)
      ctx.panel.route((app) =>
        app.get('/invoke', async (request) => request.json(await service.generate(prompt))),
      )
    },
  })
}

async function callPanel(path: string, method = 'GET', value?: unknown): Promise<Response> {
  return fetch(`${origin}/api/panel/ext/ai${path}`, {
    method,
    headers: { cookie, origin, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
    body: value === undefined ? undefined : JSON.stringify(value),
  })
}

async function panel<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  const response = await callPanel(path, method, value)
  if (!response.ok) throw new Error(`Panel ${path} returned ${response.status}: ${await response.text()}`)
  return response.status === 204 ? (undefined as T) : response.json()
}

async function channel(
  path = '/chat/v1',
  protocol: ChannelDraft['protocol'] = 'openai-chat',
  extra: Partial<ChannelDraft> = {},
) {
  return panel<ChannelView>('/channels', 'POST', {
    name: path,
    protocol,
    baseUrl: `${remote}${path}`,
    timeoutMs: 5_000,
    enabled: true,
    ...extra,
  })
}

function model(
  channelId: string,
  upstreamModel: string,
  capabilities: ModelDraft['capabilities'] = ['chat'],
) {
  return panel<ModelView>('/models', 'POST', {
    channelId,
    name: upstreamModel,
    upstreamModel,
    capabilities,
    enabled: true,
  })
}

async function record(requestId: string) {
  return panel<RequestDetail>(`/requests/${requestId}`)
}

beforeEach(async () => {
  calls = []
  consumers.clear()
  upstream = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const text = Buffer.concat(chunks).toString('utf8')
      const call = {
        path: request.url ?? '/',
        method: request.method,
        headers: request.headers,
        body: text ? JSON.parse(text) : {},
      }
      calls.push(call)
      providerResponse(call, response)
    } catch (error) {
      response.destroy(error instanceof Error ? error : undefined)
    }
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const bound = upstream.address()
  if (typeof bound !== 'object' || !bound) throw new Error('Upstream not listening')
  remote = `http://127.0.0.1:${bound.port}`
  testApp = await createTestApp({
    plugins: [ai, consume('consumer-alpha'), consume('consumer-beta', true)],
    config: { server: { port: 0, panelPassword } },
  })
  origin = `http://127.0.0.1:${testApp.app.server?.address()?.port}`
  const auth = await fetch(`${origin}/api/panel/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: panelPassword }),
  })
  cookie = auth.headers.get('set-cookie')?.split(';')[0] ?? ''
  if (!cookie) throw new Error('Panel did not authenticate')
})

afterEach(async () => {
  await testApp?.dispose()
  upstream?.closeAllConnections()
  await new Promise<void>((resolve) => upstream?.close(() => resolve()) ?? resolve())
  vi.unstubAllEnvs()
})

describe('AI gateway', () => {
  it('binds plugin identity to permissions and logs commands and plugin HTTP calls', async () => {
    const endpoint = await channel()
    const common = await model(endpoint.id, 'common')
    const assigned = await model(endpoint.id, 'assigned')
    const scoped = client('consumer-alpha')
    const beta = client('consumer-beta')
    await panel('/defaults', 'PUT', { chat: common.id })
    await panel('/policies/consumer-alpha', 'PUT', {
      defaults: { chat: assigned.id },
      allowlist: [assigned.id],
    })
    expect(await (await fetch(`${origin}/api/panel/ext/ai/catalog`)).text()).not.toContain(assigned.id)
    expect((await fetch(`${origin}/api/panel/ext/ai/catalog`)).status).toBe(401)
    expect((await panel<CatalogView>('/catalog')).consumers).toEqual(['consumer-alpha', 'consumer-beta'])
    expect(scoped.listModels()).toEqual([{ id: assigned.id, name: 'assigned', capabilities: ['chat'] }])
    expect(scoped.listModels({ capability: 'image' })).toEqual([])
    expect((await scoped.generate(prompt)).modelId).toBe(assigned.id)
    expect((await beta.generate(prompt)).modelId).toBe(common.id)
    const blockedAt = calls.length
    await expect(scoped.generate({ ...prompt, modelId: common.id })).rejects.toMatchObject({
      code: 'MODEL_FORBIDDEN',
    })
    await expect(scoped.stream(prompt)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    })
    expect(calls).toHaveLength(blockedAt)
    await panel('/policies/consumer-alpha', 'PUT', {
      defaults: { chat: assigned.id },
      allowlist: [assigned.id, common.id],
    })
    expect((await scoped.generate({ ...prompt, modelId: common.id })).modelId).toBe(common.id)

    expect(await testApp.say('/consumer-alpha-chat')).toEqual(['OK'])
    const http = await fetch(`${origin}/api/panel/ext/consumer-beta/invoke`, { headers: { cookie } })
    expect(http.status).toBe(200)
    const invoked = await http.json()
    expect(await record(invoked.requestId)).toMatchObject({
      source: 'consumer-beta',
      modelId: common.id,
      status: 'succeeded',
    })
    const rows = await panel<RequestPage>('/requests?source=consumer-alpha&status=succeeded')
    expect(rows.items[0]).toMatchObject({
      source: 'consumer-alpha',
      platform: 'virtual',
      eventId: expect.any(String),
      modelId: assigned.id,
    })

    const { id: assignedId, ...assignedDraft } = assigned
    const incompatibleEdit = await callPanel(`/models/${assignedId}`, 'PUT', {
      ...assignedDraft,
      capabilities: ['image'],
    })
    expect(incompatibleEdit.status).toBe(409)
    await panel(`/models/${assignedId}`, 'PUT', { ...assignedDraft, enabled: false })
    expect(scoped.listModels().map(({ id }) => id)).toEqual([common.id])
    await expect(scoped.generate(prompt)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
    await panel('/policies/consumer-alpha', 'PUT', { defaults: {}, allowlist: [] })
    expect(scoped.listModels()).toEqual([])
    await expect(scoped.generate(prompt)).rejects.toMatchObject({ code: 'MODEL_FORBIDDEN' })
  })

  it('uses protocol-native requests, returns data and preserves actual usage', async () => {
    vi.stubEnv('ASABOT_AI_FIXTURE_KEY', fixtureKey)
    const openai = await channel('/chat/v1', 'openai-chat', {
      credential: { kind: 'key', value: fixtureKey },
    })
    const responses = await channel('/responses/v1', 'openai-responses')
    const anthropic = await channel('/messages/v1', 'anthropic', {
      credential: { kind: 'env', variable: 'ASABOT_AI_FIXTURE_KEY' },
    })
    const google = await channel('/google/v1beta', 'gemini', {
      credential: { kind: 'env', variable: 'ASABOT_AI_FIXTURE_KEY' },
    })
    const jev = await channel('/jev/v1', 'system-one', { credential: { kind: 'key', value: fixtureKey } })
    const sdk = client('consumer-alpha')
    expect(await panel(`/channels/${openai.id}/discover`)).toEqual({
      models: [{ upstreamModel: 'chat-fixture', name: 'chat-fixture' }],
      truncated: false,
    })
    expect(await panel(`/channels/${anthropic.id}/discover`)).toMatchObject({
      models: [{ upstreamModel: 'claude-fixture', name: 'Claude fixture' }],
    })
    expect(await panel(`/channels/${google.id}/discover`)).toMatchObject({
      models: [{ upstreamModel: 'gemini-fixture' }, { upstreamModel: 'gemini-tts-fixture' }],
    })

    const responseModel = await model(responses.id, 'responses')
    const anthropicModel = await model(anthropic.id, 'claude-fixture', ['chat', 'vision'])
    const googleModel = await model(google.id, 'gemini-fixture')
    const chat = await sdk.generate({ ...prompt, modelId: responseModel.id })
    expect(chat).toMatchObject({
      text: 'Responses OK',
      upstreamModel: 'responses-versioned',
      usage: { inputTokens: 4, outputTokens: 1 },
    })
    expect(
      await sdk.generate({
        modelId: anthropicModel.id,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', data: Buffer.from(png, 'base64'), mediaType: 'image/png' },
            ],
          },
        ],
      }),
    ).toMatchObject({ text: 'Messages OK' })
    expect(await sdk.generate({ ...prompt, modelId: googleModel.id })).toMatchObject({
      text: 'Gemini OK',
      usage: { inputTokens: 6, outputTokens: 2 },
    })
    expect(calls.find(({ path }) => path === '/responses/v1/responses')).toMatchObject({
      body: { store: false },
    })
    expect(calls.find(({ path }) => path === '/messages/v1/messages')).toMatchObject({
      headers: { 'x-api-key': fixtureKey },
      body: {
        messages: [
          {
            content: [
              { text: 'look' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
            ],
          },
        ],
      },
    })
    expect(
      calls.find(({ path }) => path === '/google/v1beta/models/gemini-fixture:generateContent'),
    ).toMatchObject({ headers: { 'x-goog-api-key': fixtureKey } })

    for (const [endpoint, name] of [
      [openai, 'test-image'],
      [google, 'gemini-image-fixture'],
    ] as const) {
      const imageModel = await model(endpoint.id, name, ['image'])
      const generated = await sdk.generateImage({ prompt: 'A small kite', modelId: imageModel.id })
      expect(generated.images).toEqual([{ mediaType: 'image/png', data: Buffer.from(png, 'base64') }])
      expect(generated.usage.images).toBe(1)
    }
    for (const [endpoint, name] of [
      [openai, 'test-tts'],
      [google, 'gemini-tts-fixture'],
    ] as const) {
      const speechModel = await model(endpoint.id, name, ['speech'])
      const generated = await sdk.synthesizeSpeech({ modelId: speechModel.id, text: '你好 🌱' })
      expect(generated.audio.data.subarray(0, 4).toString()).toBe('RIFF')
      expect(generated.audio.mediaType).toMatch(/^audio\//)
      expect(generated.usage).toMatchObject({ speechCharacters: 4, audioSeconds: 1 })
    }
    const decisionModel = await model(jev.id, 'jev-latest', ['decision'])
    const decision = await sdk.decide({
      modelId: decisionModel.id,
      state: { ticket: 'billing' },
      questions: {
        urgent: { type: 'noul', instructions: 'Urgent?' },
        team: { type: 'choice', criteria: { billing: 'Payment issue', support: null } },
        level: { type: 'score', instructions: 'How important?', criteria: ['low', 'high'] },
      },
    })
    expect(decision).toMatchObject({
      upstreamModel: 'jev-fixture-version',
      usage: { inputTokens: 7, outputTokens: 1, decisions: 3 },
      answers: { urgent: { noul: 0.8 }, team: { choice: 'billing', confidence: 0.8 }, level: { score: 0.7 } },
    })
    expect(calls.find(({ path }) => path === '/jev/v1/systemone')).toMatchObject({
      headers: { authorization: `Bearer ${fixtureKey}` },
      body: { model: 'jev-latest', state: { ticket: 'billing' } },
    })
    expect(await record(chat.requestId)).not.toHaveProperty('content')
    const { requestId } = await panel<{ requestId: string }>('/test', 'POST', {
      capability: 'decision',
      modelId: decisionModel.id,
    })
    expect(await record(requestId)).toMatchObject({ source: '@panel', mode: 'test' })
    const usage = await panel<UsageReport>('/usage?groupBy=capability')
    expect(usage.total).toMatchObject({
      requests: 9,
      succeeded: 9,
      usage: {
        images: { value: 2, reported: 2 },
        decisions: { value: 4, reported: 2 },
        audioSeconds: { value: 2, reported: 2 },
      },
    })
    expect(usage.groups).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'decision', requests: 2 })]),
    )
  })

  it('streams text, validates JSON output and lets the consumer execute and return tool results', async () => {
    const endpoint = await channel()
    const sdk = client('consumer-alpha')
    const streaming = await model(endpoint.id, 'streaming', ['chat', 'stream'])
    const events: AiStreamEvent[] = []
    for await (const part of sdk.stream({ ...prompt, modelId: streaming.id })) events.push(part)
    expect(events).toEqual([
      { type: 'text-delta', text: 'OK' },
      {
        type: 'finish',
        result: expect.objectContaining({
          text: 'OK',
          usage: expect.objectContaining({ inputTokens: 9, outputTokens: 3 }),
        }),
      },
    ])
    const [streamRecord] = (await panel<RequestPage>('/requests')).items
    expect(streamRecord).toMatchObject({ mode: 'stream', status: 'succeeded' })
    expect(streamRecord?.usage).toEqual({ inputTokens: 9, outputTokens: 3, cachedInputTokens: 0 })
    const structured = await model(endpoint.id, 'json-fixture', ['chat', 'structured'])
    expect(
      await sdk.generate({
        ...prompt,
        modelId: structured.id,
        outputSchema: { ...schema, required: ['region'] },
      }),
    ).toMatchObject({ output: { region: 'zh' } })
    const invalid = await model(endpoint.id, 'invalid-json', ['chat', 'structured'])
    await expect(
      sdk.generate({ ...prompt, modelId: invalid.id, outputSchema: { ...schema, required: ['region'] } }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_OUTPUT' })
    const toolModel = await model(endpoint.id, 'tool-fixture', ['chat', 'tools'])
    const tools = {
      lookup: { description: 'Look up the region', inputSchema: { ...schema, required: ['region'] } },
    }
    const reply = await sdk.generate({ ...prompt, tools, modelId: toolModel.id })
    expect(reply.toolCalls).toEqual([{ id: 'call_1', name: 'lookup', input: { region: 'zh' } }])
    expect(
      await sdk.generate({
        ...prompt,
        tools,
        modelId: toolModel.id,
        messages: [
          ...prompt.messages,
          { role: 'assistant', toolCalls: reply.toolCalls },
          { role: 'tool', toolCallId: 'call_1', toolName: 'lookup', output: { available: true } },
        ],
      }),
    ).toMatchObject({ text: 'OK' })
  })

  it('registers one terminal result for dropped streams, timeout, and plugin unload', async () => {
    const endpoint = await channel('/chat/v1', 'openai-chat', { timeoutMs: 1_000 })
    const hanging = await model(endpoint.id, 'cancel-fixture')
    const streaming = await model(endpoint.id, 'stream-hangs', ['chat', 'stream'])
    const sdk = client('consumer-alpha')
    for await (const part of sdk.stream({ ...prompt, modelId: streaming.id })) {
      expect(part).toEqual({ type: 'text-delta', text: 'OK' })
      break
    }
    await expect(sdk.generate({ ...prompt, modelId: hanging.id })).rejects.toMatchObject({ code: 'TIMEOUT' })
    const pending = sdk.generate({ ...prompt, modelId: hanging.id })
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    await testApp.app.plugins.disable('consumer-alpha')
    await cancelled
    expect(() => sdk.listModels()).toThrow('AI 请求已取消')
    expect((await panel<RequestPage>('/requests')).items.map((row) => row.status)).toEqual([
      'cancelled',
      'timeout',
      'cancelled',
    ])
    expect((await panel<UsageReport>('/usage')).total.requests).toBe(3)
  })

  it('keeps keys out of views and audit, expires captured bodies and retains rollups', async () => {
    const endpoint = await channel('/chat/v1', 'openai-chat', {
      credential: { kind: 'key', value: fixtureKey },
    })
    const echo = await model(endpoint.id, 'echo-fixture')
    const fail = await model(endpoint.id, 'fail-fixture')
    const unknown = await model(endpoint.id, 'no-usage')
    const sdk = client('consumer-alpha')
    expect(endpoint.credential).toEqual({ kind: 'key', status: 'configured' })
    const stored = testApp.app.storage.db
      .prepare('SELECT credential FROM p_ai_channels WHERE id = ?')
      .get(endpoint.id)
    expect(JSON.stringify(stored)).not.toContain(fixtureKey)
    expect(await (await callPanel('/catalog')).text()).not.toContain(fixtureKey)
    await panel('/capture', 'PUT', { source: 'consumer-alpha' })
    const success = await sdk.generate({
      modelId: echo.id,
      messages: [{ role: 'user', content: `api_key=${fixtureKey}` }],
    })
    const failure = await sdk.generate({ ...prompt, modelId: fail.id }).catch((error) => error)
    expect(failure).toMatchObject({ code: 'UPSTREAM_AUTH', httpStatus: 401 })
    expect(failure.message).not.toContain(fixtureKey)
    expect(failure.cause).toBeUndefined()
    const result = await record(success.requestId)
    expect(result.content?.input).toContain('[已隐藏]')
    expect(result.content?.output).toContain('[已隐藏]')
    expect(JSON.stringify(result)).not.toContain(fixtureKey)
    expect(JSON.stringify(await record(failure.requestId))).not.toContain(fixtureKey)
    const missing = await client('consumer-beta').generate({ ...prompt, modelId: unknown.id })
    expect((await record(missing.requestId)).usage).toEqual({})
    expect(await record(missing.requestId)).not.toHaveProperty('content')

    const audit = new Audit(testApp.app.storage.db)
    const savedUntil = result.content?.expiresAt ?? 0
    expect(audit.detail(result.id, savedUntil).content).toBeUndefined()
    audit.cleanup(savedUntil)
    expect((await record(success.requestId)).content).toBeUndefined()
    await testApp.app.plugins.disable('ai')
    await testApp.app.plugins.enable('ai')
    expect((await panel<CatalogView>('/catalog')).channels[0]?.credential.status).toBe('configured')
    const stats = await panel<UsageReport>('/usage')
    expect(stats.total).toMatchObject({
      requests: 3,
      succeeded: 2,
    })
    expect(stats.total.usage).toEqual({
      inputTokens: { value: 9, reported: 1 },
      outputTokens: { value: 3, reported: 1 },
    })
    audit.cleanup(Date.now() + 31 * 86_400_000)
    expect((await panel<RequestPage>('/requests')).items).toEqual([])
    expect((await panel<UsageReport>('/usage')).total).toEqual(stats.total)
  })
})
