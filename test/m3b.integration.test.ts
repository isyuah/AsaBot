import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { definePlugin, seg } from '../src/index.ts'
import { createTestApp, type TestApp } from '../src/testing/index.ts'

const apps: TestApp[] = []

async function start(options: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  const app = await createTestApp({
    ...options,
    pluginDirs: [resolve('plugins')],
    config: { ...options.config, superusers: [{ platform: 'virtual', selfId: '10000', userId: '99' }] },
  })
  apps.push(app)
  return app
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const app of apps.splice(0)) await app.dispose()
})

describe('M3b through the virtual adapter', () => {
  it('loads examples, aliases, options and cooldowns', async () => {
    const t = await start()
    expect(await t.say('/echo hi')).toEqual(['hi'])
    expect(await t.say('/复读 hi', { user: '21' })).toEqual(['hi'])
    expect(await t.say('/echo -n 2 hi', { user: '22' })).toEqual(['hihi'])
    expect(await t.say('/echo again')).toEqual([expect.stringContaining('冷却中')])
    expect(await t.say('/echo -n 6 hi', { user: '23' })).toEqual([expect.stringContaining('1 到 5')])
  })

  it('plays a deterministic game, records best scores and displays the ranking', async () => {
    const t = await start()
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.49)
    expect(await t.say('/猜数')).toEqual([expect.stringContaining('1 到 100')])
    random.mockRestore()
    expect(await t.say('20')).toEqual([expect.stringContaining('太小')])
    expect(await t.say('50')).toEqual([expect.stringContaining('共猜 2 次')])
    expect(await t.say('/猜数 排行')).toEqual([expect.stringContaining('20：2 次')])

    vi.spyOn(Math, 'random').mockReturnValue(0.49)
    await t.say('/猜数')
    vi.restoreAllMocks()
    expect(await t.say('50')).toEqual([expect.stringContaining('最佳成绩 1 次')])
    expect(await t.say('/猜数 排行')).toEqual([expect.stringContaining('20：1 次')])
    await t.say('/猜数')
    expect(await t.say('退出')).toEqual(['已退出猜数游戏'])
  })

  it('reports a prompt timeout', async () => {
    const t = await start({ config: { dispatch: { promptTimeout: 500 } } })
    expect(await t.say('/猜数')).toEqual([expect.stringContaining('1 到 100')])
    await vi.waitFor(
      () =>
        expect(
          t.mock.bot.sends.some(
            (item) => item.target === '10' && JSON.stringify(item.message).includes('猜数超时'),
          ),
        ).toBe(true),
      { timeout: 2_000 },
    )
  })

  it('shows visible commands and their details without revealing restricted commands', async () => {
    const extra = definePlugin({
      name: 'extra',
      setup(ctx) {
        ctx
          .command('secret')
          .hidden()
          .action(() => 'secret')
        ctx
          .command('private-only')
          .scope('private')
          .action(() => 'private')
      },
    })
    const t = await start({ plugins: [extra] })
    const help = String((await t.say('/help'))[0])
    expect(help).toContain('【echo】')
    expect(help).toContain('/猜数')
    expect(help).toContain('/help')
    expect(help).toContain('/ping')
    expect(help).not.toContain('secret')
    expect(help).not.toContain('/plugin disable')
    expect(help).not.toContain('private-only')
    const detail = String((await t.say('/help echo'))[0])
    expect(detail).toContain('/echo <text>')
    expect(detail).toContain('复读')
    expect(detail).toContain('-n, --times')
    expect(detail).toContain('默认 1')
    expect(detail).toContain('/echo -n 2 你好')
    expect(await t.say('/help 不存在')).toEqual([expect.stringContaining('未找到')])
    expect(await t.say('/help plugin', { user: '99' })).toEqual([expect.stringContaining('/plugin list')])
    expect(await t.say('/help -p 2', { user: '99' })).toEqual([expect.stringContaining('2/3')])
    expect(await t.say('/help -p 0')).toEqual([expect.stringContaining('页码')])
  })

  it('reports status and failed plugins', async () => {
    const broken = definePlugin({
      name: 'broken',
      setup() {
        throw new Error('setup broke')
      },
    })
    const t = await start({ plugins: [broken] })
    expect(await t.say('/ping')).toEqual(['pong'])
    const status = String((await t.say('/status'))[0])
    for (const text of [
      '运行时长',
      process.version,
      'RSS',
      'virtual:10000 online',
      'active',
      'failed 1',
      'disabled 0',
      'broken',
    ]) {
      expect(status).toContain(text)
    }
    expect(await t.say('/plugin list', { user: '99' })).toEqual([
      expect.stringContaining('broken: failed - setup broke'),
    ])
    expect(await t.say('/plugin enable broken', { user: '99' })).toEqual([
      expect.stringContaining('失败：setup broke'),
    ])
  })

  it('enforces global and group plugin permissions and gives readable errors', async () => {
    const t = await start()
    expect(await t.say('/plugin disable echo')).toEqual(['权限不足'])
    expect(await t.say('/plugin disable echo', { user: '99' })).toEqual(['已停用插件 echo'])
    expect(await t.say('/echo hi', { user: '21' })).toEqual([])
    expect(await t.say('/plugin reload echo', { user: '99' })).toEqual(['已重载插件 echo（当前全局停用）'])
    expect(await t.say('/echo hi', { user: '21' })).toEqual([])
    expect(await t.say('/plugin enable echo', { user: '99' })).toEqual(['已启用插件 echo'])
    expect(await t.say('/echo hi', { user: '21' })).toEqual(['hi'])
    expect(await t.say('/plugin reload absent', { user: '99' })).toEqual([expect.stringContaining('失败')])
    expect(await t.say('/plugin off echo', { user: '21' })).toEqual(['权限不足'])
    expect(await t.say('/plugin off echo', { user: '21', role: 'admin' })).toEqual(['已在本群关闭插件 echo'])
    expect(await t.say('/echo hi', { user: '22' })).toEqual([])
    expect(String((await t.say('/help'))[0])).not.toContain('/echo')
    expect(await t.say('/echo hi', { user: '22', group: '11' })).toEqual(['hi'])
    expect(await t.say('/plugin off admin', { user: '21', role: 'owner' })).toEqual([
      expect.stringContaining('不能'),
    ])
    expect(await t.say('/plugin on echo', { user: '99', group: null })).toEqual([
      expect.stringContaining('只能在群里'),
    ])
    expect(await t.say('/plugin on echo', { user: '21', role: 'admin' })).toEqual(['已在本群开启插件 echo'])
    expect(await t.say('/echo hi', { user: '23' })).toEqual(['hi'])
  })

  it('manages access entries and never blocks a superuser', async () => {
    const t = await start()
    expect(await t.say('/acl list')).toEqual(['权限不足'])
    expect(await t.say([seg.text('/acl block user '), seg.at('99')], { user: '99' })).toEqual([
      '不能屏蔽超管',
    ])
    expect(await t.say([seg.text('/acl block user '), seg.at('21')], { user: '99' })).toEqual([
      '已添加 block user virtual:21',
    ])
    expect(await t.say('/ping', { user: '21' })).toEqual([])
    expect(await t.say('/acl list', { user: '99' })).toEqual([
      expect.stringContaining('block user virtual:21'),
    ])
    expect(await t.say([seg.text('/acl remove block user '), seg.at('21')], { user: '99' })).toEqual([
      '已移除 block user virtual:21',
    ])
    expect(await t.say('/ping', { user: '21' })).toEqual(['pong'])
    expect(await t.say('/acl block group', { user: '99' })).toEqual(['已添加 block group virtual:10'])
    expect(await t.say('/ping', { user: '21' })).toEqual([])
    expect(await t.say('/acl remove block group', { user: '99' })).toEqual(['已移除 block group virtual:10'])
    expect(await t.say('/acl allow user 21', { user: '99' })).toEqual(['已添加 allow user virtual:21'])
    expect(await t.say('/ping', { user: '22' })).toEqual([])
    expect(await t.say('/ping', { user: '21' })).toEqual(['pong'])
    expect(await t.say('/acl remove allow user 21', { user: '99' })).toEqual(['已移除 allow user virtual:21'])
    expect(await t.say('/acl allow group 11', { user: '99' })).toEqual(['已添加 allow group virtual:11'])
    expect(await t.say('/ping', { user: '21' })).toEqual([])
    expect(await t.say('/ping', { user: '21', group: '11' })).toEqual(['pong'])
    expect(await t.say('/acl remove allow group 11', { user: '99' })).toEqual([
      '已移除 allow group virtual:11',
    ])
    expect(await t.say('/acl block group', { user: '99', group: null })).toEqual([
      expect.stringContaining('指定群'),
    ])
    expect(await t.say('/acl remove wrong user 21', { user: '99' })).toEqual([
      expect.stringContaining('block 或 allow'),
    ])
  })

  it('reports the result when admin reloads itself and refuses to disable itself', async () => {
    const t = await start()
    expect(await t.say('/plugin reload admin', { user: '99' })).toEqual([
      expect.stringContaining('已重载插件 admin'),
    ])
    expect(t.app.plugins.get('admin')?.state).toBe('active')
    expect(await t.say('/plugin disable admin', { user: '99' })).toEqual([
      expect.stringContaining('不能在聊天中停用 admin'),
    ])
    expect(t.app.plugins.get('admin')?.state).toBe('active')
  })

  it('manages access for nonnumeric user and group IDs', async () => {
    const t = await start()
    expect(await t.say('/acl block user user-alice', { user: '99' })).toEqual([
      '已添加 block user virtual:user-alice',
    ])
    expect(await t.say([seg.text('/acl allow user '), seg.at('user-bob')], { user: '99' })).toEqual([
      '已添加 allow user virtual:user-bob',
    ])
    expect(await t.say('/acl block group room-alpha', { user: '99' })).toEqual([
      '已添加 block group virtual:room-alpha',
    ])
  })

  it('provides access to later pages of plugin and access lists', async () => {
    const plugins = Array.from({ length: 31 }, (_, index) =>
      definePlugin({ name: `sample-${index}`, setup() {} }),
    )
    const t = await start({ plugins })
    for (let index = 0; index < 31; index++) {
      t.app.storage.access.add('block', 'group', `virtual:${index + 100}`)
    }
    expect(await t.say('/plugin list -p 2', { user: '99' })).toEqual([expect.stringContaining('sample-30')])
    expect(await t.say('/acl list -p 2', { user: '99' })).toEqual([expect.stringContaining('virtual:130')])
    expect(await t.say('/acl list -p 3', { user: '99' })).toEqual([expect.stringContaining('没有第 3 页')])
  })

  it('welcomes group members subject to the group switch and access lists', async () => {
    const t = await start({ config: { plugins: { echo: { config: { welcome: true } } } } })
    const event = {
      name: 'notice.member.join',
      joinType: 'approve',
      groupId: '10',
      userId: '21',
      operatorId: '22',
    } as const
    await t.mock.emitNotice(event)
    expect(t.mock.bot.sends.at(-1)?.message).toEqual([seg.text('欢迎 '), seg.at('21')])
    await t.say('/plugin off echo', { user: '99' })
    const before = t.mock.bot.sends.length
    await t.mock.emitNotice(event)
    // A subsequent message establishes that the notice has reached the app before checking its effects.
    await t.say('/ping')
    expect(
      t.mock.bot.sends.slice(before).filter((item) => JSON.stringify(item.message).includes('欢迎')),
    ).toEqual([])

    await t.say('/plugin on echo', { user: '99' })
    let sent = t.mock.bot.sends.length
    const access = t.app.storage.access
    access.add('block', 'user', 'virtual:21')
    await t.mock.emitNotice(event)
    expect(t.mock.bot.sends).toHaveLength(sent)
    access.remove('block', 'user', 'virtual:21')
    access.add('block', 'group', 'virtual:10')
    await t.mock.emitNotice(event)
    expect(t.mock.bot.sends).toHaveLength(sent)
    access.remove('block', 'group', 'virtual:10')
    access.add('allow', 'user', 'virtual:other')
    await t.mock.emitNotice(event)
    expect(t.mock.bot.sends).toHaveLength(sent)
    access.add('allow', 'user', 'virtual:21')
    await t.mock.emitNotice(event)
    expect(t.mock.bot.sends).toHaveLength(++sent)
    access.add('allow', 'group', 'virtual:other')
    await t.mock.emitNotice(event)
    expect(t.mock.bot.sends).toHaveLength(sent)
    access.add('allow', 'group', 'virtual:10')
    await t.mock.emitNotice(event)
    expect(t.mock.bot.sends).toHaveLength(++sent)
  })
})
