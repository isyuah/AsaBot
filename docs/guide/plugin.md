# 插件开发指南

完整 API 与逐项说明在 [README 的「开发插件」](../../README.md#开发插件)。本篇给决策、骨架、常用配方和容易踩的坑，供快速落地。面板页面另见 [ui.md](ui.md)。

## 先选插件形态

| 形态 | 位置 | 适合 | 限制 |
| --- | --- | --- | --- |
| 文件插件 | `pluginLoader.dirs` 下的 `<name>.ts` 或 `<name>/index.ts` | 本机业务、快速迭代 | 需要自己管理文件 |
| npm 包 | `<dataDir>/packages`，从面板或 `/plugin install` 安装 | 分发、复用、上架市场 | 需要构建出 JS 和 `.d.ts` |
| 内置插件 | `src/plugins/`，静态注册 | 框架自带能力 | 不可卸载 |

文件插件修改入口及其相对导入后会自动热重载（非 production）。npm 包和框架同进程运行，拥有完整权限，只安装信任的包。

## 最小骨架

文件插件：

```ts
import { definePlugin } from '@asabot/core'

export default definePlugin({
  name: 'hello',
  setup(ctx) {
    ctx.command('hello [name=朋友]')
      .description('打个招呼')
      .action(({ args }) => `你好，${args.name}！`)
  },
})
```

npm 包入口相同，另外需要：

```json
{
  "name": "asabot-plugin-example",
  "version": "1.0.0",
  "type": "module",
  "keywords": ["asabot-plugin"],
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "peerDependencies": { "@asabot/core": "^0.2.0" }
}
```

Node 不会剥离 `node_modules` 里的 TypeScript，所以包必须编译后再发布。开发期可用 `npm create @asabot@latest -- --template plugin` 生成带构建和测试配置的项目。

命名规则：`/^[a-z0-9][a-z0-9_-]*$/`，全局唯一，`core` 是保留名。以 `_` 或 `.` 开头的文件、`*.test.*`、`*.spec.*`、`*.d.ts` 不会被当作插件。

## 生命周期

`loading → active | failed`，卸载时 `disposing → disabled`。

- `setup` 可以是 async；抛异常、配置校验失败、命令冲突或依赖缺失都会回收已注册资源并标记 `failed`，不影响其他插件。
- 注册类 API 都返回 disposer，插件卸载时自动回收；不需要手动逐个移除。
- 定时器、事件处理器和其他异步工作应检查 `ctx.signal`，卸载时它会 abort。
- 需要额外清理时用 `ctx.onDispose(fn)`，清理函数逆序执行。
- `depends` 决定加载顺序；依赖未激活时插件进入 `failed`，依赖恢复后自动重新协调。
- 热重载先 import 新版本，成功后才卸载旧实例；新代码导入失败时旧实例继续运行。ESM 缓存无法清除，频繁热重载会累积内存，长时间开发后重启进程。

## 注册点选择

| 需求 | API | 要点 |
| --- | --- | --- |
| 命令与子命令 | `ctx.command(decl)` | 最长路径优先；别名可以是完整路径 |
| 观察事件 | `ctx.on(name, fn)` | 事件名分层匹配，`notice` 会收到 `notice.member.join` |
| 改写消息流 | `ctx.middleware(fn, { priority })` | 不调用 `next()` 即终止后续处理 |
| 按内容触发 | `ctx.match(pattern, fn)` | 字符串是包含匹配，也支持正则和函数 |
| 限定平台或群 | `ctx.platform(...).filter(...)` | 可继续链式叠加，资源仍随卸载回收 |
| 定时任务 | `ctx.cron` / `ctx.interval` / `ctx.timeout` | 回调收到 `AbortSignal`；上次未结束会跳过本次 |
| 可恢复的一次性任务 | `ctx.task(name, fn, options)` | 重启后恢复，至少一次语义 |
| 插件 KV | `ctx.store` | JSON 值，支持 TTL，按插件隔离命名空间 |
| SQL | `ctx.db` + `ctx.migrate(steps)` | 表名用 `p_<插件名>_` 前缀，建表走 migrate |
| 提供服务 | `ctx.provide` / `ctx.provideScoped` | 使用方要先在 `inject` 声明 |
| 使用服务 | `ctx.inject` / `ctx.injectOptional` | 未声明的服务会抛 `PluginError` |
| HTTP 路由 | `ctx.route(app => ...)` | 挂载在 `/plugins/<name>/`，不经过面板登录 |
| 面板页面 | `ctx.panel.page` + `route` + `push` | 沙箱 iframe，数据走认证接口，见 [ui.md](ui.md) |
| 出站改写 | `ctx.beforeSend(fn)` | 可修改、拦截或接管发送 |
| 平台 API 拦截 | `ctx.interceptApi(fn)` | 按优先级执行，可改参数或结果 |

## 常用配方

### 命令、参数与选项

```ts
ctx.command('repeat <text:rest>')
  .alias('复读一下')
  .description('重复消息')
  .option('times', '-n, --times <n:integer>', { default: 1, min: 1, max: 5 })
  .example('/repeat -n 2 你好')
  .cooldown('2s', { scope: 'user' })
  .action(({ args, options }) => {
    if (options.times < 1 || options.times > 5) return '次数必须在 1 到 5 之间'
    return Array.from({ length: options.times }, () => args.text).flat()
  })
```

- `<name:type>` 必填，`[name:type]` 可选，`[name:integer=3]` 带默认值。
- 类型：`string`、`number`、`integer`、`posint`、`natural`、`date`、`boolean`、`user`、`duration`、`image`、`rest`，以及 `<mode:on|off>` 枚举。
- `rest` 保留消息段，只能放最后；字符串始终作为纯文本。
- 权限：`.permission('superuser')`、`.permission('group.owner')`、`.permission('group.admin')`，或 `perm` 组合。
- 作用域：`.scope('group')` / `.scope('private')`。
- 冷却：`.cooldown('10s', { scope: 'user' | 'group' | 'global' })`，超管不受限。
- action 返回字符串或消息段时自动发送；返回 `undefined` 不发送。

### 事件

```ts
ctx.on('notice.member.join', async (event) => {
  await event.bot.sendGroup(event.groupId, `欢迎 ${event.userId}`)
})
```

常用事件：`notice.member.join/leave/mute/unmute/role`、`notice.message.recall`、`notice.poke`、`request.friend`、`request.group.join`、`request.group.invite`。请求事件可调用 `approve()` / `reject()`。平台专属通知用 `notice.<platform>.<type>`，原始数据在 `raw`。

### 多轮对话

```ts
ctx.command('greet').action(async ({ session }) => {
  const reply = await session.prompt('你叫什么名字？', { timeout: '30s' })
  if (!reply) return '等待超时'
  return `你好，${reply.text}！`
})
```

- `session.confirm(text)` 返回 `boolean | null`；`session.choose(text, choices)` 返回选中的值或 `null`。
- `prompt` 默认等待同一会话的同一用户；`scope: 'channel'` 等任意用户，`filter` 进一步筛选。
- 回答会被 prompt 消费，不再进入命令或匹配器；观察者仍会收到事件。
- 插件卸载或框架关闭会中止等待。

### KV 与迁移

```ts
ctx.store.set('key', value, { ttl: '1h' })
const value = ctx.store.get<Value>('key')
const keys = ctx.store.keys('user:')

ctx.migrate([
  'CREATE TABLE p_scores_best (user_id TEXT PRIMARY KEY, score INTEGER NOT NULL)',
])
ctx.db.prepare('INSERT OR REPLACE INTO p_scores_best (user_id, score) VALUES (?, ?)')
  .run(session.userId, 3)
```

KV 读取时惰性删除过期项。迁移按插件记录版本，只执行新增步骤；通过 `ctx.db.exec` 直接建的表不会被清除插件数据时自动删除。

### 定时与持久任务

```ts
ctx.cron('0 9 * * *', async (signal) => {
  signal.throwIfAborted()
  await ctx.send('onebot11:group:123456', '早上好')
})

const remind = ctx.task<{ target: string; text: string }>(
  'remind',
  async (payload, { signal }) => {
    signal.throwIfAborted()
    await ctx.send(payload.target, payload.text)
  },
  { retry: { maxRetries: 2, delay: '5s', maxDelay: '5m' }, timeout: '1m' },
)
remind.schedule({ target: 'onebot11:group:123456', text: '开会了' }, { delay: '10m', key: 'meeting' })
```

- 临时定时用 `cron/interval/timeout`；需要重启恢复和执行历史用 `ctx.task`。
- 持久任务是至少一次语义，涉及外部副作用时自己保证幂等。
- 自动重试默认关闭；`retry(key, { confirmDelivery: true })` 用于已确认可以重试的未知投递。

### 服务

```ts
// 提供方
ctx.provide('coins', { get: (userId: string) => 0, add: (userId: string, n: number) => {} })

// 使用方
export default definePlugin({
  name: 'shop',
  inject: { optional: ['coins'] },
  setup(ctx) {
    const coins = ctx.injectOptional('coins')
    ctx.logger.info({ hasCoins: coins !== undefined }, '服务状态')
  },
})
```

必需服务缺失时插件等待服务恢复；可选服务缺失时正常加载。服务出现、消失或重载时，使用方自动重载。

### 配置

```ts
export default definePlugin({
  name: 'echo',
  config: z.object({
    maxLen: z.number().int().positive().default(200),
    welcome: z.boolean().default(false),
  }),
  setup(ctx) {
    ctx.config.maxLen          // 全局配置，只读
    ctx.configFor(session)     // 机器人覆盖 + 群覆盖后的有效配置
  },
})
```

- 没有声明 `config` 时 `ctx.config` 是 `undefined`。
- 覆盖按「全局原始输入 → 机器人 → 当前机器人的群」递归合并；对象逐字段合并，数组整体替换，最后执行 schema。
- 保存父级配置前会校验所有受影响的子级，任何一个失败都不写入。

### 主动发送

```ts
await ctx.send({ platform: 'onebot11', type: 'group', id: '123456' }, '定时提醒')
await ctx.send('onebot11:private:42', [seg.text('你好')])
const results = await ctx.broadcast(['onebot11:private:42', 'feishu:private:abc'], '通知', { interval: 1000 })
```

发送失败用 `DeliveryError` 识别，`code` 区分离线、限流、会话不可用、回执超时；`outcome` 区分确定未发出、结果未知和部分送达。

## 测试

```ts
import { createTestApp } from '@asabot/core/testing'
import { expect, it } from 'vitest'
import hello from '../plugins/hello.ts'

it('打招呼', async () => {
  const t = await createTestApp({ plugins: [hello] })
  try {
    expect(await t.say('/hello 小明')).toEqual(['你好，小明！'])
  } finally {
    await t.dispose()
  }
})
```

`say` 默认模拟群 `10`、用户 `20`，可传 `{ group, user, role, superuser }`，`{ group: null }` 模拟私聊。测试只覆盖行为契约，不测内部调用顺序。

## 发布

1. 编译为 ESM JS 并附带 `.d.ts`，`package.json` 加 `asabot-plugin` 关键字。
2. 可选：`keywords` 里加 `asabot-icon:https://...` 声明图标，必须是可公开访问的 HTTPS 图片。
3. 确认 `peerDependencies` 声明 `@asabot/core`，不要把框架打进产物。
4. 发布后可通过面板搜索安装，或超管执行 `/plugin install <包名>`。

## 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 插件状态 `failed` | 命令冲突、配置校验失败、依赖缺失、入口没有默认导出 `definePlugin(...)` | 看 `error` 和面板日志 |
| 修改后不生效 | 生产环境默认关闭热重载 | `pnpm dev` 或 `/plugin reload <name>` |
| 重启后任务丢失 | 用了 `ctx.timeout` 而不是 `ctx.task` | 需要恢复的任务改用 `ctx.task` |
| 卸载后定时器还在跑 | 用了裸 `setInterval` | 改用 `ctx.interval`，或检查 `ctx.signal` |
| 读取 `ctx.config` 得到 `undefined` | 没有声明 `config` schema | 声明 `config: z.object({...})` |
| 注入服务报 `PluginError` | 没在 `inject` 里声明 | 在插件定义里声明必需或可选服务 |
| 插件页白屏 | 前端构建没有用相对路径 | Vite 设置 `base: './'` |
| 插件页上传失败 | ZIP 超过 2 MB 或字体资产过大 | 不导入 `fonts.css`，压缩产物 |
| 多轮对话收不到回复 | 回复被 prompt 消费 | 这是设计行为，用 `ctx.filter` 之外的观察者处理旁路逻辑 |
