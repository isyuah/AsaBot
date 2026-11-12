# AsaBot

AsaBot 是一个使用 TypeScript 编写的 QQ 机器人框架。当前通过 OneBot 11 正向 WebSocket 连接 NapCat，提供命令、多轮对话、权限、插件热重载和 SQLite 存储。

## 快速开始

需要 Node.js **24 或更高版本**、pnpm，以及已登录 QQ 的 NapCat。项目直接运行 TypeScript，不需要构建。

1. 在仓库根目录安装依赖并复制配置：

   ```powershell
   pnpm install
   Copy-Item asabot.config.example.yaml asabot.config.yaml
   ```

   macOS/Linux 可用 `cp asabot.config.example.yaml asabot.config.yaml`。

2. 在 NapCat 的网络配置中开启 **OneBot 11 WebSocket 服务端**，例如监听端口 `3001`，并设置 token。编辑 `asabot.config.yaml`，把 `superusers` 里的 `10001` 改成自己的 QQ 号；如果 NapCat 不在本机，也要修改 `onebot11.connections[0].url`。

   示例配置连接 `ws://127.0.0.1:3001`，从 `NAPCAT_TOKEN` 环境变量读取 token。可以在仓库根目录创建 `.env`，内容为：

   ```dotenv
   NAPCAT_TOKEN=填写与NapCat一致的token
   ```

   `.env` 和实际配置文件已被 Git 忽略；也可以在启动前设置同名环境变量。如果 NapCat 没有设置 token，可不设置该变量。NapCat 在 Docker 中运行时，需要映射服务端口（例如 `3001:3001`）并确保服务监听容器网络地址；如果 AsaBot 也在容器中，可以让两者处于同一个网络，并把 URL 换成 NapCat 的容器名和端口。容器里的 `127.0.0.1` 指向容器自身。

3. 在仓库根目录启动：

   ```powershell
   pnpm start
   # 开发时也可以使用：pnpm dev
   ```

   在机器人所在的群或私聊中发送 `/help`、`/ping`、`/echo 你好` 或 `/猜数`。默认示例中 `/echo` 有两秒用户冷却；`-n` 选项需写在文本之前，例如 `/echo -n 2 你好`。

默认数据目录是 `./data`：数据库为 `data/asabot.db`，插件可使用 `data/plugins/<插件名>/`。相对路径以启动进程的当前工作目录为基准。备份数据时应同时考虑 SQLite WAL 文件，建议先停止 AsaBot 再备份整个数据目录。

### 常见问题

- **连接不上 NapCat**：查看 `OneBot WebSocket error` 日志中的 `reason`、`code` 和 URL，例如 `ECONNREFUSED` 通常表示地址、端口、服务监听或容器端口映射需要检查。将 `logLevel` 改为 `debug` 可看到 `Connecting OneBot forward WebSocket`。连接失败后框架会自动重试。
- **token 不一致**：NapCat 会拒绝 WebSocket 握手，日志通常包含 `401` 等服务端返回的错误，机器人不会上线并会继续重连。核对 NapCat 的 token 和 `NAPCAT_TOKEN`；不要把 token 写进 URL 或提交到仓库。
- **启动后没有命令回复**：先查看 `/ping` 和 `/status`，再检查插件状态、访问控制、群插件开关和命令前缀。`AsaBot started` 表示框架已启动，适配器仍可能处于重连中。
- **插件加载失败**：超管使用 `/plugin list` 查看失败原因，详细信息见日志；修复插件文件后会自动尝试重载。

## 配置参考

完整配置及每项说明见 [asabot.config.example.yaml](asabot.config.example.yaml)。`asabot.config.yaml` 是默认配置文件，也可通过 `ASABOT_CONFIG` 环境变量指定其他路径。启动时从当前工作目录加载 `.env`；配置字符串支持 `${VAR}` 和 `${VAR:-默认值}`，未设置且没有默认值的变量会导致启动失败。

| 配置项 | 用途 |
| --- | --- |
| `logLevel`、`dataDir`、`superusers` | 日志级别、数据目录、超管 ID 列表 |
| `command` | 前缀、@机器人触发方式，以及错误和权限提示 |
| `dispatch` | 处理器超时、忽略自身消息、prompt 默认和最大超时 |
| `onebot11` | 正向 WS 地址与 token、API 超时和重连间隔；`connections` 可配置多个账号 |
| `pluginLoader` | 插件目录和热重载开关；`auto` 在 `NODE_ENV` 不是 `production` 时开启 |
| `plugins.<name>.enabled` | 插件全局开关，缺省为 `true` |
| `plugins.<name>.config` | 对应插件的配置；示例 `echo` 支持 `maxLen` 和 `welcome` |
| `server` | HTTP 监听地址和端口、面板密码、对外 API token；密码或 token 为空时分别关闭对应功能 |

