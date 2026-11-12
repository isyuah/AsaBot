import { once } from 'node:events'
import { createServer, get, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { HttpError, type HttpService } from '../src/index.ts'
import { createTestApp } from '../src/testing/index.ts'

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('http plugin', () => {
  it('enforces timeout and streamed size, sanitizes errors, and uses the configured proxy', async () => {
    const origin = createServer((req, res) => {
      if (req.url === '/slow') {
        const timer = setTimeout(() => res.end('late'), 300)
        timer.unref()
      } else if (req.url?.startsWith('/failure')) {
        res.writeHead(403).end('no')
      } else if (req.url === '/large') {
        res.writeHead(200)
        res.write('123456')
        res.end('789012')
      } else res.end('through server')
    })
    const requests: string[] = []
    const proxy = createServer((req, res) => {
      requests.push(req.url as string)
      get(req.url as string, (upstream) => {
        res.writeHead(upstream.statusCode ?? 500, upstream.headers)
        upstream.pipe(res)
      }).on('error', (error) => res.destroy(error))
    })
    const originUrl = await listen(origin)
    const proxyUrl = await listen(proxy)
    const t = await createTestApp({ config: { plugins: { http: { config: { proxy: proxyUrl } } } } })
    const http = t.app.plugins.inject('http') as HttpService
    try {
      await expect(http.text(`${originUrl}/slow`, { timeout: 30, proxy: false })).rejects.toThrow()
      const cancelled = new AbortController()
      cancelled.abort(new Error('caller cancelled'))
      await expect(
        http.text(`${originUrl}/direct`, { signal: cancelled.signal, proxy: false }),
      ).rejects.toThrow('caller cancelled')
      try {
        await http.text(`${originUrl}/failure?token=secret`, { proxy: false })
        throw new Error('Expected HttpError')
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError)
        expect(error).toMatchObject({ status: 403, url: `${originUrl}/failure` })
        expect(String(error)).not.toContain('secret')
      }
      await expect(http.buffer(`${originUrl}/large`, { maxSize: 8, proxy: false })).rejects.toThrow('maxSize')
      expect(await http.text(`${originUrl}/proxied`)).toBe('through server')
      expect(requests).toEqual([`${originUrl}/proxied`])
      expect(await http.text(`${originUrl}/direct`, { proxy: false })).toBe('through server')
      expect(requests).toHaveLength(1)
      await t.app.plugins.updateConfig('http', { proxy: proxyUrl, noProxy: ['127.0.0.1'] })
      const bypass = t.app.plugins.inject('http') as HttpService
      expect(await bypass.text(`${originUrl}/bypass`)).toBe('through server')
      expect(requests).toHaveLength(1)
      await t.app.plugins.updateConfig('http', { proxy: proxyUrl, noProxy: ['*.0.0.1'] })
      const wildcard = t.app.plugins.inject('http') as HttpService
      expect(await wildcard.text(`${originUrl}/wildcard`)).toBe('through server')
      expect(requests).toHaveLength(1)
    } finally {
      await t.dispose()
      origin.closeAllConnections()
      proxy.closeAllConnections()
      await Promise.all([
        new Promise<void>((resolve) => origin.close(() => resolve())),
        new Promise<void>((resolve) => proxy.close(() => resolve())),
      ])
    }
  })
})
