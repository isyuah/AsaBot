import { describe, expect, it, vi } from 'vitest'
import { dispatchFixture } from '../../testing/dispatch-fixture.ts'
import { CommandConflictError } from '../errors.ts'
import { plainText, seg } from '../message/index.ts'
import { perm } from '../permission.ts'
import { formatUsage } from './parse.ts'

const scope = { owner: 'example' }
const sent = (bot: ReturnType<typeof dispatchFixture>['bot']) =>
  bot.sends.map((item) => plainText(item.message))

describe('commands', () => {
  it('supports prefixes, mentions and private messages, and ignores other group messages', async () => {
    const { app, bot, say } = dispatchFixture()
    app.dispatcher.command(scope, 'echo <text:rest>').action(({ args }) => args.text)
    await say('/echo prefix')
    await say([seg.reply('2'), seg.at('10000'), seg.text(' echo mention')])
    await say('echo private', { group: null })
    await say('echo ignored')
    await say('/unknown')
    expect(sent(bot)).toEqual(['prefix', 'mention', 'private'])
    const strict = dispatchFixture({ command: { mentionAsPrefix: false, privateRequirePrefix: true } })
    strict.app.dispatcher.command(scope, 'echo').action(() => 'ok')
    await strict.say([seg.at('10000'), seg.text(' echo')])
    await strict.say('echo', { group: null })
    await strict.say('/echo', { group: null })
    expect(sent(strict.bot)).toEqual(['ok'])
  })

  it('rejects invalid declarations and reports conflicts with both owners', () => {
    const { app } = dispatchFixture()
    expect(() => app.dispatcher.command(scope, 'echo <x:rest> <y>')).toThrow(/rest.*最后/)
    expect(() => app.dispatcher.command(scope, 'echo <x:wat>')).toThrow(/类型未知.*wat/)
    expect(() => app.dispatcher.command(scope, 'echo <x=1>')).toThrow(/必填参数/)
    app.dispatcher.command({ owner: 'one' }, 'plugin reload <name>').alias('重载插件')
    expect(() => app.dispatcher.command({ owner: 'two' }, 'plugin reload')).toThrow(CommandConflictError)
    expect(() => app.dispatcher.command({ owner: 'two' }, '重载插件')).toThrow(/one.*two/)
    const other = app.dispatcher.command({ owner: 'two' }, 'other')
    expect(() => other.alias('重载插件')).toThrow(/重载插件.*one.*two/)
    other.dispose()
    app.dispatcher.command({ owner: 'three' }, 'other')
  })

  it('parses quoted text, user mentions, images and all supported scalar types', async () => {
    const { app, say } = dispatchFixture()
    let value: unknown
    app.dispatcher
      .command(scope, 'parse <text> <user:user> <n:number> <i:integer> <b:boolean> <d:duration> <img:image>')
      .action(({ args }) => {
        value = args
      })
    const image = seg.image('https://example.invalid/image.png')
    await say([seg.text('/parse "hello world" '), seg.at('123'), seg.text(' 1.5 -2 true 1m30s '), image])
    expect(value).toEqual({ text: 'hello world', user: '123', n: 1.5, i: -2, b: true, d: 90000, img: image })
    await say("/parse 'hello there' 123 2 3 false 1s", { group: null })
  })

  it('validates option defaults and applies optional parameter defaults', async () => {
    const { app, say } = dispatchFixture()
    expect(() =>
      app.dispatcher.command(scope, 'bad').option('user', '-u <who:user>', { default: 'abc' }),
    ).toThrow(/默认值/)
    let parsed: unknown
    app.dispatcher.command(scope, 'defaults [count:integer=2] [name]').action(({ args }) => {
      parsed = args
    })
    await say('/defaults')
    expect(parsed).toEqual({ count: 2, name: undefined })
    app.dispatcher.command(scope, 'optional [n:integer=1] <text:rest>').action(({ args }) => {
      parsed = args
    })
    await say('/optional only')
    expect(parsed).toEqual({ n: 1, text: [seg.text('only')] })
    await say('/optional 3 some text')
    expect(parsed).toEqual({ n: 3, text: [seg.text('some text')] })
  })

  it('reports missing, invalid, unclosed quotes and unknown options with usage', async () => {
    const { app, bot, say } = dispatchFixture()
    app.dispatcher.command(scope, 'calc <n:integer>').action(() => 'unexpected')
    await say('/calc')
    await say('/calc nope')
    await say('/calc "1')
    await say('/calc --bad')
    await say([seg.text('/calc '), seg.at('123')])
    expect(sent(bot)).toEqual([
      '缺少参数 <n>。用法：/calc <n>',
      '参数 <n> 应为整数。用法：/calc <n>',
      '引号未闭合。用法：/calc <n>',
      '未知选项 --bad。用法：/calc <n>',
      '参数 <n> 应为整数。用法：/calc <n>',
    ])
  })

  it('rejects malformed image segments at the command input boundary', async () => {
    const { app, bot, say } = dispatchFixture()
    app.dispatcher.command(scope, 'image <img:image>').action(() => 'unexpected')
    await say([seg.text('/image '), { type: 'image', data: {} }])
    expect(sent(bot)).toEqual(['参数 <img> 应为图片。用法：/image <img>'])
  })

  it('uses the configured prefix in parameter errors', async () => {
    const { app, bot, say } = dispatchFixture({ command: { prefixes: ['!'] } })
    app.dispatcher.command(scope, 'calc <n:integer>').action(() => 'unexpected')
    await say('!calc')
    expect(sent(bot)).toEqual(['缺少参数 <n>。用法：!calc <n>'])
  })

  it('handles options among arguments, equals, -- and literal rest with non-text segments', async () => {
    const { app, bot, say } = dispatchFixture()
    const values: unknown[] = []
    app.dispatcher
      .command(scope, 'mix <first> <last>')
      .option('times', '-n, --times <n:integer>', { default: 1 })
      .option('silent', '-s, --silent')
      .action(({ args, options }) => {
        values.push({ args, options })
      })
    await say('/mix one --times 3 two -s')
    await say('/mix -n 4 one --silent two')
    await say('/mix --times=5 one two')
    await say('/mix one -- --silent')
    expect(values).toEqual([
      { args: { first: 'one', last: 'two' }, options: { times: 3, silent: true } },
      { args: { first: 'one', last: 'two' }, options: { times: 4, silent: true } },
      { args: { first: 'one', last: 'two' }, options: { times: 5, silent: false } },
      { args: { first: 'one', last: '--silent' }, options: { times: 1, silent: false } },
    ])
    app.dispatcher
      .command(scope, 'echo <text:rest>')
      .option('silent', '-s, --silent')
      .action(({ args }) => args.text)
    const image = seg.image('https://example.invalid/i.png')
    await say([seg.text('/echo -s hello  '), seg.at('123'), seg.text(' --literal "raw" '), image])
    expect(bot.sends.at(-1)?.message).toEqual([
      seg.text('hello  '),
      seg.at('123'),
      seg.text(' --literal "raw" '),
      image,
    ])
    await say('/echo -- --silent literal')
    expect(bot.sends.at(-1)?.message).toEqual([seg.text('--silent literal')])
  })

  it('chooses the longest path, resolves aliases, lists children, and passes unknown commands to matchers', async () => {
    const { app, bot, say } = dispatchFixture()
    const matches: string[] = []
    app.dispatcher
      .command(scope, 'plugin reload <name>')
      .alias('重载插件')
      .alias('plugin rl')
      .action(({ args }) => `reload:${args.name}`)
    app.dispatcher.command(scope, 'plugin list').action(() => 'list')
    app.dispatcher.command(scope, 'plugin config show').action(() => 'config')
    app.dispatcher.command(scope, 'go').action(() => 'parent')
    app.dispatcher.command(scope, 'go deeper').action(() => 'child')
    app.dispatcher.match(scope, '', (session) => {
      matches.push(session.text)
    })
    await say('/plugin reload foo')
    await say('/重载插件 bar')
    await say('/plugin rl baz')
    await say('/plugin')
    await say('/plugin config')
    await say('/go deeper')
    await say('/nope')
    await say('/plugin missing')
    expect(sent(bot)).toEqual([
      'reload:foo',
      'reload:bar',
      'reload:baz',
      '子命令：reload、rl、list、config',
      '子命令：show',
      'child',
    ])
    expect(matches).toEqual(['/nope', '/plugin missing'])
  })

  it('formats usage and filters help data by scope, permission, hidden and owner state', async () => {
    const { app, session } = dispatchFixture()
    const builder = app.dispatcher.command(scope, 'echo <text> [times:integer=1]').description('重复')
    app.dispatcher.command(scope, 'secret').hidden()
    app.dispatcher.command(scope, 'admin').permission('group.admin')
    app.dispatcher.command(scope, 'private').scope('private')
    app.dispatcher.command({ owner: 'off' }, 'disabled')
    app.dispatcher.isEnabledFor = (owner) => owner !== 'off'
    expect(formatUsage(builder)).toBe('/echo <text> [times]')
    expect(
      (await app.dispatcher.listCommands(session('help'))).map((command) => command.path.join(' ')),
    ).toEqual(['echo'])
    expect(
      (await app.dispatcher.listCommands(session('help', { role: 'admin' }))).map((command) =>
        command.path.join(' '),
      ),
    ).toEqual(['echo', 'admin'])
  })

  it('isolates action failures and sends only the configured generic reply', async () => {
    const { app, bot, say } = dispatchFixture()
    const error = vi.spyOn(app.logger, 'error')
    app.dispatcher.command({ owner: 'plugin' }, 'explode').action(() => {
      throw new Error('sensitive')
    })
    await say('/explode')
    expect(sent(bot)).toEqual(['命令执行出错，请稍后重试'])
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'plugin', command: 'explode', eventId: expect.any(String) }),
      'Command failed',
    )
    const quiet = dispatchFixture({ command: { replyOnError: false } })
    quiet.app.dispatcher.command(scope, 'explode').action(() => {
      throw new Error('failure')
    })
    await quiet.say('/explode')
    expect(quiet.bot.sends).toEqual([])
  })
})

