import { type Context, parseDuration, UnsupportedError } from '@asabot/core'
import puppeteer, { type Browser } from 'puppeteer-core'
import type { PageOptions } from './index.ts'

export interface BrowserConfig {
  executablePath?: string
  wsEndpoint?: string
  concurrency: number
}

export class BrowserRenderer {
  private browser?: Promise<Browser>
  private idle?: NodeJS.Timeout
  private active = 0
  private stopped = false
  private readonly waiting: { resolve: () => void; reject: (error: Error) => void }[] = []
  private readonly config: BrowserConfig
  private readonly logger: Pick<Context['logger'], 'debug'>

  constructor(config: BrowserConfig, logger: Pick<Context['logger'], 'debug'>) {
    this.config = config
    this.logger = logger
  }

  async page(input: { html: string } | { url: string }, options: PageOptions = {}): Promise<Buffer> {
    if (!this.config.wsEndpoint && !this.config.executablePath) throw new UnsupportedError('render', 'page')
    if ('url' in input && !['http:', 'https:'].includes(new URL(input.url).protocol)) {
      throw new TypeError('Page URL must use http or https')
    }
    const timeout = parseDuration(options.timeout ?? 30_000)
    await this.acquire()
    try {
      const browser = await this.getBrowser()
      const page = await browser.newPage()
      try {
        await page.setViewport({ width: options.width ?? 800, height: 600, deviceScaleFactor: 1 })
        if ('html' in input) await page.setContent(input.html, { waitUntil: 'load', timeout })
        else await page.goto(input.url, { waitUntil: 'load', timeout })
        if (options.selector) {
          const element = await page.waitForSelector(options.selector, { timeout })
          if (!element) throw new Error(`Selector not found: ${options.selector}`)
          return Buffer.from(await element.screenshot({ type: 'png' }))
        }
        return Buffer.from(await page.screenshot({ type: 'png', fullPage: true }))
      } finally {
        await page.close()
      }
    } finally {
      this.release()
    }
  }

  async close(): Promise<void> {
    this.stopped = true
    if (this.idle) clearTimeout(this.idle)
    for (const waiter of this.waiting.splice(0)) waiter.reject(new Error('Render plugin unloaded'))
    const pending = this.browser
    this.browser = undefined
    if (pending) await (await pending).close()
  }

  private async acquire(): Promise<void> {
    if (this.stopped) throw new Error('Render plugin unloaded')
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
    if (this.active < this.config.concurrency) {
      this.active++
      return
    }
    await new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) {
      next.resolve()
      return
    }
    this.active--
    if (this.active === 0 && !this.stopped) {
      this.idle = setTimeout(() => {
        const pending = this.browser
        this.browser = undefined
        if (pending)
          void pending
            .then((browser) => browser.close())
            .catch((error: unknown) => {
              this.logger.debug({ err: error }, 'Failed to close idle render browser')
            })
      }, 300_000)
      this.idle.unref()
    }
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const promise = this.config.wsEndpoint
        ? puppeteer.connect({ browserWSEndpoint: this.config.wsEndpoint })
        : puppeteer.launch({ executablePath: this.config.executablePath })
      this.browser = promise
      void promise.catch(() => {
        if (this.browser === promise) this.browser = undefined
      })
    }
    return this.browser
  }
}
