import { describe, expect, it } from 'vitest'
import { normalizeSendable, seg } from '../../core/message/index.ts'
import { normalizeOutbound } from './api.ts'
import { parseCQ, toCQ } from './cq.ts'
import { incomingMessage } from './message.ts'

describe('OneBot message conversion', () => {
  it('round trips escaped text, parameters and unknown segments', () => {
    const message = [seg.text('a&b[c],x'), { type: 'mystery', data: { value: 'a&b[c],x' } }]
    const cq = toCQ(message)
    expect(cq).toBe('a&amp;b&#91;c&#93;,x[CQ:mystery,value=a&amp;b&#91;c&#93;&#44;x]')
    expect(toCQ(parseCQ(cq))).toBe(cq)
    expect(parseCQ(cq)).toEqual(message)
    expect(normalizeSendable('[CQ:at,qq=123]literal')).toEqual([seg.text('[CQ:at,qq=123]literal')])
    expect(parseCQ('&#44; [CQ:unknown,value=&#44;]')).toEqual([
      seg.text('&#44; '),
      { type: 'unknown', data: { value: ',' } },
    ])
  })

  it('translates mentions and audio, preserves platform fields and unknown segments', async () => {
    const protocol = [
      { type: 'at', data: { qq: 123 } },
      { type: 'record', data: { file: 'base64://AA==' } },
      { type: 'image', data: { file: 'https://example.invalid/i', sub_type: 1 } },
      { type: 'json', data: { data: '{}' } },
    ]
    const message = incomingMessage(protocol)
    expect(message).toEqual([
      seg.at('123'),
      seg.audio('base64://AA=='),
      { type: 'image', data: { file: 'https://example.invalid/i', sub_type: 1 } },
      { type: 'json', data: { data: '{}' } },
    ])
    expect(await normalizeOutbound(message)).toEqual(protocol)
    expect(parseCQ('[CQ:at,qq=123][CQ:record,file=base64://AA==]')).toEqual(message.slice(0, 2))
    expect(toCQ(message.slice(0, 2))).toBe('[CQ:at,qq=123][CQ:record,file=base64://AA==]')
    await expect(normalizeOutbound(seg.at('not-a-number'))).rejects.toThrow(/safe integer/)
    await expect(normalizeOutbound(seg.at('9007199254740992'))).rejects.toThrow(/safe integer/)
    // Forward ids are opaque resource ids, not numbers.
    await expect(normalizeOutbound(seg.forward('resource-id'))).resolves.toEqual([
      { type: 'forward', data: { id: 'resource-id' } },
    ])
  })
})