describe('permissions and cooldowns', () => {
  it('supports shorthand, composition, superuser bypass and silent denial', async () => {
    const { app, bot, say } = dispatchFixture()
    app.dispatcher
      .command(scope, 'admin')
      .permission('group.admin')
      .action(() => 'allowed')
    app.dispatcher
      .command(scope, 'owner')
      .permission(perm.and(perm.group, perm.or(perm.groupOwner, perm.superuser), perm.not(perm.private)))
      .action(() => 'owner')
    await say('/admin', { role: 'member' })
    await say('/admin', { role: 'admin' })
    await say('/admin', { role: 'owner' })
    await say('/admin', { superuser: true })
    await say('/owner', { role: 'owner' })
    await say('/owner', { role: 'member' })
    expect(sent(bot)).toEqual(['权限不足', 'allowed', 'allowed', 'allowed', 'owner', '权限不足'])
    const silent = dispatchFixture({ command: { replyOnDenied: false } })
    silent.app.dispatcher
      .command(scope, 'admin')
      .permission('superuser')
      .action(() => 'bad')
    await silent.say('/admin')
    expect(silent.bot.sends).toEqual([])
  })

  it('checks permissions first and charges cooldown only after arguments parse', async () => {
    const { app, bot, say } = dispatchFixture()
    app.dispatcher
      .command(scope, 'ordered <n:integer>')
      .permission('group.owner')
      .cooldown('10s')
      .action(() => 'ok')
    await say('/ordered 1', { role: 'member' })
    await say('/ordered nope', { role: 'owner' })
    await say('/ordered nope', { role: 'owner' })
    await say('/ordered 2', { role: 'owner' })
    await say('/ordered 3', { role: 'owner' })
    expect(sent(bot)).toEqual([
      '权限不足',
      '参数 <n> 应为整数。用法：/ordered <n>',
      '参数 <n> 应为整数。用法：/ordered <n>',
      'ok',
      '冷却中，剩余 10s',
    ])
    const silent = dispatchFixture({ command: { replyOnDenied: false } })
    silent.app.dispatcher
      .command(scope, 'cool')
      .cooldown('10s')
      .action(() => 'ok')
    await silent.say('/cool')
    await silent.say('/cool')
    expect(sent(silent.bot)).toEqual(['ok'])
  })

  it.each(['user', 'group', 'global'] as const)(
    'enforces %s cooldown and warns only once',
    async (cooldownScope) => {
      vi.useFakeTimers()
      try {
        const { app, bot, say } = dispatchFixture()
        app.dispatcher
          .command(scope, 'limited')
          .cooldown('10s', { scope: cooldownScope })
          .action(() => 'ok')
        await say('/limited', { user: '1', group: '10' })
        await say('/limited', { user: '1', group: '10' })
        await say('/limited', { user: '1', group: '10' })
        expect(sent(bot)).toEqual(['ok', '冷却中，剩余 10s'])
        await say('/limited', { user: '1', group: '11' })
        await say('/limited', { user: '2', group: '10' })
        const additional = sent(bot).slice(2)
        if (cooldownScope === 'user') expect(additional).toEqual(['ok'])
        if (cooldownScope === 'group') expect(additional).toEqual(['ok'])
        if (cooldownScope === 'global') expect(additional).toEqual([])
        await say('/limited', { user: '1', group: '10', superuser: true })
        await say('/limited', { user: '1', group: '10', superuser: true })
        expect(sent(bot).slice(-2)).toEqual(['ok', 'ok'])
        await vi.advanceTimersByTimeAsync(10000)
        await say('/limited', { user: '1', group: '10' })
        expect(sent(bot).at(-1)).toBe('ok')
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('releases cooldown timers when the owner or app stops', async () => {
    vi.useFakeTimers()
    try {
      const { app, say } = dispatchFixture()
      const controller = new AbortController()
      app.dispatcher
        .command({ owner: 'plugin', signal: controller.signal }, 'limited')
        .cooldown('10s')
        .action(() => 'ok')
      await say('/limited')
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(10000)
      expect(vi.getTimerCount()).toBe(0)
      await say('/limited')
      expect(vi.getTimerCount()).toBe(1)
      controller.abort()
      expect(vi.getTimerCount()).toBe(0)
      app.dispatcher
        .command(scope, 'other')
        .cooldown('10s')
        .action(() => 'ok')
      await say('/other')
      expect(vi.getTimerCount()).toBe(1)
      await app.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
