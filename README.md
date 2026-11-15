# AsaBot

AsaBot 是一个协议无关的 TypeScript 聊天机器人框架，支持 OneBot 11 等聊天平台。

## 特性

- 协议无关：通过适配器接入聊天平台，支持 OneBot 11 和多账号。
- 插件热重载：修改插件后自动加载，开发无需反复重启。
- 命令系统：支持参数、选项、权限、冷却和多轮对话。
- Web 面板：首次设置、管理机器人与插件、查看日志和调试消息。
- 插件市场：搜索、安装和管理 npm 插件包。
- 消息与存储：统一消息段、能力降级、SQLite 存储和定时任务。

## 快速开始

需要 Node.js **24 或更高版本**和 npm：

```sh
npm create @asabot@latest
cd asabot-bot
npm install
npm run dev
```

按提示选择 bot 模板和目录；使用自定义目录时，将上面的 `cd` 改为对应路径。首次启动后打开 <http://127.0.0.1:5140>，输入终端显示的一次性设置码，按向导设置面板密码、超管和聊天平台连接。`npm run dev` 会开启插件热重载，正式运行使用 `npm start`。

默认数据保存在 `data/`，配置保存在 `asabot.config.yaml`。向导将面板密码写入配置文件，之后可以改成环境变量引用。更多连接和备份说明见 [部署文档](docs/DEPLOY.md)。

## 配置参考

完整配置及每项说明见 [asabot.config.example.yaml](asabot.config.example.yaml)。`asabot.config.yaml` 是默认配置文件，也可通过 `ASABOT_CONFIG` 环境变量或 `asabot start --config <path>` 指定其他路径，命令行参数优先。`asabot dev --config <path>` 强制开启插件热重载；`asabot --help` 显示用法，`asabot --version` 显示版本号。日志在 stdout 是终端时使用易读格式，重定向时输出 JSON。启动时从当前工作目录加载 `.env`；配置字符串支持 `${VAR}` 和 `${VAR:-默认值}`，未设置且没有默认值的变量会导致启动失败。

| 配置项 | 用途 |
| --- | --- |
| `log`、`timezone`、`dataDir`、`superusers` | 日志级别和可选的轮转文件、时区、数据目录、超管 ID 列表 |
| `command` | 前缀、@机器人触发方式，以及错误和权限提示 |
| `dispatch` | 处理器超时、忽略自身消息、prompt 默认和最大超时 |
| `adapters.onebot11` | 正向 WS 地址、反向 WS token、API 超时、重连和发送队列；支持多个账号 |
| `pluginLoader` | 插件目录和热重载开关；`auto` 在 `NODE_ENV` 不是 `production` 时开启 |
| `packages` | 插件包目录、npm registry、npm 可执行文件和安装超时时间 |
| `plugins.<name>.enabled` | 插件全局开关，缺省为 `true` |
| `plugins.<name>.config` | 对应插件的配置，字段由插件的 schema 定义 |
| `server` | HTTP 监听地址和端口、面板密码、对外 API token；密码或 token 为空时分别关闭对应功能 |

时长可以写毫秒数或 `10s`、`5m`、`1h30m` 等字符串。内置插件也使用 `plugins` 配置。通过管理命令修改全局插件开关时会写回配置文件；按群开关和访问控制保存在 SQLite 中。

## 内置插件

`help`、`status`、`admin` 提供帮助、状态和管理命令；`http`、`history`、`long-message` 默认启用，可以在 `plugins.<name>.enabled` 中停用。

- `http` 提供 `fetch`、`json`、`text`、`buffer` 服务，支持代理、超时和响应体大小限制。需要缓存时可用 `ctx.store.set(key, value, { ttl: '1h' })`。
- `history` 记录收到和发出的消息及分发追踪，并提供按会话查询、搜索、分页和 JSONL 导出接口。默认保留 7 天、最多 100000 条消息，忽略调试台的 `virtual` 平台。
- `long-message` 对过长的纯文本消息优先使用合并转发；可配置为图片或分段发送，并为不同群覆盖配置。图片策略及不支持 Markdown 的平台可使用可选的 `render` 服务。

