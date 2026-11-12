import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripLeadingMention } from '../event/index.ts'
import { isSegment, seg } from './index.ts'

describe('media sources', () => {
  const cases: [string, string | Buffer | URL, string][] = [
    ['buffer', Buffer.from('cat'), 'base64://Y2F0'],
    ['URL', new URL('https://example.com/cat.png'), 'https://example.com/cat.png'],
    ['file URL object', new URL('file:///tmp/cat.png'), 'file:///tmp/cat.png'],
    ['http', 'http://example.com/a', 'http://example.com/a'],
    ['https', 'https://example.com/a', 'https://example.com/a'],
    ['base64', 'base64://abc', 'base64://abc'],
    ['file URL', 'file:///tmp/cat.png', 'file:///tmp/cat.png'],
    ['POSIX path', '/tmp/cat.png', pathToFileURL('/tmp/cat.png').href],
    ['Windows path', 'C:\\cats\\a b.png', 'file:///C:/cats/a%20b.png'],
    ['Windows slash path', 'C:/cats/a b.png', 'file:///C:/cats/a%20b.png'],
    ['UNC path', '\\\\server\\share\\cat.png', 'file://server/share/cat.png'],
    ['platform id', 'resource-id.png', 'resource-id.png'],
  ]
  it.each(cases)('uses %s consistently for all media', (_label, source, expected) => {
    for (const media of [seg.image, seg.audio, seg.video, seg.file])
      expect(media(source).data.file).toBe(expected)
  })
  it.each(['./cat.png', '../cat.png'])('rejects process-relative paths: %s', (source) => {
    for (const media of [seg.image, seg.audio, seg.video, seg.file])
      expect(() => media(source)).toThrow(/import\.meta\.url/)
  })
  it('supports narrowing known types alongside unknown segments', () => {
    const message: import('./index.ts').Message = [seg.image('resource'), { type: 'custom', data: {} }]
    expect(message.filter((item) => isSegment(item, 'image')).map((item) => item.data.file)).toEqual([
      'resource',
    ])
  })
})

describe('stripLeadingMention', () => {
  it('strips a leading reply, whitespace, and self mention', () => {
    expect(
      stripLeadingMention([seg.reply('10'), seg.text('  '), seg.at('42'), seg.text(' hello')], '42'),
    ).toEqual([seg.text('hello')])
  })

  it('does not strip another user mention or non-leading mentions', () => {
    const message = [seg.at('7'), seg.text(' hi'), seg.at('42')]
    expect(stripLeadingMention(message, '42')).toEqual(message)
  })

  it('supports a message with only a reply and mention', () => {
    expect(stripLeadingMention([seg.reply('10'), seg.at('42')], '42')).toEqual([])
  })
})
