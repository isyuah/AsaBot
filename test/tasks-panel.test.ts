import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { DeliveryError, definePlugin, type TaskHandle } from '../src/index.ts'
import { createTestApp } from '../src/testing/index.ts'

describe('task center', () => {
  it('records uncertain sends, prevents automatic replay and requires confirmation for manual replay', async () => {
    const target = { platform: 'virtual', selfId: '10000', type: 'group' as const, id: '10' }
    let job!: TaskHandle<null>
    let sends = 0
    const t = await createTestApp({
      config: { server: { port: 0, panelPassword: 'task-panel-secret', apiToken: 'send-api-secret' } },
      plugins: [
        definePlugin({
          name: 'delivery-job',
          setup(ctx) {
            job = ctx.task('send', () => ctx.send(target, 'test'), { retry: { maxRetries: 2, delay: 5 } })
          },
        }),
      ],
    })
    const origin = `http://127.0.0.1:${t.app.server?.address()?.port}`
    const timeout = { code: 'DELIVERY_TIMEOUT' as const, outcome: 'unknown', target }
    let issue: 'DELIVERY_TIMEOUT' | 'RATE_LIMITED' | undefined = timeout.code
    t.mock.bot.sendGroup = async () => {
      sends += 1
      if (issue) throw new DeliveryError(target, { code: issue })
      return { messageId: 'confirmed' }
    }
    try {
      const response = await fetch(`${origin}/api/v1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer send-api-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, message: 'test' }),
      })
      expect(response.status).toBe(504)
      expect(await response.json()).toMatchObject({ error: timeout })
      const login = await fetch(`${origin}/api/panel/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'task-panel-secret' }),
      })
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      if (!cookie) throw new Error('Panel login failed')
      const panel = (path: string, method = 'GET') =>
        fetch(`${origin}/api/panel${path}`, {
          method,
          headers: { cookie, 'Content-Type': 'application/json' },
        })
      const key = job.schedule(null, { delay: 0, key: 'timed-out' })
      await vi.waitFor(() =>
        expect(job.get(key)).toMatchObject({ state: 'failed', attempt: 1, canRetry: true }),
      )
      const task = `/tasks/${job.get(key)?.id}`
      expect(await (await panel(task)).json()).toMatchObject({ deliveryFailure: timeout, canRetry: true })
      expect(await (await panel(`${task}/attempts`)).json()).toMatchObject([{ deliveryFailure: timeout }])
      expect((await panel(`${task}/retry`, 'POST')).status).toBe(409)
      expect(sends).toBe(2)
      issue = undefined
      expect((await panel(`${task}/retry?confirmDelivery=1`, 'POST')).status).toBe(200)
      await vi.waitFor(() => expect(job.get('timed-out')).toMatchObject({ state: 'succeeded', attempt: 2 }))
      expect(job.attempts('timed-out')[1]?.deliveryFailure).toMatchObject(timeout)
      issue = 'RATE_LIMITED'
      job.schedule(null, { delay: 0, key: 'limited' })
      await vi.waitFor(() => expect(job.get('limited')).toMatchObject({ state: 'failed', attempt: 3 }))
      expect(job.get('limited')?.deliveryFailure).toMatchObject({ code: 'RATE_LIMITED', outcome: 'not_sent' })
      expect(sends).toBe(6)
    } finally {
      await t.dispose()
    }
  })

  it('authenticates, filters, redacts, pushes changes and validates actions', async () => {
    let task!: TaskHandle<unknown>
    let fail = true
    const t = await createTestApp({
      config: { server: { port: 0, panelPassword: 'task-panel-secret' } },
      plugins: [
        definePlugin({
          name: 'jobs',
          setup(ctx) {
            task = ctx.task('job', () => {
              if (fail) throw new Error('appSecret=hidden failure')
            })
          },
        }),
      ],
    })
    const origin = `http://127.0.0.1:${t.app.server?.address()?.port}`
    let socket: WebSocket | undefined
    try {
      expect((await fetch(`${origin}/api/panel/tasks`)).status).toBe(401)
      const login = await fetch(`${origin}/api/panel/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'task-panel-secret' }),
      })
      const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
      const request = (path: string, method = 'GET', headers = {}) =>
        fetch(`${origin}/api/panel${path}`, {
          method,
          headers: { cookie, 'content-type': 'application/json', ...headers },
        })
      socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/panel/ws`, { headers: { cookie } })
      const frames: unknown[] = []
      socket.on('message', (data) => frames.push(JSON.parse(data.toString())))
      await once(socket, 'open')
      task.schedule(
        {
          token: 'nested-token',
          apiKey: 'api-key-value',
          nested: { appSecret: 'nested-secret', text: 'password=secret' },
        },
        { delay: 0, key: 'fail' },
      )
      task.schedule({}, { delay: '1d', key: 'later' })
      await vi.waitFor(() => expect(task.get('fail')?.state).toBe('failed'))
      expect(frames).toContainEqual(expect.objectContaining({ type: 'task' }))
      const result = await (await request('/tasks?state=failed&plugin=jobs&limit=1')).json()
      expect(result.total).toBe(1)
      expect(result.items[0]).toMatchObject({
        payload: {
          token: '[Redacted]',
          apiKey: '[Redacted]',
          nested: { appSecret: '[Redacted]', text: 'password=[Redacted]' },
        },
        error: 'appSecret=[Redacted] failure',
      })
      expect((await request('/tasks?limit=1000')).status).toBe(400)
      expect((await request('/tasks?state=invalid')).status).toBe(400)
      expect((await request('/tasks/missing')).status).toBe(404)
      const id = result.items[0].id
      expect((await (await request(`/tasks/${id}/attempts`)).json())[0].outcome).toBe('failed')
      expect((await request(`/tasks/${id}/retry`, 'POST', { origin: 'https://evil.example' })).status).toBe(
        403,
      )
      fail = false
      expect((await request(`/tasks/${id}/retry`, 'POST')).status).toBe(200)
      await vi.waitFor(() => expect(task.get('fail')?.state).toBe('succeeded'))
      expect((await request(`/tasks/${id}/retry`, 'POST')).status).toBe(409)
      const later = task.get('later')?.id
      expect((await request(`/tasks/${later}/cancel`, 'POST')).status).toBe(200)
      expect(task.get('later')?.state).toBe('cancelled')
    } finally {
      socket?.terminate()
      await t.dispose()
    }
  })
})
