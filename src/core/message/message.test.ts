import { describe, expect, it } from 'vitest'
import { stripLeadingMention } from '../event/index.ts'
import { normalizeSendable, parseCQ, seg, toCQ } from './index.ts'

describe('CQ message conversion', () => {
  it('round trips escaped text, parameters, and unknown segments', () => {
    const source = 'a&b[c],x'
    const message = [seg.text(source), { type: 'mystery', data: { value: 'a&b[c],x' } }]
    const cq = toCQ(message)
    expect(cq).toBe('a&amp;b&#91;c&#93;,x[CQ:mystery,value=a&amp;b&#91;c&#93;&#44;x]')
    expect(toCQ(parseCQ(cq))).toBe(cq)
    expect(parseCQ(cq)).toEqual(message)
  })

  it('keeps plain strings as text when normalizing sendables', () => {
    expect(normalizeSendable('[CQ:at,qq=123]literal')).toEqual([seg.text('[CQ:at,qq=123]literal')])
    expect(parseCQ('&#44; [CQ:unknown,value=&#44;]')).toEqual([
      seg.text('&#44; '),
      { type: 'unknown', data: { value: ',' } },
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
