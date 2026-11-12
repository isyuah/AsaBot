import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { definePlugin, type HttpService } from '@asabot/core'
import { createTestApp } from '@asabot/core/testing'
import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it } from 'vitest'
import renderPlugin, { type RenderService } from './index.ts'

const require = createRequire(import.meta.url)
const fontDir = join(dirname(require.resolve('@fontsource/noto-sans-sc/package.json')), 'files')
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function expectPng(buffer: Buffer, width: number): void {
  expect(buffer.subarray(0, 8)).toEqual(pngSignature)
  expect(buffer.toString('ascii', 12, 16)).toBe('IHDR')
  expect(buffer.readUInt32BE(16)).toBe(width)
}

function hasInk(png: Buffer): boolean {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`
  const pixels = new Resvg(svg, { font: { loadSystemFonts: false } }).render().pixels
  for (let index = 0; index < pixels.length; index += 4) {
    if ((pixels[index] ?? 255) < 200 && (pixels[index + 1] ?? 255) < 200 && (pixels[index + 2] ?? 255) < 200)
      return true
  }
  return false
}

describe('render plugin', () => {
  it('renders Chinese text and markdown as PNG and caches emoji from the injected HTTP service', async () => {
    const downloads: string[] = []
    const fakeHttp: HttpService = {
      async fetch() {
        throw new Error('Unexpected fetch')
      },
      async json() {
        throw new Error('Unexpected json')
      },
      async text() {
        throw new Error('Unexpected text')
      },
      async buffer(url) {
        downloads.push(String(url))
        if (!String(url).endsWith('/1f600.svg')) throw new Error('offline')
        return Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#ffcc00"/></svg>',
        )
      },
    }
    const t = await createTestApp({
      config: { plugins: { http: { enabled: false }, render: { config: { fontDir } } } },
      plugins: [
        definePlugin({
          name: 'fake-http',
          setup(ctx) {
            ctx.provide('http', fakeHttp)
          },
        }),
        renderPlugin,
      ],
    })
    try {
      let service = t.app.plugins.inject('render') as RenderService
      const text = await service.text('中文渲染测试', { width: 320 })
      expectPng(text, 320)
      expect(hasInk(text)).toBe(true)
      const markdown = await service.markdown(
        '# 中英文标题\n\nHello **世界**\n\n1. 第一项\n2. second\n\n```ts\nconst x = 1\n```\n\n| A | B |\n|---|---|\n| 一 | 二 |',
        { width: 360, scale: 2 },
      )
      expectPng(markdown, 720)
      await service.text('😀', { width: 200 })
      await service.text('😀', { width: 200 })
      expect(downloads).toEqual([expect.stringMatching(/\/1f600\.svg$/)])
      const missingEmoji = await service.text('☺️', { width: 200 })
      expect(hasInk(missingEmoji)).toBe(false)
      expect(downloads[1]).toMatch(/\/263a\.svg$/)
      await t.app.plugins.reload('render')
      service = t.app.plugins.inject('render') as RenderService
      await service.text('😀', { width: 200 })
      expect(downloads).toHaveLength(2)
    } finally {
      await t.dispose()
    }
  }, 30_000)
})
