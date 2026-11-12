import { describe, expect, it, vi } from 'vitest'
import { dispatchFixture } from '../../testing/dispatch-fixture.ts'
import { plainText, seg } from '../message/index.ts'

describe('command enhancements', () => {
  it('validates enumerations and argument and option constraints', async () => {
    const { app, bot, say } = dispatchFixture()
    app.dispatcher
      .command({ owner: 'test' }, 'set <mode:on|off> <count:posint> <label>')
      .arg('count', { min: 2, max: 4, description: '数量' })
      .arg('label', { pattern: /^[a-z]+$/, validate: (value) => value !== 'bad' || '不能使用 bad' })
      .option('mode', '--mode <mode:on|off>')
      .option('limit', '--limit <limit:natural>', { min: 1, max: 9 })
      .action(
        ({ args, options }) => `${args.mode}:${args.count}:${args.label}:${options.mode}:${options.limit}`,
      )
    expect(() => app.dispatcher.command({ owner: 'test' }, 'another').arg('missing' as never, {})).toThrow(
      '未声明的参数',
    )
    await say('/set maybe 2 ok')
    await say('/set on 0 ok')
    await say('/set on 1 ok')
    await say('/set on 5 ok')
    await say('/set on 2 123')
    await say('/set on 2 bad')
    await say('/set on 2 ok --mode maybe')
    await say('/set on 2 ok --limit 0')
    await say('/set on 2 ok --mode off --limit 9')
    const replies = bot.sends.map((item) => plainText(item.message))
    expect(replies[0]).toContain('on、off')
    expect(replies[1]).toContain('正整数')
    expect(replies[2]).toContain('不小于 2')
    expect(replies[3]).toContain('不大于 4')
    expect(replies[4]).toContain('符合指定格式')
    expect(replies[5]).toContain('不能使用 bad')
    expect(replies[6]).toContain('on、off')
    expect(replies[7]).toContain('不小于 1')
    expect(replies[8]).toBe('on:2:ok:off:9')
    app.dispatcher.command({ owner: 'test' }, 'language <value:中文|英文>').action(({ args }) => args.value)
    await say('/language 英文')
    await say('/language 法文')
    expect(plainText(bot.sends.at(-2)?.message ?? [])).toBe('英文')
    expect(plainText(bot.sends.at(-1)?.message ?? [])).toContain('中文、英文')
  })

  it('parses dates in the configured timezone and fills omitted fields from that timezone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T17:00:00Z'))
    try {
      const { app, say } = dispatchFixture({ timezone: 'Asia/Shanghai' })
      const values: Date[] = []
      app.dispatcher.command({ owner: 'test' }, 'date <value:date>').action(({ args }) => {
        values.push(args.value)
      })
      await say('/date 2026-04-30 12:30')
      await say('/date 2026-04-30')
      await say('/date 02-04')
      await say('/date 08:15')
      expect(values.map((value) => value.toISOString())).toEqual([
        '2026-04-30T04:30:00.000Z',
        '2026-04-29T16:00:00.000Z',
        '2026-02-03T16:00:00.000Z',
        '2026-01-03T00:15:00.000Z',
      ])
      const eastern = dispatchFixture({ timezone: 'America/New_York' })
      const dates: Date[] = []
      eastern.app.dispatcher.command({ owner: 'test' }, 'date <value:date>').action(({ args }) => {
        dates.push(args.value)
      })
      await eastern.say('/date 2026-03-08 03:30')
      await eastern.say('/date 2026-03-08 02:30')
      expect(dates.map((value) => value.toISOString())).toEqual(['2026-03-08T07:30:00.000Z'])
      expect(plainText(eastern.bot.sends[0]?.message ?? [])).toContain('有效日期')
      const historic = dispatchFixture({ timezone: 'UTC' })
      const years: Date[] = []
      historic.app.dispatcher.command({ owner: 'test' }, 'date <value:date>').action(({ args }) => {
        years.push(args.value)
      })
      await historic.say('/date 0099-01-01')
      await historic.say('/date 0000-01-01')
      expect(years.map((value) => value.toISOString())).toEqual([
        '0099-01-01T00:00:00.000Z',
        '0000-01-01T00:00:00.000Z',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes regular expression capture groups to match handlers', async () => {
    const { app, say } = dispatchFixture()
    let captured: string | undefined
    app.dispatcher.match({ owner: 'test' }, /hello (\w+)/g, ({ match, session, signal }) => {
      captured = `${match?.[1]}:${session.text}:${signal.aborted}`
    })
    await say('hello Ada')
    expect(captured).toBe('Ada:hello Ada:false')
  })

  it.each(['off', 'direct', 'always'] as const)('applies suggest mode %s', async (mode) => {
    const { app, bot, say } = dispatchFixture({ command: { suggest: mode } })
    app.dispatcher.command({ owner: 'test' }, 'hello').action(() => 'hello')
    await say('/hell', { group: null })
    await say('/hell')
    await say([seg.at('10000'), seg.text(' /hell')])
    const replies = bot.sends.map((item) => plainText(item.message))
    expect(replies).toEqual(
      Array.from(
        { length: mode === 'off' ? 0 : mode === 'direct' ? 2 : 3 },
        () => '没有这个命令，你是不是想用 /hello？',
      ),
    )
    app.dispatcher.match({ owner: 'test' }, '/hell', () => undefined, { block: false })
    await say('/hell', { group: null })
    expect(bot.sends).toHaveLength(replies.length)
  })
})