时长可以写毫秒数或 `10s`、`5m`、`1h30m` 等字符串。内置插件 `help`、`status`、`admin` 也使用 `plugins` 配置。通过管理命令修改全局插件开关时会写回配置文件；按群开关和访问控制保存在 SQLite 中。

## 管理面板与对外 API

通过环境变量或 `.env` 设置 `ASABOT_PANEL_PASSWORD` 以启用面板，设置 `ASABOT_API_TOKEN` 以启用对外 API。两者相互独立；都为空时不监听 HTTP 端口。默认地址为 `http://127.0.0.1:5140`。面板前端构建后访问该地址；在仓库根目录执行 `pnpm --filter web build` 可生成 `web/dist`。面板登录会创建 7 天有效的会话 cookie，进程重启后需要重新登录。

对外 API 使用 `Authorization: Bearer <token>`。例如，在设置 `ASABOT_API_TOKEN` 的 shell 中：

```sh
curl -H "Authorization: Bearer $ASABOT_API_TOKEN" http://127.0.0.1:5140/api/v1/bots
curl -X POST http://127.0.0.1:5140/api/v1/send \
  -H "Authorization: Bearer $ASABOT_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"target":{"type":"group","id":"123456"},"message":"你好"}'
```

`target.type` 可为 `group` 或 `private`；可选传 `platform` 和 `selfId` 选择在线 Bot，不指定时使用第一个在线 Bot。`message` 接受纯文本字符串或消息段数组，成功时返回 `{ "messageId": "..." }`。插件可以通过 `ctx.route(app => ...)` 注册 Hono 路由，地址为 `/plugins/<插件名>/...`；这些路由不使用面板登录鉴权，插件卸载后立即失效。

## 内置命令

`/help` 仅显示当前会话有权限且已启用的命令，`/help -p 2` 翻页，`/help echo` 查看详情。`/ping` 和 `/status` 用于检查响应与运行状态。

| 命令 | 权限 | 作用 |
| --- | --- | --- |
| `/plugin list` | 超管 | 查看插件状态和失败原因；`-p` 翻页 |
| `/plugin enable <name>`、`/plugin disable <name>`、`/plugin reload <name>` | 超管 | 管理全局插件 |
| `/plugin on <name>`、`/plugin off <name>` | 群主、群管理员或超管 | 在当前群开启或关闭插件；不能在群内关闭 `admin` |
| `/acl list` | 超管 | 查看访问控制列表；`-p` 翻页 |
| `/acl block user <用户>`、`/acl allow user <用户>` | 超管 | 屏蔽或允许用户，用户可用数字 ID 或 @用户 |
| `/acl block group [群]`、`/acl allow group [群]` | 超管 | 屏蔽或允许群；省略群 ID 时使用当前群 |
| `/acl remove <block\|allow> <user\|group> [目标]` | 超管 | 移除条目；对象为群且省略目标时使用当前群 |

黑名单优先；用户和群的白名单分别生效，某一维度为空时不限制该维度。超管始终通过访问控制，不能被命令加入用户黑名单。为避免把自己锁在外面，聊天中不能停用 `admin`（全局或按群都不行）；确需停用时修改配置文件中的 `plugins.admin.enabled`。

## 开发插件

### 最小插件

在 `plugins/hello.ts` 中编写：

