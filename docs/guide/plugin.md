# 插件功能开发

本篇讲插件本身怎么写：注册命令、处理事件、存数据、跑定时任务、使用服务。工程与发布见 [package.md](package.md)，面板页见 [panel-ui.md](panel-ui.md)。

## 先选插件形态

| 形态 | 位置 | 适合 | 限制 |
| --- | --- | --- | --- |
| 文件插件 | `pluginLoader.dirs` 下的 `<name>.ts` / `<name>.js` 或 `<name>/index.ts` / `index.js` | 本机业务、快速迭代 | 由宿主直接加载，TypeScript 必须使用可擦除语法 |
| npm 包 | `<dataDir>/packages`，从面板或 `/plugin install` 安装 | 分发、复用、上架市场 | 需要编译出 JS 和 `.d.ts` |
| 内置插件 | `src/plugins/`，静态注册 | 框架自带能力 | 属于框架仓库，不可卸载 |

文件插件默认放在 `plugins/`（`pluginLoader.dirs` 的默认值）。修改入口及其相对导入后会自动热重载（非 production）。npm 包和框架同进程运行，拥有完整权限，只安装信任的包。

## 最小骨架

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

文件插件的目录可以很简单：

```
plugins/
  hello.ts          # 单文件
  shop/
    index.ts        # 入口
    prices.ts       # 相对导入，如 './prices.ts'
    page/           # 可选的面板页静态文件
      index.html
```

发现规则：`<name>.ts`、`<name>.js`、`<name>/index.ts` 或 `<name>/index.js`；入口必须默认导出 `definePlugin(...)`。以 `_` 或 `.` 开头的文件、`*.test.*`、`*.spec.*`、`*.d.ts` 都会被忽略。

npm 包的结构、构建和 `package.json` 见 [package.md](package.md)。

命名规则：`/^[a-z0-9][a-z0-9_-]*$/`，全局唯一，`core` 是保留名。

## 插件定义字段

| 字段 | 用途 |
| --- | --- |
| `name` | 唯一名称，必填 |
| `version`、`description` | 面板展示 |
| `iconUrl` | 文件插件和内置插件的 HTTPS 图标；npm 包用 `asabot-icon:` 关键字 |
| `config` | zod schema，决定 `ctx.config` 的类型和默认值 |
| `depends` | 必须先加载的插件名 |
| `inject` | 必需或可选的服务：`['http']` 或 `{ required: [], optional: [] }` |
| `capabilities` | 平台能力需求，只用于面板兼容性提示 |
| `defaultOnNewBots` | 新机器人上的初始开关，默认关闭 |
| `setup(ctx)` | 注册资源，可以是 async |

## 生命周期

`loading → active | failed`，停用后是 `disabled`。卸载时的资源回收是内部过程，不会作为公开状态暴露。

- `setup` 抛异常、配置校验失败、命令冲突或依赖缺失都会回收已注册资源并标记 `failed`，不影响其他插件。
- 命令、事件、匹配器、中间件、定时器、服务和钩子返回移除函数；`ctx.route`、`ctx.panel.route`、`ctx.panel.push` 返回 `void`；`ctx.task` 返回任务句柄。所有资源都会随插件卸载回收。
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
| 定时任务 | `ctx.cron` / `ctx.interval` / `ctx.timeout` | 回调收到 `AbortSignal`；异常由框架记录；上次未结束会跳过本次 |
| 可恢复的一次性任务 | `ctx.task(name, fn, options)` | 重启后恢复，至少一次语义，异常写入执行历史 |
| 插件 KV | `ctx.store` | JSON 值，支持 TTL，按插件隔离命名空间 |
| SQL | `ctx.db` + `ctx.migrate(steps)` | 表名用 `p_<插件名>_` 前缀，建表走 migrate |
| 提供服务 | `ctx.provide` / `ctx.provideScoped` | 使用方要先在 `inject` 声明 |
| 使用服务 | `ctx.inject` / `ctx.injectOptional` | 未声明的服务会抛 `PluginError` |
| HTTP 路由 | `ctx.route(app => ...)` | 挂载在 `/plugins/<name>/`，不经过面板登录 |
| 面板页面 | `ctx.panel.page` + `route` + `push` | 沙箱 iframe，数据走认证接口，见 [panel-ui.md](panel-ui.md) |
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
- 权限：`.permission('superuser')`、`.permission('bot.admin')`、`.permission('group.owner')`、`.permission('group.admin')`，或 `perm` 组合。`bot.admin` 允许当前机器人的管理员和超管通过。
- 作用域：`.scope('group')` / `.scope('private')`。
- 冷却：`.cooldown('10s', { scope: 'user' | 'group' | 'global' })`，超管不受限。
- action 返回字符串或消息段时自动发送；返回 `undefined` 不发送。

