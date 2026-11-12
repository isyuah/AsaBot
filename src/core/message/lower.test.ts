import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { FakeBot } from '../../testing/fake-bot.ts'
import { UnsupportedError } from '../errors.ts'
import { lowerMessage } from './lower.ts'
import { seg } from './segment.ts'
import type { Message } from './types.ts'

describe('message lowering', () => {
  it('applies the fallback table and merges adjacent text', () => {
    const bot = new FakeBot()
    const logger = pino({ level: 'silent' })
    const warn = vi.spyOn(logger, 'warn')
    const cases: [Message, Message][] = [
      [[seg.text('a', ['bold', 'italic'])], [seg.text('a')]],
      [
        [seg.markdown('# 标题\n- **粗体** `code` [链接](https://x)')],
        [seg.text('标题\n粗体 code 链接 (https://x)')],
      ],
      [[seg.markdown('```ts\nconst x = 1\n```')], [seg.text('const x = 1\n')]],
      [[seg.markdown('```md\n# **保留**\n```')], [seg.text('# **保留**\n')]],
      [[seg.markdown('`**原样**`')], [seg.text('**原样**')]],
      [[seg.button('网站', { link: 'https://x' })], [seg.text('网站: https://x')]],
      [[seg.button('运行', { command: '/go' })], [seg.text('运行：发送 /go')]],
      [[seg.at('123')], [seg.text('@123')]],
      [[seg.face('1')], [seg.text('[表情]')]],
      [[seg.image('id')], [seg.text('[图片]')]],
      [[seg.audio('id')], [seg.text('[语音]')]],
      [[seg.video('id')], [seg.text('[视频]')]],
      [[seg.file('id', { name: 'a.txt' })], [seg.text('[文件 a.txt]')]],
      [[seg.forward('1')], [seg.text('[合并转发]')]],
      [[seg.text('a'), seg.reply('1'), { type: 'other:custom', data: {} }, seg.text('b')], [seg.text('ab')]],
      [[seg.text('a'), { type: 'custom', data: {} }, seg.image('id')], [seg.text('a[图片]')]],
    ]
    for (const [message, expected] of cases) expect(lowerMessage(bot, message, logger)).toEqual(expected)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ segment: 'custom' }), expect.any(String))
    expect(() => lowerMessage(bot, [seg.reply('1')], logger)).toThrow(UnsupportedError)
    Object.defineProperty(bot, 'capabilities', {
      value: {
        segments: ['text', 'markdown', 'fake:*'],
        textStyles: ['bold'],
        actions: [],
      },
    })
    expect(
      lowerMessage(
        bot,
        [seg.text('styled', ['bold', 'italic']), seg.markdown('**native**'), { type: 'fake:json', data: {} }],
        logger,
      ),
    ).toEqual([seg.text('styled', ['bold']), seg.markdown('**native**'), { type: 'fake:json', data: {} }])
  })
})