```ts
import { definePlugin } from 'asabot'

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

默认发现 `plugins/<name>.ts` 和 `plugins/<name>/index.ts`；文件默认导出 `definePlugin(...)` 的结果。`name` 由小写英文字母、数字、`-` 和 `_` 组成且必须全局唯一，`core` 是保留名。插件可声明 `version`、`description`、`depends: ['其他插件名']` 和 zod 配置 schema；从 `asabot` 导入 `z`。例如 `plugins/echo.ts` 和 `plugins/guess.ts` 分别演示配置、观察者、命令和多轮游戏。

### Context 一览

| API | 用途 |
| --- | --- |
| `ctx.name`、`ctx.config`、`ctx.logger` | 插件名、schema 解析后的只读配置、插件日志 |
| `ctx.on(name, handler)` | 观察事件，例如 `notice.group_increase` |
| `ctx.middleware(fn, { priority })` | 注册中间件；调用 `next()` 才继续处理 |
| `ctx.command(declaration)` | 注册命令并链式设置选项、权限和 action |
| `ctx.match(pattern, handler, options)` | 按字符串、正则或函数匹配消息 |
| `ctx.route(app => ...)` | 注册插件的 Hono HTTP 路由，插件卸载时回收 |
| `ctx.cron`、`ctx.interval`、`ctx.timeout` | 注册定时任务 |
| `ctx.store`、`ctx.db`、`ctx.migrate(steps)` | 插件独立 KV、共享 SQLite 句柄、按插件版本管理的迁移 |
| `ctx.bot(selfId?)`、`ctx.bots` | 查找在线 Bot、列出 Bot；找不到在线 Bot 时 `ctx.bot()` 抛错 |
| `ctx.dataDir`、`ctx.signal`、`ctx.onDispose(fn)` | 插件数据目录、卸载信号、自定义清理函数 |

观察者、命令、中间件、匹配器和定时任务随插件卸载自动回收。事件处理器应配合 `signal` 取消耗时操作；插件代码仍运行在主进程中。

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

命令路径在参数之前，例如 `plugin reload <name>`；最长路径优先。另行声明 `ctx.command('tool info')` 即可注册子命令，别名也可以是完整路径。`<name:type>` 表示必填，`[name:type]` 表示可选，`[name:integer=3]` 表示有默认值；省略类型时为 `string`。类型包括 `string`、`number`、`integer`、`boolean`、`user`、`duration`、`image` 和 `rest`：`user` 接受数字 ID 或 @用户并返回 ID 字符串，`image` 接受图片段，`duration` 返回毫秒数，`rest` 返回保留非文本段的消息数组，只能放在最后。

选项支持 `-n 2`、`--times 2`、`--times=2`；无参数选项可声明为 `.option('silent', '-s, --silent')`。选项与普通位置参数可以交错，但一旦开始读取 `rest`，之后都视为内容；`--` 也会结束选项解析。命令路径和别名区分大小写。action 返回字符串或消息段时，框架会发送它；返回 `undefined` 则不自动发送。

### Session、多轮对话、权限与冷却

`session.send(content)` 向当前会话发消息；`session.reply(content, { quote, at })` 默认引用原消息，可以关闭引用或在群内 @发送者。内容可为字符串、消息段或消息段数组，使用 `seg` 创建消息段。字符串按纯文本处理。

```ts
import { definePlugin } from 'asabot'

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

迁移按插件记录已执行版本，只执行新增步骤；约定表名以 `p_<插件名>_` 开头。`session` 在上例中来自命令或事件处理器。

定时任务可以用 `ctx.cron('0 9 * * *', fn)`、`ctx.interval('10m', fn)` 或 `ctx.timeout('30s', fn)`。插件卸载时自动停止，同一任务上次尚未结束时会跳过本次，任务异常会记录日志。

### 按群开关与热重载

群主、群管理员或超管可在群内发送 `/plugin off echo` 和 `/plugin on echo`，只影响当前平台和群；该插件的观察者、中间件、命令和匹配器都会受开关影响。全局启停由超管使用 `/plugin disable echo` 和 `/plugin enable echo`。

默认在非 production 环境监听插件目录，修改入口及其相对导入的文件后自动重载；也可用 `/plugin reload <name>` 手动重载。新代码导入失败时旧实例继续运行；删除入口文件会卸载插件并将其从列表中移除，依赖它的插件进入 failed 状态，入口恢复后自动重新协调。Node 的 ESM 缓存不能清除，频繁热重载会保留旧模块并逐渐增加内存占用，长时间开发后可重启进程。

### 测试插件

`asabot/testing` 的 `createTestApp` 使用真实 WS 连接本地 MockOneBot 和临时数据库。下面的测试对应上面的 `plugins/hello.ts`：

```ts
import { createTestApp } from 'asabot/testing'
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

`say` 默认模拟群 `10` 中用户 `20` 的消息，可传 `{ group: '11', user: '21', role: 'admin' }`，或用 `{ group: null }` 模拟私聊。返回值是本次发送内容的数组；测试结束调用 `dispose()`。也可传 `pluginDirs` 加载目录、传 `config` 覆盖配置，使用 `t.app` 和 `t.mock` 检查状态或模拟其他 OneBot 事件。上述最小插件和多轮对话示例均由仓库中的测试实际运行。

项目检查命令：`pnpm typecheck`、`pnpm lint`、`pnpm test`。