### 事件

```ts
ctx.on('notice.member.join', async (event, signal) => {
  signal.throwIfAborted()
  await event.bot.sendGroup(event.groupId, `欢迎 ${event.userId}`)
})
```

常用事件：`notice.member.join/leave/mute/unmute/role`、`notice.message.recall`、`notice.poke`、`request.friend`、`request.group.join`、`request.group.invite`。请求事件可调用 `approve()` / `reject()`。平台专属通知用 `notice.<platform>.<type>`，原始数据在 `raw`。第二个参数是插件卸载时 abort 的 `AbortSignal`。

### 消息段与会话回复

```ts
import { seg } from '@asabot/core'

ctx.command('hello').action(async ({ session }) => {
  await session.reply([seg.text('你好 '), seg.at(session.userId)])
})
```

- `session.reply(content, { quote, at })` 默认引用原消息；`session.send(content)` 直接发送。
- 内容可以是字符串、消息段或消息段数组；字符串按纯文本处理。
- 常用段：`seg.text`、`seg.at`、`seg.image`、`seg.audio`、`seg.markdown`、`seg.button`。
- 发送时会按机器人能力降级不支持的段，例如按钮变成「文本：命令」。

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

KV 读取时惰性删除过期项。迁移按插件记录版本，只执行新增步骤；通过 `ctx.db.exec` 直接建的表，在清除插件数据时不会被自动删除。

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

- `cron/interval/timeout` 的异常由框架捕获并记录，上次未结束会跳过本次。
- 需要重启恢复和执行历史用 `ctx.task`；异常写入执行历史，按配置重试。处理器应该抛出异常而不是吞掉。
- 持久任务是至少一次语义，涉及外部副作用时自己保证幂等。
- 句柄还提供 `get(key)`、`attempts(key)`、`retry(key, options)`、`cancel(key)`。
- 自动重试默认关闭；`remind.retry(key, { confirmDelivery: true })` 用于已确认可以重试的未知投递。

### 服务

```ts
// 提供方，写在 setup 内
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

### 主动发送与查找 Bot

```ts
import { seg } from '@asabot/core'

await ctx.send({ platform: 'onebot11', type: 'group', id: '123456' }, '定时提醒')
await ctx.send('onebot11:private:42', [seg.text('你好')])
const results = await ctx.broadcast(['onebot11:private:42', 'feishu:private:abc'], '通知', { interval: 1000 })

const bot = ctx.bot() // 第一个在线且启用了本插件的 Bot；找不到时抛 NoBotOnlineError
const bots = ctx.bots // 当前启用了本插件的 Bot，包括离线
```

发送失败用 `DeliveryError` 识别，`code` 区分离线、限流、会话不可用、回执超时；`outcome` 区分确定未发出、结果未知和部分送达。`ctx.bots` 列出当前启用了本插件的 Bot（包括离线）。

### 本地文件

需要保存文件时用 `ctx.dataDir`，它指向 `data/plugins/<插件名>/` 并在首次访问时创建：

```ts
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

await writeFile(join(ctx.dataDir, 'snapshot.json'), JSON.stringify(data))
```

卸载插件默认保留数据；选择清除数据（purge）时会一并删除插件的数据目录、KV、迁移记录等。

## 常见功能问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 插件状态 `failed` | 命令冲突、配置校验失败、依赖缺失、入口没有默认导出 `definePlugin(...)` | 看 `error` 和面板日志 |
| 修改后不生效 | 生产环境默认关闭热重载 | 用开发模式启动（`npm run dev` 或 `asabot dev`），或 `/plugin reload <name>` |
| 重启后任务丢失 | 用了 `ctx.timeout` 而不是 `ctx.task` | 需要恢复的任务改用 `ctx.task` |
| 卸载后定时器还在跑 | 用了裸 `setInterval` | 改用 `ctx.interval`；保留裸定时器时在 `ctx.onDispose` 里 `clearInterval` |
| 读取 `ctx.config` 得到 `undefined` | 没有声明 `config` schema | 声明 `config: z.object({...})` |
| 注入服务报 `PluginError` | 没在 `inject` 里声明 | 在插件定义里声明必需或可选服务 |
| 多轮对话收不到回复 | 回复被 prompt 消费 | 这是设计行为；旁路逻辑放观察者 |
| 群内命令不触发 | 插件在该群或该机器人上未启用 | 检查 `/plugin on <name>` 和机器人插件开关 |

## 下一步

- 面板页：[panel-ui.md](panel-ui.md)
- 测试、构建和发布：[package.md](package.md)
