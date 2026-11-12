import { describe, expect, it } from 'vitest'
import { stripLeadingMention } from '../event/index.ts'
import { seg } from './index.ts'

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