插件可以声明 `inject: ['http']` 或 `inject: ['history']`，然后通过 `ctx.inject('http')` 或 `ctx.inject('history')` 使用相应服务。完整默认配置见示例配置文件。

## 官方插件

`@asabot/plugin-render` 将文本、Markdown 和 satori HTML 渲染为 PNG，也可通过配置 Chrome 或 Edge 使用网页截图。可在插件市场安装，或由超管发送 `/plugin install @asabot/plugin-render`。在插件中声明 `inject: ['render']` 后即可使用：

```ts
const render = ctx.inject('render')
const image = await render.markdown('# 你好\n\n- AsaBot\n- Markdown')
await session.send(seg.image(image))
```

字体、emoji、浏览器配置及完整服务 API 见 [render 插件 npm 页面](https://www.npmjs.com/package/@asabot/plugin-render)。

## 管理面板与对外 API

配置非空的 `server.panelPassword` 可启用面板，配置 `server.apiToken` 可启用对外 API；配置值可以用 `${ASABOT_PANEL_PASSWORD}` 等语法引用环境变量或 `.env`。两者相互独立；都为空且未配置反向 WebSocket 时不监听 HTTP 端口。默认地址为 `http://127.0.0.1:5140`。安装的框架包已包含面板，访问该地址即可。面板登录会创建 7 天有效的会话 cookie，进程重启后需要重新登录。

对外 API 使用 `Authorization: Bearer <token>`。例如，在设置 `ASABOT_API_TOKEN` 的 shell 中：

```sh
curl -H "Authorization: Bearer $ASABOT_API_TOKEN" http://127.0.0.1:5140/api/v1/bots
curl -X POST http://127.0.0.1:5140/api/v1/send \
  -H "Authorization: Bearer $ASABOT_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"target":{"platform":"onebot11","type":"group","id":"123456"},"message":"你好"}'
```

`target.type` 可为 `group` 或 `private`；`target.platform` 指定平台，可选的 `target.selfId` 指定账号，否则使用该平台第一个在线 Bot。也可以将目标写成 `"onebot11:group:123456"`。`message` 接受纯文本字符串或消息段数组，成功时返回 `{ "messageId": "..." }`。插件可以通过 `ctx.route(app => ...)` 注册 Hono 路由，地址为 `/plugins/<插件名>/...`；这些路由不使用面板登录鉴权，插件卸载后立即失效。

## 内置命令

`/help` 仅显示当前会话有权限且已启用的命令，`/help -p 2` 翻页，`/help echo` 查看详情。`/ping` 和 `/status` 用于检查响应与运行状态。

| 命令 | 权限 | 作用 |
| --- | --- | --- |
| `/plugin list` | 超管 | 查看插件状态和失败原因；`-p` 翻页 |
| `/plugin enable <name>`、`/plugin disable <name>`、`/plugin reload <name>` | 超管 | 管理全局插件 |
| `/plugin on <name>`、`/plugin off <name>` | 群主、群管理员或超管 | 在当前群开启或关闭插件；不能在群内关闭 `admin` |
| `/acl list` | 超管 | 查看访问控制列表；`-p` 翻页 |
| `/acl block user <用户>`、`/acl allow user <用户>` | 超管 | 屏蔽或允许用户，用户可用 ID 或 @用户 |
| `/acl block group [群]`、`/acl allow group [群]` | 超管 | 屏蔽或允许群；省略群 ID 时使用当前群 |
| `/acl remove <block\|allow> <user\|group> [目标]` | 超管 | 移除条目；对象为群且省略目标时使用当前群 |

黑名单优先；用户和群的白名单分别生效，某一维度为空时不限制该维度。超管始终通过访问控制，不能被命令加入用户黑名单。为避免把自己锁在外面，聊天中不能停用 `admin`（全局或按群都不行）；确需停用时修改配置文件中的 `plugins.admin.enabled`。

## 安装与管理插件

文件插件可以放入 `pluginLoader.dirs`，也可以在面板上传 `.ts`、`.js` 或包含 `index.ts` / `index.js` 的 zip。上传目录由 `pluginLoader.uploadDir` 指定，默认是第一个插件目录；压缩包里的文件会解压到以压缩包文件名命名的目录。上传请求最大 2 MB，解压后最大 5 MB。面板可重新扫描目录，超管也可发送 `/plugin scan`；扫描会发现新增和删除的插件，已修改的插件使用热重载或 `/plugin reload <name>`。

面板可以搜索、安装、升级和卸载 npm 插件包。超管可以使用 `/plugin install <包名>`、`/plugin update <包名>` 和 `/plugin uninstall <插件名>`；安装时加 `-f` 可跳过框架版本检查。面板的包操作使用 npm 包名，插件卸载和聊天命令使用插件的 `name`。包代码与框架运行在同一进程，拥有进程的完整权限，只安装信任的插件。

文件和包插件默认保存在对应插件目录及 `data/packages`。卸载默认保留配置和数据；选择清除数据或在聊天命令后加 `--purge` 会一并删除插件的配置、KV、迁移记录、群开关、迁移中创建的表及数据目录。内置插件不能卸载。

### 开发并发布插件包

插件包是普通 ESM npm 包，入口默认导出插件定义。示例 `package.json`：

```json
{
  "name": "asabot-plugin-example",
  "version": "1.0.0",
  "type": "module",
  "keywords": ["asabot-plugin"],
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "peerDependencies": { "@asabot/core": "^0.1.0" }
}
```

发布前将 TypeScript 编译成 JS 并附带 `.d.ts`，因为 Node 不会剥离 `node_modules` 中的 TypeScript。插件入口使用 `import { definePlugin } from '@asabot/core'`；运行时会连接当前框架实例。也可以运行 `npm create @asabot@latest -- --template plugin` 创建带构建和测试配置的插件项目。

## 开发插件

### 最小插件

在 `plugins/hello.ts` 中编写：

```ts
import { definePlugin } from '@asabot/core'

export default definePlugin({
  name: 'hello',
  setup(ctx) {
    ctx
      .command('hello [name=朋友]')
      .description('打个招呼')
      .action(({ args }) => `你好，${args.name}！`)
  },
})
```

默认发现 `plugins/<name>.ts` 和 `plugins/<name>/index.ts`；文件默认导出 `definePlugin(...)` 的结果。顶层以 `_` 或 `.` 开头的文件和目录，以及 `*.test.*`、`*.spec.*`、`*.d.ts` 均被忽略。`name` 由小写英文字母、数字、`-` 和 `_` 组成且必须全局唯一，`core` 是保留名。插件可声明 `version`、`description`、`depends: ['其他插件名']` 和 zod 配置 schema；从 `@asabot/core` 导入 `z`。脚手架生成的 `plugins/hello.ts` 包含配置和命令示例。

### Context 一览

| API | 用途 |
| --- | --- |
| `ctx.name`、`ctx.config`、`ctx.logger` | 插件名、schema 解析后的只读配置、插件日志 |
| `ctx.on(name, handler)` | 观察事件，例如 `notice.member.join` |
| `ctx.middleware(fn, { priority })` | 注册中间件；调用 `next()` 才继续处理 |
| `ctx.command(declaration)` | 注册命令并链式设置选项、权限和 action |
| `ctx.match(pattern, handler, options)` | 按字符串、正则或函数匹配消息 |
| `ctx.filter(predicate)`、`ctx.platform(...names)` | 只在符合条件的事件中启用注册的处理器 |
| `ctx.configFor(session)` | 获取当前群合并并校验后的插件配置 |
| `ctx.route(app => ...)` | 注册插件的 Hono HTTP 路由，插件卸载时回收 |
| `ctx.panel.page`、`ctx.panel.route`、`ctx.panel.push` | 注册面板页面、受面板认证保护的数据接口和实时事件 |
| `ctx.cron`、`ctx.interval`、`ctx.timeout` | 注册定时任务 |
| `ctx.store`、`ctx.db`、`ctx.migrate(steps)` | 插件独立 KV、共享 SQLite 句柄、按插件版本管理的迁移 |
| `ctx.bot(selfId?)`、`ctx.bots` | 查找在线 Bot、列出 Bot；找不到在线 Bot 时 `ctx.bot()` 抛错 |
| `ctx.send`、`ctx.broadcast` | 向指定平台和会话主动发送或批量发送 |
| `ctx.beforeSend`、`ctx.interceptApi` | 处理出站消息或拦截 Bot API 调用 |
| `ctx.provide`、`ctx.inject`、`ctx.injectOptional` | 提供或使用插件服务 |
| `ctx.dataDir`、`ctx.signal`、`ctx.onDispose(fn)` | 插件数据目录、卸载信号、自定义清理函数 |

观察者、命令、中间件、匹配器和定时任务随插件卸载自动回收。事件处理器应配合 `signal` 取消耗时操作；插件代码仍运行在主进程中。

### 插件面板页面

插件可通过 `ctx.panel.page` 声明一个页面目录，通过 `ctx.panel.route` 注册数据接口。页面文件通过 `/plugin-pages/<插件名>/` 公开访问，不要在静态文件中存放敏感数据；需要鉴权的数据通过 `panel.route` 提供。面板启用时，这些接口位于 `/api/panel/ext/<插件名>/`，需要登录，修改请求也遵循面板的 CSRF 校验。

例如，`plugins/dashboard/index.ts`：

```ts
import { definePlugin } from '@asabot/core'

export default definePlugin({
  name: 'dashboard',
  setup(ctx) {
    ctx.panel.page({ title: '统计', icon: 'chart', root: new URL('./page/', import.meta.url) })
    ctx.panel.route((app) => app.get('/stats', (c) => c.json({ total: 42 })))
    // 需要通知页面时：ctx.panel.push('updated', { total: 42 })
  },
})
```

`plugins/dashboard/page/index.html`：

```html
<!doctype html>
<meta charset="utf-8">
<p id="stats"></p>
<script src="/plugin-pages/_sdk.js"></script>
<script>
  asabot.json('/stats').then((stats) => {
    document.querySelector('#stats').textContent = `总数：${stats.total}`
  })
</script>
```

`entry` 默认为 `index.html`。页面可用 `asabot.on('updated', handler)` 接收 `ctx.panel.push` 推送；SDK 还提供 `asabot.fetch`、`asabot.toast` 和 `asabot.theme`。页面、路由及推送入口随插件卸载失效。

### 通知与请求事件

事件名按层级匹配：派发 `notice.member.join` 时，`notice`、`notice.member` 和 `notice.member.join` 的监听器都会收到事件。带群 ID 的通知受插件按群开关控制；通知的用户 ID 和群 ID 也参与访问控制。所有 ID 都是字符串。

| 事件名 | 主要字段 |
| --- | --- |
| `notice.member.join` | `groupId`、`userId`、`operatorId?`、`joinType`（`approve`、`invite` 或其他类型） |
| `notice.member.leave` | `groupId`、`userId`、`operatorId?`、`reason`（`leave`、`kick` 或其他原因） |
| `notice.member.mute` / `notice.member.unmute` | `groupId`、`userId`、`operatorId?`；禁言事件另有毫秒数 `duration` |
| `notice.member.role` | `groupId`、`userId`、`role`（`admin` 或 `member`） |
| `notice.message.recall` | `messageId`、原作者 `userId`、`operatorId?`、`groupId?` |
| `notice.poke` | 发起者 `userId`、`targetId`、`groupId?` |
| `request.friend` / `request.group.join` / `request.group.invite` | `userId`、`groupId?`、`comment`，可调用 `approve(remark?)` 或 `reject(reason?)` |

例如，在插件的 `setup` 中欢迎新成员：

```ts
ctx.on('notice.member.join', async (event) => {
  await event.bot.sendGroup(event.groupId, `欢迎 ${event.userId}`)
})
```

未映射到通用事件的通知使用 `notice.<platform>.<type>[.<subType>]`，并提供 `platformType`、可选的 `subType` 和相关 ID。例如订阅 `notice.onebot11` 可接收 OneBot 11 的平台专属通知；其原始数据保存在 `raw` 中。

### 命令、参数与选项

```ts
ctx.command('repeat <text:rest>')
  .alias('复读一下')
  .description('重复消息')
  .option('times', '-n, --times <n:integer>', { default: 1, description: '重复次数' })
  .example('/repeat -n 2 你好')
  .action(({ args, options }) => {
    if (options.times < 1 || options.times > 5) return '次数必须在 1 到 5 之间'
    return Array.from({ length: options.times }, () => args.text).flat()
  })
```

命令路径在参数之前，例如 `plugin reload <name>`；最长路径优先。另行声明 `ctx.command('tool info')` 即可注册子命令，别名也可以是完整路径。`<name:type>` 表示必填，`[name:type]` 表示可选，`[name:integer=3]` 表示有默认值；省略类型时为 `string`。类型包括 `string`、`number`、`integer`、`posint`（正整数）、`natural`（非负整数）、`date`、`boolean`、`user`、`duration`、`image` 和 `rest`。`date` 按配置的 `timezone` 解析日期和时间，返回 `Date`；`<mode:on|off>` 声明枚举。`user` 接受单个非空用户 ID 或 @用户并返回 ID 字符串，`image` 接受图片段，`duration` 返回毫秒数，`rest` 返回保留非文本段的消息数组，只能放在最后。

参数通过 `.arg('count', { min: 1, max: 5, description: '次数' })` 设置约束，选项的第三个参数也支持 `min`、`max`、`pattern`、`validate` 和 `description`；`validate` 返回 `true` 或错误原因。正则匹配器的捕获组从 `ctx.match(/hello (\w+)/, ({ match }) => match?.[1])` 取得。

选项支持 `-n 2`、`--times 2`、`--times=2`；无参数选项可声明为 `.option('silent', '-s, --silent')`。选项与普通位置参数可以交错，但一旦开始读取 `rest`，之后都视为内容；`--` 也会结束选项解析。命令路径和别名区分大小写。action 返回字符串或消息段时，框架会发送它；返回 `undefined` 则不自动发送。

### Session、多轮对话、权限与冷却

`session.send(content)` 向当前会话发消息；`session.reply(content, { quote, at })` 默认引用原消息，可以关闭引用或在群内 @发送者。内容可为字符串、消息段或消息段数组，使用 `seg` 创建消息段。字符串按纯文本处理。

```ts
import { definePlugin } from '@asabot/core'

export default definePlugin({
  name: 'greet',
  setup(ctx) {
    ctx.command('greet').action(async ({ session }) => {
      const reply = await session.prompt('你叫什么名字？', { timeout: '30s' })
      if (!reply) return '等待超时'
      ctx.store.set(`name:${session.platform}:${session.userId}`, reply.text)
      return `你好，${reply.text}！`
    })
  },
})
```

`prompt` 默认等待同一会话中同一用户的消息，超时返回 `null`；可用 `scope: 'channel'` 等待会话中的任意用户，或用 `filter` 筛选。插件卸载和框架关闭会中止等待。输入会被 prompt 消费，不再进入命令或匹配器；观察者仍会收到事件。

使用 `.permission('superuser')`、`.permission('group.owner')`、`.permission('group.admin')` 或 `perm` 组合规则限制权限；群主通过管理员检查，超管通过内置角色检查。`.scope('group')` 和 `.scope('private')` 限制会话类型。`.cooldown('10s', { scope: 'user' })` 支持 `user`、`group` 和 `global`，超管不受冷却限制。

### 能力与消息段

`supports(bot, feature)` 可检查 Bot 是否原生支持某种消息段或方法；发送时框架会自动把不支持的段降级，例如图片变成 `[图片]`、Markdown 变成纯文本。平台专属段使用 `onebot11:json` 这样的命名空间。

```ts
import { seg, supports } from '@asabot/core'

const message = [seg.text('标题', ['bold']), seg.markdown('**内容**'), seg.button('打开', { link: 'https://example.com' })]
if (supports(session.bot, 'button')) ctx.logger.info('支持原生按钮')
await session.send(message) // 不支持按钮时降级为“打开: https://example.com”
```

`seg.button('执行', { command: '/help' })` 创建命令按钮，不支持时降级为“执行：发送 /help”。

### 主动发送

`Target` 包含 `platform`、`type`、`id` 和可选的 `selfId`；`session.target` 是当前会话目标。`formatTarget` 与 `parseTarget` 可在对象和 `platform[:selfId]:type:id` 字符串之间转换，`targetSchema` 可用于插件配置。

```ts
import { formatTarget, parseTarget, type Target } from '@asabot/core'

const target: Target = { platform: 'onebot11', type: 'group', id: '123456' }
await ctx.send(target, '定时提醒')
const results = await ctx.broadcast([formatTarget(target), parseTarget('onebot11:private:42')], '通知')
for (const result of results) if (result.error) ctx.logger.warn({ err: result.error }, '发送失败')
```

批量发送按顺序进行，单个目标失败会记入对应结果；可传 `{ interval: 1000 }` 设置发送间隔，单位为毫秒。

### 可选服务

在插件定义中用 `inject: { required: [...], optional: [...] }` 声明服务，必需服务缺失时插件等待服务恢复，可选服务缺失时正常加载。可选服务出现、消失或重载时，使用方会自动重载。

```ts
export default definePlugin({
  name: 'shop',
  inject: { optional: ['coins'] },
  setup(ctx) {
    const coins = ctx.injectOptional('coins') // 服务实例或 undefined
    ctx.logger.info({ hasCoins: coins !== undefined }, '服务状态')
  },
})
```

### API 拦截

`ctx.interceptApi` 按优先级从高到低执行；可修改 `call.args`、等待 `next()` 后修改结果，或直接返回模拟结果。拦截器内部调用 Bot API 不会再次进入拦截器，插件卸载时自动移除。

```ts
ctx.interceptApi(async (call, next) => {
  if (call.method === 'sendGroup' && call.args[0] === '旧群') call.args[0] = '新群'
  return next()
}, { priority: 10 })
```

### 存储与定时任务

`ctx.store.set('key', value, { ttl: '1h' })` 保存可 JSON 序列化的值，`ctx.store.get<T>('key')` 读取，另有 `delete(key)` 和 `keys(prefix?)`。每个插件有独立命名空间。

需要 SQL 时，在 `setup` 中按顺序追加迁移步骤，并使用参数化查询。下例属于名为 `scores` 的插件：

```ts
ctx.migrate([
  'CREATE TABLE p_scores_best (user_id TEXT PRIMARY KEY, score INTEGER NOT NULL)',
])
ctx.db.prepare('INSERT OR REPLACE INTO p_scores_best (user_id, score) VALUES (?, ?)')
  .run(session.userId, 3)
```

迁移按插件记录已执行版本，只执行新增步骤；约定表名以 `p_<插件名>_` 开头。建表应通过 `ctx.migrate`，框架记录迁移创建的表的归属，清除插件数据时才会删除这些表；直接通过 `ctx.db.exec` 创建的表不会被自动清除。`session` 在上例中来自命令或事件处理器。

定时任务可以用 `ctx.cron('0 9 * * *', fn)`、`ctx.interval('10m', fn)` 或 `ctx.timeout('30s', fn)`。回调接收 `AbortSignal`，插件卸载时信号会中止并自动停止任务；同一任务上次尚未结束时会跳过本次，任务异常会记录日志。cron 默认使用配置的 `timezone`，也可用第三个参数 `{ timezone: 'Europe/London' }` 单独指定。

需要重启恢复和执行历史的一次性任务使用 `ctx.task`：

```ts
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

`at` 与 `delay` 二选一；同键 schedule 替换旧任务并等待旧回调退出。自动重试默认关闭，超时与取消通过 `signal` 协作。`get(key)` 查看最新状态，`attempts(key)` 查看执行历史，`retry(key)` 重试失败任务，`cancel(key)` 取消未完成任务。处理器在插件 setup 成功后开始执行；中断后恢复采用至少一次语义，涉及外部副作用时应自行保证幂等。全局默认并发 4，终态历史保留 7 天、最多 10000 条。

### 按群开关与热重载

`ctx.platform('onebot11').filter(event => groupKeyOf(event) === 'onebot11:123').command('hello')` 只在对应平台和群生效；`groupKeyOf` 从 `@asabot/core` 导入，过滤条件可以链式组合。过滤上下文支持注册观察者、中间件、命令和匹配器，资源仍随插件卸载回收。

声明配置 schema 的插件可以在处理器中调用 `ctx.configFor(session)` 读取按群配置；也可传入 `platform:groupId` 字符串。群覆盖项浅合并到全局配置的顶层，再由 schema 校验；私聊返回全局配置。

群主、群管理员或超管可在群内发送 `/plugin off echo` 和 `/plugin on echo`，只影响当前平台和群；该插件的观察者、中间件、命令和匹配器都会受开关影响。全局启停由超管使用 `/plugin disable echo` 和 `/plugin enable echo`。

默认在非 production 环境监听插件目录，修改入口及其相对导入的文件后自动重载；也可用 `/plugin reload <name>` 手动重载。新代码导入失败时旧实例继续运行；删除入口文件会卸载插件并将其从列表中移除，依赖它的插件进入 failed 状态，入口恢复后自动重新协调。Node 的 ESM 缓存不能清除，频繁热重载会保留旧模块并逐渐增加内存占用，长时间开发后可重启进程。

### 测试插件

`@asabot/core/testing` 的 `createTestApp` 使用进程内虚拟适配器和临时数据库，不连接网络。下面的测试对应上面的 `plugins/hello.ts`：

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

`say` 默认模拟群 `10` 中用户 `20` 的消息，可传 `{ group: 'room-a', user: 'user-a', role: 'admin' }`，或用 `{ group: null }` 模拟私聊。返回值是本次发送内容的数组；测试结束调用 `dispose()`。也可传 `pluginDirs` 加载目录、传 `config` 覆盖配置，使用 `t.app` 和虚拟适配器 `t.mock` 检查状态或模拟通知。测试 OneBot 协议时可从 `@asabot/core/onebot11/testing` 导入 `MockOneBot`。

消息段通过 `seg.at(id)`、`seg.audio(file)` 等构造，平台专属消息段使用平台命名空间。需要 OneBot 专属能力时，从 `@asabot/core/onebot11` 导入 `isOneBot`、`parseCQ`、`toCQ`、`ApiError` 和相关类型；字符串始终作为纯文本发送。`createTestApp` 不接受外部适配器配置，可通过 `capabilities` 模拟能力较弱的平台。

## 部署

Docker、Compose、反向代理、备份与升级步骤见 [部署文档](docs/DEPLOY.md)。

## 仓库开发

```sh
pnpm install
pnpm dev
pnpm test
```

其他检查命令：`pnpm typecheck`、`pnpm lint`；构建发布用框架代码使用 `pnpm build:lib`。
