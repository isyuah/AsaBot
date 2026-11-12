import { describe, expect, it } from 'vitest'
import { definePlugin, plainText, seg } from '../src/index.ts'
import { createTestApp } from '../src/testing/index.ts'

describe('long-message plugin', () => {
  it('sends a forward and returns its send result', async () => {
    const t = await createTestApp({
      config: { plugins: { 'long-message': { config: { threshold: 3, chunkSize: 5, splitInterval: 0 } } } },
    })
    try {
      const sent = await t.mock.bot.sendGroup('10', [seg.reply('previous'), seg.text('ab\n\ncd。efghij')])
      expect(sent).toEqual({ messageId: '1' })
      expect(t.mock.bot.sends).toHaveLength(1)
      expect(t.mock.bot.sends[0]?.message).toEqual([seg.forward('1')])
      const nodes = await t.mock.bot.getForward(sent.messageId)
      expect(nodes.map((item) => plainText(item.message))).toEqual(['ab\n\n', 'cd。', 'efghi', 'j'])
      expect(nodes[0]?.message[0]).toEqual(seg.reply('previous'))
      expect(nodes.slice(1).every((item) => item.message.every((part) => part.type !== 'reply'))).toBe(true)
    } finally {
      await t.dispose()
    }
  })

  it('falls back to ordered splits when forwarding or rendering is unavailable', async () => {
    for (const strategy of ['forward', 'image'] as const) {
      const t = await createTestApp({
        capabilities: { actions: ['sendGroup'] },
        config: {
          plugins: { 'long-message': { config: { threshold: 2, chunkSize: 4, splitInterval: 0, strategy } } },
        },
      })
      try {
        const sent = await t.mock.bot.sendGroup('10', [seg.reply('r'), seg.text('aa。bb。cccccc')])
        expect(sent).toEqual({ messageId: '4' })
        expect(t.mock.bot.sends.map((item) => plainText(item.message))).toEqual([
          'aa。',
          'bb。',
          'cccc',
          'cc',
        ])
        expect(t.mock.bot.sends[0]?.message[0]).toEqual(seg.reply('r'))
        expect(
          t.mock.bot.sends.slice(1).every((item) => item.message.every((part) => part.type !== 'reply')),
        ).toBe(true)
      } finally {
        await t.dispose()
      }
    }
  })

  it('keeps a split delivery that outlasts the hook timeout from also sending the original', async () => {
    const t = await createTestApp({
      capabilities: { actions: ['sendGroup'] },
      config: {
        plugins: {
          'long-message': { config: { threshold: 2, chunkSize: 1, splitInterval: 1600, strategy: 'split' } },
        },
      },
    })
    try {
      const sent = await t.mock.bot.sendGroup('10', 'abc')
      expect(t.mock.bot.sends.map((item) => plainText(item.message))).toEqual(['a', 'b', 'c'])
      expect(sent).toEqual({ messageId: '3' })
    } finally {
      await t.dispose()
    }
  }, 10_000)

  it('passes media through and respects group threshold overrides', async () => {
    const t = await createTestApp({
      config: { plugins: { 'long-message': { config: { threshold: 3, chunkSize: 4, splitInterval: 0 } } } },
    })
    try {
      await t.mock.bot.sendGroup('10', [seg.text('long text'), seg.image('asset')])
      expect(t.mock.bot.sends[0]?.message).toEqual([seg.text('long text'), seg.image('asset')])
      t.app.plugins.setGroupConfig('long-message', 'virtual:10', { threshold: 20 })
      await t.mock.bot.sendGroup('10', 'long text')
      await t.mock.bot.sendGroup('11', 'long text')
      expect(t.mock.bot.sends[1]?.message).toEqual([seg.text('long text')])
      expect(t.mock.bot.sends[2]?.message[0]?.type).toBe('forward')
    } finally {
      await t.dispose()
    }
  })

  it('renders image strategy and unsupported markdown when the render service is available', async () => {
    const render = {
      element: async () => Buffer.from('element'),
      html: async () => Buffer.from('html'),
      markdown: async (text: string) => Buffer.from(`markdown:${text}`),
      text: async (text: string) => Buffer.from(`text:${text}`),
      page: async () => Buffer.from('page'),
    }
    const t = await createTestApp({
      capabilities: { segments: ['text', 'image', 'reply'] },
      config: { plugins: { 'long-message': { config: { threshold: 4, strategy: 'image' } } } },
      plugins: [
        definePlugin({
          name: 'fake-render',
          setup(ctx) {
            ctx.provide('render', render)
          },
        }),
      ],
    })
    try {
      await t.mock.bot.sendGroup('10', [seg.reply('r'), seg.text('long text')])
      expect(t.mock.bot.sends[0]?.message).toEqual([seg.reply('r'), seg.image(Buffer.from('text:long text'))])
      await t.mock.bot.sendGroup('10', seg.markdown('**hello**'))
      expect(t.mock.bot.sends[1]?.message).toEqual([seg.image(Buffer.from('markdown:**hello**'))])
      await t.mock.bot.sendGroup('10', seg.markdown('hi'))
      expect(t.mock.bot.sends[2]?.message).toEqual([seg.image(Buffer.from('markdown:hi'))])
    } finally {
      await t.dispose()
    }
  })
})
