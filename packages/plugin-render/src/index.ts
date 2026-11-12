import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { definePlugin, z } from '@asabot/core'
import { Resvg } from '@resvg/resvg-js'
import satori, { type Font } from 'satori'
import { html as parseHtml } from 'satori-html'
import { BrowserRenderer } from './browser.ts'
import { markdownNode, textNode } from './markdown.ts'

export type RenderChild = RenderNode | string | number | boolean | null | undefined | RenderChild[]

export interface RenderNode {
  type: string
  props: { children?: RenderChild; [key: string]: unknown }
}

export interface RenderOptions {
  width?: number
  height?: number
  scale?: number
}

export interface ThemedRenderOptions extends RenderOptions {
  theme?: 'light' | 'dark'
}

export interface PageOptions {
  width?: number
  selector?: string
  timeout?: number | string
}

export interface RenderService {
  element(node: RenderNode, options?: RenderOptions): Promise<Buffer>
  html(html: string, options?: RenderOptions): Promise<Buffer>
  markdown(markdown: string, options?: ThemedRenderOptions): Promise<Buffer>
  text(text: string, options?: ThemedRenderOptions): Promise<Buffer>
  page(input: { html: string } | { url: string }, options?: PageOptions): Promise<Buffer>
}

declare module '@asabot/core' {
  interface Services {
    render: RenderService
  }
}

const defaultFontDir = fileURLToPath(new URL('../fonts/', import.meta.url))
const emptyEmoji = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"></svg>').toString('base64')}`

export default definePlugin({
  name: 'render',
  description: '将文本、Markdown、HTML 和网页渲染为 PNG',
  inject: { optional: ['http'] },
  config: z.object({
    fontDir: z.string().default(defaultFontDir),
    fonts: z.array(z.string()).default([]),
    emoji: z.enum(['twemoji', 'none']).default('twemoji'),
    emojiBaseUrl: z.string().default('https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg'),
    browser: z
      .object({
        executablePath: z.string().min(1).optional(),
        wsEndpoint: z.string().min(1).optional(),
        concurrency: z.number().int().positive().default(2),
      })
      .default({ concurrency: 2 }),
  }),
  setup(ctx) {
    const http = ctx.injectOptional('http')
    const logger = ctx.logger
    const signal = ctx.signal
    const browser = new BrowserRenderer(ctx.config.browser, logger)
    ctx.onDispose(() => browser.close())
    let fontPromise: Promise<Font[]> | undefined
    const fonts = (): Promise<Font[]> => {
      if (!fontPromise) {
        fontPromise = (async () => {
          const files = (await readdir(ctx.config.fontDir))
            .filter((name) => /-(400|700)-normal\.woff$/.test(name))
            .sort((a, b) => Number(a.includes('-700-')) - Number(b.includes('-700-')) || a.localeCompare(b))
          if (files.length === 0 && ctx.config.fonts.length === 0) throw new Error('No render fonts found')
          const userFonts = await Promise.all(
            ctx.config.fonts.map(
              async (path, index): Promise<Font> => ({
                name: `user-${index}`,
                data: await readFile(path),
                weight: /(?:^|[-_])700(?:[-_.]|$)/.test(path) ? 700 : 400,
                style: 'normal',
              }),
            ),
          )
          const bundledFonts = await Promise.all(
            files.map(
              async (name, index): Promise<Font> => ({
                name: `noto-${index}`,
                data: await readFile(join(ctx.config.fontDir, name)),
                weight: name.endsWith('-700-normal.woff') ? 700 : 400,
                style: 'normal',
              }),
            ),
          )
          return [...userFonts, ...bundledFonts]
        })()
        void fontPromise.catch(() => {
          fontPromise = undefined
        })
      }
      return fontPromise
    }
    const emojiCache = new Map<string, Promise<string>>()
    const emoji = async (language: string, segment: string): Promise<string> => {
      if (language !== 'emoji') return ''
      if (ctx.config.emoji === 'none') return emptyEmoji
      const code = [...segment]
        .map((character) => character.codePointAt(0) as number)
        .filter((point) => point !== 0xfe0f)
        .map((point) => point.toString(16))
        .join('-')
      let work = emojiCache.get(code)
      if (!work) {
        work = (async () => {
          try {
            const directory = join(ctx.dataDir, 'emoji')
            const path = join(directory, `${code}.svg`)
            let data: Buffer
            try {
              data = await readFile(path)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              const url = `${ctx.config.emojiBaseUrl.replace(/\/$/, '')}/${code}.svg`
              if (http) data = await http.buffer(url, { signal })
              else {
                const response = await fetch(url, { signal })
                if (!response.ok) throw new Error(`Emoji HTTP ${response.status}`)
                data = Buffer.from(await response.arrayBuffer())
              }
              await mkdir(directory, { recursive: true })
              await writeFile(path, data)
            }
            return `data:image/svg+xml;base64,${data.toString('base64')}`
          } catch (error) {
            logger.debug({ err: error, emoji: code }, 'Failed to load emoji')
            emojiCache.delete(code)
            return emptyEmoji
          }
        })()
        emojiCache.set(code, work)
      }
      return work
    }
    const element: RenderService['element'] = async (node, options = {}) => {
      const { width = 800, height, scale = 1 } = options
      if (
        !Number.isFinite(width) ||
        width <= 0 ||
        (height !== undefined && (!Number.isFinite(height) || height <= 0)) ||
        !Number.isFinite(scale) ||
        scale <= 0
      ) {
        throw new TypeError('Render dimensions and scale must be positive')
      }
      try {
        const svg = await satori(node as Parameters<typeof satori>[0], {
          width,
          ...(height === undefined ? {} : { height }),
          fonts: await fonts(),
          loadAdditionalAsset: emoji,
        })
        return new Resvg(svg, { font: { loadSystemFonts: false }, fitTo: { mode: 'zoom', value: scale } })
          .render()
          .asPng()
      } catch (error) {
        throw new Error('Failed to render image', { cause: error })
      }
    }
    ctx.provide('render', {
      element,
      html: (html, options) => element(parseHtml(html) as RenderNode, options),
      markdown: (markdown, options) => element(markdownNode(markdown, options?.theme ?? 'light'), options),
      text: (text, options) => element(textNode(text, options?.theme ?? 'light'), options),
      page: (input, options) => browser.page(input, options),
    })
  },
})
