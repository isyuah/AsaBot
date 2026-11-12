# AsaBot 设计规格

> 本文档是实现的权威依据。实现中若发现设计缺陷，先在 STATUS.md 记录问题与建议，不要静默偏离。

## 1. 目标与非目标

**目标**
- 平台无关的机器人框架核心，首个适配器为 OneBot 11（对接 NapCat）。
- 核心能力完整可靠：事件分发、命令系统、多轮会话、权限、插件（含热重载）、存储、定时任务、错误隔离、优雅退出、多账号。
- 第二期：反向 WS、发送队列、对外 HTTP API、Web 管理面板、Docker 部署、终端沙盒。

**非目标（v1）**
- 外部进程插件协议；ORM；多实例集群；同群多 Bot 的消息去重。

## 2. 技术栈与硬性约束

| 项 | 选择 |
|---|---|
| 运行时 | Node.js ≥ 24，ESM（`"type": "module"`），**直接运行 .ts**（原生类型剥离），无构建步骤 |
| 包管理 | pnpm（根为后端；第二期 `web/` 作为 workspace 包） |
| WebSocket | `ws`（客户端与服务端统一使用；需要 ping/pong 控制） |
| 校验 | `zod`（v4） |
| 配置 | `yaml`（eemeli/yaml，Document API 支持保留注释写回） |
| 日志 | `pino`（开发时 `pino-pretty`） |
| 定时 | `croner` |
| 存储 | `node:sqlite`（`DatabaseSync`），封装在 `src/core/storage/` 内，可替换 |
| HTTP（M5） | `hono` + `@hono/node-server` |
| 测试 / 检查 | `vitest`；`tsc --noEmit`；`@biomejs/biome` |

**代码约束（Node 类型剥离要求，必须遵守）**
- 只用可擦除语法：禁止 `enum`、`namespace`、构造函数参数属性、`import x = require()`。tsconfig 开启 `erasableSyntaxOnly`、`verbatimModuleSyntax`。
- 相对导入必须写 `.ts` 后缀；仅类型导入必须用 `import type`。
- 用户插件通过包自引用导入框架：`import { definePlugin, z, seg } from 'asabot'`（`package.json` 的 `exports` 指向 `./src/index.ts`）。zod 必须从 `asabot` 再导出，保证单实例。
- 依赖通过 `pnpm add` 安装，不手写版本号、不手改 lockfile。

## 3. 目录结构

```
src/
  index.ts                 # 公共 API 出口（插件作者唯一入口）
  main.ts                  # 进程入口：加载配置 → 创建 App → 启动 → 信号处理
  core/
    app.ts                 # App：组装与生命周期
    config/                # schema、加载、${ENV} 插值、注释保留写回
    logger.ts              # pino 实例、脱敏、环形缓冲
    message/               # Segment 类型、seg 构造器、CQ 码互转、纯文本提取
    event/                 # 统一事件模型、Session
    bot.ts                 # Bot 接口与注册表
    adapter.ts             # Adapter 接口与 AdapterHost
    dispatch/              # 管线：过滤 → 观察者 → 中间件 → prompt → 命令 → 匹配器
    command/               # 声明解析、tokenizer、参数类型、执行、帮助生成
    permission.ts          # Rule 与内置规则、组合子
    ratelimit.ts           # 冷却
    plugin/                # definePlugin、Context、PluginManager、加载器、热重载钩子
    storage/               # SQLite 封装、KV、迁移、插件状态
    scheduler.ts           # cron / interval / timeout（绑定 Context 生命周期）
    utils/                 # duration 解析、id、abort 工具等
  adapters/onebot11/       # 连接、API 封装与类型、事件转换、消息段转换
  plugins/                 # 内置插件：help、status、admin
  testing/                 # MockOneBot 服务端、createTestApp（以 'asabot/testing' 导出）
plugins/                   # 用户插件目录（热重载）
test/                      # 跨模块集成测试
docs/
```

**依赖方向**：`core` 不得导入 `adapters/*`、`plugins/*`、`server/*`。适配器只依赖 `core` 的公共接口。

## 4. 配置

文件 `asabot.config.yaml`（git 忽略；仓库提交 `asabot.config.example.yaml`）。启动时自动加载 `.env`（若存在）。

- 字符串标量支持 `${VAR}` 与 `${VAR:-default}` 插值；变量缺失且无默认值 → 启动失败并指出变量名与配置路径。
- 整体用 zod 校验；失败时输出可读的路径化错误，例如 `onebot11.connections[0].url: Invalid URL`。
- 时长字段接受 `'10s' | '5m' | '1h30m' | '1d'` 或毫秒数。
- **写回**（M3 起）：基于 `yaml` 的 Document AST 修改指定路径，保留注释与 `${VAR}` 原文，原子写入（写临时文件后 rename）。

```yaml
logLevel: info              # trace|debug|info|warn|error
dataDir: ./data
superusers: ['10001']       # 平台用户 ID（字符串）

command:
  prefixes: ['/']
  mentionAsPrefix: true     # 群聊中 @机器人 后可不带前缀
  privateRequirePrefix: false
  replyOnError: true        # 命令异常时回复通用错误提示（不含内部细节）
  replyOnDenied: true

dispatch:
  handlerTimeout: 10m       # 单次处理硬上限，超时触发 abort
  ignoreSelf: true          # 忽略机器人自身发出的消息（OneBot message_sent）
  promptTimeout: 60s        # session.prompt 默认超时
  maxPromptTimeout: 30m

onebot11:
  apiTimeout: 30s
  reconnect: { minDelay: 1s, maxDelay: 60s }
  connections:
    - type: forward
      url: ws://127.0.0.1:3001
      accessToken: ${NAPCAT_TOKEN:-}
  # 第二期：reverse 连接由 server 提供 /onebot/v11/ws
  sendQueue: { interval: 500ms, jitter: 300ms }   # M4

pluginLoader:
  dirs: [./plugins]
  hotReload: auto           # auto = NODE_ENV 不为 production 时开启

plugins:                    # 插件名 → 条目；内置插件同样在此配置
  echo:
    enabled: true           # 默认 true
    config: { maxLen: 200 }

server:                     # M5
  host: 127.0.0.1
  port: 5140
  apiToken: ${ASABOT_API_TOKEN:-}     # 为空则不启用对外 API
  panelPassword: ${ASABOT_PANEL_PASSWORD:-}   # 为空则不启用面板
```

## 5. 消息模型

```ts
type Segment =
  | { type: 'text'; data: { text: string } }
  | { type: 'at'; data: { qq: string } }            // qq 为 'all' 表示全体
  | { type: 'face'; data: { id: string } }
  | { type: 'image'; data: { file: string; url?: string; summary?: string; subType?: number } }
  | { type: 'record'; data: { file: string; url?: string } }
  | { type: 'video'; data: { file: string; url?: string } }
  | { type: 'reply'; data: { id: string } }
  | { type: 'file'; data: { file: string; name?: string } }
  | { type: 'json'; data: { data: string } }
  | { type: 'forward'; data: { id: string } }
  | { type: string; data: Record<string, unknown> }  // 未知类型原样保留

type Message = Segment[]
type Sendable = string | Segment | Segment[]
```

- **字符串一律视为纯文本**，不解析 CQ 码（防注入）。需要 CQ 码时显式调用 `parseCQ(str)`。
- `seg.text / at / atAll / face / image / record / video / reply / file / json`。
- `seg.image(src)`：`src` 可为 Buffer、本地路径、`file://`、`http(s)://` 或 `base64://`。Buffer 和本地路径默认转为 `base64://`，因为 NapCat 常跑在容器里，读不到宿主机路径。
- `toCQ(message)` / `parseCQ(str)` 双向转换，需正确转义 `& [ ] ,`。
- `plainText(message)`：拼接所有 text 段。

## 6. 统一事件模型

所有 ID 在 core 层是**字符串**（平台无关）；适配器负责转换。

```ts
interface BaseEvent {
  id: string                       // 框架生成的唯一 ID
  platform: string                 // 'onebot11'
  selfId: string
  time: number                     // ms
  kind: 'message' | 'notice' | 'request' | 'meta' | 'internal'   // internal：框架自身派发的事件
  name: string                     // 分层事件名，见下
  raw: unknown                     // 原始平台数据
  bot: Bot
}
```

**分层事件名**：派发 `notice.notify.poke` 时，`notice`、`notice.notify`、`notice.notify.poke` 三级的监听器都会触发。

| 名称 | 说明 |
|---|---|
| `message.private` / `message.group` | 消息（对应 `Session`） |
| `notice.<notice_type>[.<sub_type>]` | 沿用 OneBot 命名，如 `notice.group_increase`、`notice.group_recall`、`notice.notify.poke`、`notice.group_ban.ban` |
| `request.friend` / `request.group.add` / `request.group.invite` | 请求，带 `approve(remark?)` / `reject(reason?)` |
| `meta.lifecycle` / `meta.heartbeat` | 元事件 |
| 框架内部：`bot.online` / `bot.offline` / `plugin.state` / `message.sent` | 框架自身派发 |

`ctx.on` 的事件名到事件类型通过 `EventMap` 获得精确类型；OneBot 已知 notice 需列出字段，未知 notice 退化为通用 `NoticeEvent`（包含 `noticeType`、`subType?`、`userId?`、`groupId?`、`operatorId?`）。

**Session（消息事件）**

```ts
interface Session extends BaseEvent {
  kind: 'message'
  messageType: 'private' | 'group'
  messageId: string
  userId: string
  groupId?: string                 // 群消息必有
  channelKey: string               // `${platform}:${selfId}:${private|group}:${id}`
  message: Message                 // 原始消息段
  text: string                     // plainText(message)
  sender: { userId: string; nickname: string; card?: string; role?: 'owner' | 'admin' | 'member' }
  toMe: boolean                    // 私聊恒 true；群聊 @自身 或 回复了自身消息
  isSuperuser: boolean
  send(content: Sendable): Promise<SendResult>          // 发到当前会话
  reply(content: Sendable, opts?: { quote?: boolean; at?: boolean }): Promise<SendResult>  // quote 默认 true
  prompt(text?: Sendable, opts?: { timeout?: Duration; scope?: 'user' | 'channel'; filter?: (s: Session) => boolean }): Promise<Session | null>
}
```

- `toMe` 判定“回复了自身消息”时，优先查最近发送的消息 ID 缓存（LRU，容量 1000）；未命中时不额外调用 API。
- 解析命令前，从消息开头去掉回复段和 @自身段，再去掉前导空白。

## 7. Bot 与适配器

```ts
interface Bot {
  readonly platform: string
  readonly selfId: string
  readonly status: 'connecting' | 'online' | 'offline'
  sendPrivate(userId: string, content: Sendable): Promise<SendResult>
  sendGroup(groupId: string, content: Sendable): Promise<SendResult>
  deleteMessage(messageId: string): Promise<void>
  getSelf(): Promise<UserInfo>
  getGroupList(): Promise<GroupInfo[]>
  getGroupMember(groupId: string, userId: string): Promise<GroupMemberInfo>
  getFriendList(): Promise<UserInfo[]>
  call(action: string, params?: Record<string, unknown>): Promise<unknown>  // 透传平台 API
}
type SendResult = { messageId: string }

// OneBot 专属能力
interface OneBotBot extends Bot { readonly onebot: OneBotApi }   // 带类型的常用 action 封装
function isOneBot(bot: Bot): bot is OneBotBot
```

```ts
interface Adapter { readonly platform: string; start(): Promise<void>; stop(): Promise<void> }
interface AdapterHost {
  logger: Logger
  emit(event: AnyEvent): void          // 交给 dispatch
  registerBot(bot: Bot): void
  unregisterBot(bot: Bot): void
}
```

`start()` 只负责发起连接，不等待上线；连接失败不抛出，而是进入重连。

**组装位置**：`core` 不能导入适配器，所以由 `src/bootstrap.ts` 中的 `createApp(config, { logger? })` 负责组装：创建 App，再按配置实例化 OneBot 适配器并调用 `app.useAdapter(adapter)`；M3 起还负责注册内置插件。`main.ts` 和 `src/testing` 都通过 `createApp` 获取完整的 App。`AdapterHost` 由 App 实现，并额外提供 `isSuperuser(userId): boolean`，供适配器在构造 Session 时使用。

**Bot 的生命周期**
- 同一个 selfId 只对应一个 Bot 实例，断线和重连都不会更换实例，保证插件手里的 Bot 引用一直有效。
- 断线时 status 变为 `offline` 并派发 `bot.offline`，但 Bot 仍留在注册表中；重连成功后 status 变为 `online` 并派发 `bot.online`。
- 重连后 `get_login_info` 返回的 selfId 和之前不同（换号了）时，注销旧 Bot，再注册新 Bot。
- 两条连接登录了同一个账号时，先上线的连接占有这个 Bot；后上线的连接登录失败，记录 warn 日志并按退避策略继续重试。这样第一条连接断开后，第二条会自动接管，起到故障转移的作用。
- `app.stop()` 时注销所有 Bot。

**事件总线**（M1 先提供，M2 在此基础上扩展成完整管线）：`app.events.on(name, listener)` 返回 disposer。按第 6 节的分层名称匹配；所有命中的监听器通过 `Promise.allSettled` 并发执行，异常带上事件名记录日志。签名利用 `EventMap` 提供精确类型。

**出站媒体的规范化**
- `seg.image(buffer)` 在构造时同步转成 `base64://`。
- `seg.image('/abs/path')` 和 `seg.image('file:///...')` 先原样保存为 `file://` URL，由 OneBot 适配器在发送前异步读取文件并转成 `base64://`。原因是 NapCat 通常运行在容器里，读不到宿主机的路径。文件读取失败时，发送调用以带路径信息的错误 reject。
- `http(s)://` 和 `base64://` 原样透传。
- record、video、file 段与 image 规则相同。

## 8. OneBot 11 适配器

**正向 WS 连接状态机**：`connecting → open → online → (closed) → 退避重连`
- 鉴权：发送 `Authorization: Bearer <token>` 头。日志中的 URL 必须去掉 `access_token`，任何日志都不得输出 token。
- 连接打开后调用 `get_login_info` 得到 selfId 和昵称，然后注册 Bot 并派发 `bot.online`。
- 重连：指数退避加抖动，从 `minDelay` 到 `maxDelay`；连接稳定 30s 后重置退避。`stop()` 后不再重连，并以 code 1000 关闭。
- 活性检测：每 30s 发一次 ws ping，10s 内无 pong 则 terminate 并重连。另外，收到过 OneBot heartbeat 后，若超过 2.5 倍 heartbeat 周期没有收到任何消息，同样判定断线。上述时间参数要能通过适配器构造选项注入（不进入用户配置），方便测试用很短的间隔。
- `onebot11.apiTimeout`（默认 30s）和 `onebot11.reconnect.{minDelay,maxDelay}`（默认 1s 和 60s）在 M1 加入配置 schema。

**API 调用**
- 请求 `{ action, params, echo }`，echo 为连接内递增的唯一字符串。
- 响应用 echo 配对；超时（`apiTimeout`）抛 `ApiTimeoutError`。连接断开时立即 reject 所有挂起请求（`NotConnectedError`）。离线时调用直接 reject，不排队（M4 的发送队列也只排队、不跨断线缓存）。
- `status === 'failed'` 或 `retcode !== 0` 时抛 `ApiError { action, retcode, message, wording }`。

**入站帧**：有 `post_type` 的是事件；否则有 `echo` 的是 API 响应；其他帧记 debug 日志后丢弃。JSON 解析失败记 warn，不断开连接。
- 消息同时兼容 `array` 和 `string`（CQ 码）两种格式。
- `post_type: message_sent` 在 `ignoreSelf` 开启时丢弃。
- 数字 ID 转字符串；发送时字符串转数字。
- 发出的消息 ID 写入 toMe 缓存，并派发 `message.sent` 内部事件。

**OneBotApi 首批封装**：`sendPrivateMsg`、`sendGroupMsg`、`deleteMsg`、`getMsg`、`getLoginInfo`、`getVersionInfo`、`getStrangerInfo`、`getFriendList`、`getGroupInfo`、`getGroupList`、`getGroupMemberInfo`、`getGroupMemberList`、`setGroupBan`、`setGroupWholeBan`、`setGroupKick`、`setGroupCard`、`setGroupAdmin`、`setGroupSpecialTitle`、`setFriendAddRequest`、`setGroupAddRequest`、`sendGroupForwardMsg`、`sendPrivateForwardMsg`、`groupPoke`、`friendPoke`（NapCat 扩展）。

## 9. 分发管线

一条事件的处理流程：

```
adapter.emit(event)
  → [过滤] 黑名单 / 白名单（框架内置，不可绕过）
  → [观察者] 所有匹配事件名的 ctx.on 监听器并发执行（Promise.allSettled），不可阻断
  → 仅消息事件继续：
     [中间件] ctx.middleware(fn, { priority })，koa 风格 (session, next)；不调 next 即终止后续处理
       → [prompt 拦截] 命中等待中的 prompt：解析该 prompt 并结束
       → [命令] 匹配到命令就执行，消息被消费
       → [匹配器] ctx.match(pattern, handler, { priority, block = true })，按优先级降序执行所有命中项，block 的会终止更低优先级
```

- **按群插件开关**：插件在某群被关闭后，它在该群的观察者、中间件、命令、匹配器都会被跳过。
- **错误隔离**：每个处理函数单独 try/catch。异常日志包含插件名、事件 ID、事件名；命令异常时按 `replyOnError` 回复通用提示。
- **取消**：每次调用处理函数都会拿到一个 `AbortSignal`，在以下情况被中止：插件卸载、框架退出、超过 `handlerTimeout`。`session.prompt` 在中止时以 `AbortError` reject，处理器包装层对 `AbortError` 静默处理。
- **并发**：不同事件并发处理，框架不保证同一会话内的处理顺序。
- **prompt**：
  - 默认作用域为同一用户在同一 `channelKey`；`channel` 作用域表示该会话里任何人的消息都算。
  - 被 prompt 消费的消息不会进入命令和匹配器，但观察者照常收到。
  - 超时返回 `null`。
  - 同一作用域同时只允许一个 prompt：新 prompt 会让旧 prompt 以 `null` 结束。

### 9.1 实现约定（M2）

**注册作用域**：插件系统要到 M3 才有，所以 M2 的分发器以“作用域”为单位注册所有内容，M3 的 `ctx` 只是在这层上包一层薄封装。
```ts
interface Scope { owner: string; signal?: AbortSignal }   // owner：插件名，框架自身用 'core'；signal：owner 生命周期结束时 abort
dispatcher.on(scope, name, listener)               → Disposer
dispatcher.middleware(scope, fn, { priority? })    → Disposer
dispatcher.command(scope, decl)                    → CommandBuilder（可链式调用，另有 .dispose()）
dispatcher.match(scope, pattern, handler, opts?)   → Disposer
```
- 当 `scope.signal` 已经 abort 时，注册会被拒绝。signal 在之后 abort 时，该作用域下的所有注册自动注销。
- 原来的 `app.events` 并入分发器，成为观察者阶段。
- 同一阶段内的执行顺序：先按 priority 降序，priority 相同时按注册顺序。

**钩子**（M2 提供默认实现，M3 替换成基于存储的实现）
- `accessFilter(event) → boolean`：黑白名单。默认全部放行。只作用于带 userId 的事件；超管永远放行。
- `isEnabledFor(owner, event) → boolean`：按群开关。默认始终为 true。被关闭的 owner 在该事件中的所有处理器都会被跳过。

**执行模型**
- 观察者阶段以“发出后不等待”的方式启动，消息管线同时开始执行，两者互不阻塞。`dispatcher.dispatch(event)` 返回的 Promise 在两者都结束后才 resolve，方便测试使用。
- 内部事件、meta 事件只经过观察者阶段。

**处理器上下文与取消**
- 每次调用处理器时，会合成一个 signal：`AbortSignal.any([scope.signal, app 退出信号, AbortSignal.timeout(handlerTimeout)])`。
- 处理器拿到的是 **绑定了这个 signal 的 session 视图**：一个浅拷贝的对象，其中 `prompt` 已绑定该 signal。这样插件卸载时，它正在等待的 prompt 会自动 reject。
- 处理器包装层的错误处理：
  - 异常由 signal 中止引起（`signal.aborted` 且错误是 `signal.reason`，或者名称为 AbortError/TimeoutError）时，不记 error。只有超时的情况记一条 warn，内容为“处理器超时”，并附上 owner 和事件名。
  - 其他异常记 error。

**prompt 的注入**
- `Session.prompt` 依赖分发器，但 Session 是适配器构造的。因此 AdapterHost 增加 `sessionServices`（由 App 实现），适配器把它传给 `createSession`，Session 的 `prompt` 再委托给它。适配器本身完全不感知 prompt 的存在。
- `timeout` 的默认值取 `dispatch.promptTimeout`，上限为 `dispatch.maxPromptTimeout`。

**返回值约定**：命令 action 和 matcher handler 返回 `Sendable` 时，框架用 `session.send` 发出，不引用原消息。需要引用时，由插件自己调用 `session.reply`。

**框架内置的提示文本**（如权限不足、冷却中、参数错误、执行出错）集中放在 `src/core/dispatch/messages.ts`，方便以后做成可配置。

## 10. 命令系统

```ts
ctx.command('echo <text:rest>')
  .alias('复读')
  .description('复读一段文本')
  .option('times', '-n, --times <n:integer>', { default: 1, description: '次数' })
  .option('silent', '-s, --silent')
  .permission('group.admin')          // 字符串简写或 Rule
  .cooldown('10s', { scope: 'user' }) // user | group | global
  .scope('group')                     // group | private | all（默认 all）
  .hidden()
  .example('/echo 你好')
  .action(async ({ session, args, options, signal }) => { return args.text })
```

- **声明语法**：参数之前的裸词构成命令路径，`'plugin reload <name>'` 的路径是 `['plugin', 'reload']`。匹配时取最长路径。`/help plugin` 会列出它的子命令。
- **参数**：`<name:type>` 必填，`[name:type=default]` 可选；只有最后一个参数可以是 `rest`，它取剩余原文（保留非文本段）。
- **类型**：`string`（默认）、`number`、`integer`、`boolean`、`user`（at 段或纯数字，结果为 userId 字符串）、`duration`（毫秒数）、`image`（image 段）、`rest`。
- **分词**：按空白切分，支持 `"..."` 和 `'...'` 引号；每个非文本段单独成为一个 token。
- **类型推断**：`args` 和 `options` 的类型从声明字符串推断（模板字面量类型）。运行时必须做校验，类型推断只是开发体验上的增强。
- **触发规则**：
  - 消息以任一前缀开头时，尝试匹配命令。
  - 群聊中 `toMe` 且 `mentionAsPrefix` 开启时，可以不带前缀。
  - 私聊中 `privateRequirePrefix` 为 false 时，可以不带前缀。
  - 不带前缀时只匹配命令名和别名，匹配不上就交给匹配器。
- **返回值**：action 的返回值（`Sendable`）通过 `session.send` 发出；返回 `undefined` 则不发。
- **选项解析**：支持 `--key value`、`--key=value`、`-k value`，布尔选项写 `-s` 或 `--silent`。选项可以和位置参数交错出现。一旦开始解析 `rest` 参数，或遇到 `--`，后面的内容都按字面处理，不再识别为选项。未知选项报参数错误。
- **命令名匹配**：精确匹配，区分大小写。别名只替换路径的最后一段，例如给 `plugin reload` 加别名 `重载插件`，就能用 `/重载插件 <name>` 调用。
- **只有子命令的路径**：例如 `/plugin` 本身没有 action，但有子命令时，回复它的子命令列表。
- **帮助数据**：提供 `formatUsage(command)` 和 `listCommands(session)`。后者按 scope、权限、hidden 以及按群开关过滤，供 M3 的 help 插件使用。
- **错误提示**：参数错误时回复简短原因和用法，例如 `缺少参数 <text>。用法：/echo <text>`。带前缀但命令未知时默认不回复，因为群里可能有别的机器人。
- **冲突检测**：命令路径或别名冲突时，后注册的插件加载失败，错误信息中写明冲突对象。

## 11. 权限与冷却

- `type Rule = (session: Session) => boolean | Promise<boolean>`
- 内置规则：`perm.superuser`、`perm.groupOwner`、`perm.groupAdmin`（包括群主）、`perm.group`、`perm.private`；组合子 `perm.and / or / not`。
- 字符串简写：`'superuser' | 'group.owner' | 'group.admin'`。
- 超管通过所有内置角色检查。角色取自 `sender.role`。
- 权限不足时，按 `replyOnDenied` 回复 `权限不足`。
- 冷却按 命令 × 作用域键 在内存中计时。作用域键：`user` 为 `platform:userId`（跨群共享），`group` 为 `channelKey`，`global` 为命令本身。冷却期间只在第一次被拦截时回复 `冷却中，剩余 Ns`，之后静默。超管不受冷却限制。
- 黑名单和白名单存 SQLite，由 admin 插件管理。白名单为空表示不启用。

## 12. 插件系统

```ts
export default definePlugin({
  name: 'echo',                  // /^[a-z0-9][a-z0-9_-]*$/，全局唯一
  version: '1.0.0',
  description: '复读',
  config: z.object({ maxLen: z.number().default(200) }),  // 可选
  depends: [],                   // 依赖的插件名；用于决定加载顺序，以及级联重载和停用
  setup(ctx) { /* 注册资源；可以是 async */ },
})
```

**发现规则**：在 `pluginLoader.dirs` 下查找 `<name>.ts` 或 `<name>/index.ts`，入口文件必须默认导出 `definePlugin(...)` 的结果。内置插件静态注册，同样能在 `plugins:` 中配置或禁用。

**Context**（所有注册都返回一个 disposer，并在插件卸载时自动回收）

| API | 说明 |
|---|---|
| `ctx.name` / `ctx.config` / `ctx.logger` | 插件名、类型化配置（只读）、带插件名的子 logger |
| `ctx.on(name, listener)` | 观察者 |
| `ctx.middleware(fn, { priority })` | 中间件 |
| `ctx.command(decl)` | 命令 |
| `ctx.match(pattern, handler, opts)` | pattern 可为 `string`（包含）、`RegExp` 或 `(s) => boolean` |
| `ctx.cron(expr, fn)` / `ctx.interval(d, fn)` / `ctx.timeout(d, fn)` | 定时任务。异常会被捕获并记录日志；同一任务上一次未执行完时跳过本次 |
| `ctx.store` | 插件独立命名空间的 KV：`get<T>(k)`、`set(k, v, { ttl? })`、`delete(k)`、`keys(prefix?)`；值为 JSON |
| `ctx.db` / `ctx.migrate(steps: string[])` | 共享 SQLite 句柄；按插件记录迁移版本，只执行新增的步骤。表名约定为 `p_<plugin>_*` |
| `ctx.bot(selfId?)` / `ctx.bots` | 获取 Bot。不传 selfId 时返回第一个在线的，没有在线 Bot 则抛 `NoBotOnlineError` |
| `ctx.dataDir` | `data/plugins/<name>/`，首次访问时创建 |
| `ctx.signal` / `ctx.onDispose(fn)` | 插件卸载时 abort；登记自定义清理逻辑 |
| `ctx.route(...)` | M5：挂载 `/plugins/<name>/*` HTTP 路由 |

**生命周期与状态**：`loading → active | failed`，`active → disposing → disabled`。setup 失败（抛异常、配置校验失败、命令冲突、依赖缺失）时，回收它已注册的资源，标记为 `failed` 并记录原因，其他插件不受影响。卸载按依赖的逆序进行。

**PluginManager**（供 admin 插件和面板使用）：`list()`、`get(name)`、`enable(name)`、`disable(name)`、`reload(name)`、`setGroupEnabled(name, groupKey, enabled)`、`isEnabledFor(name, session)`。全局开关写回 YAML 的 `plugins.<name>.enabled`；按群开关存 SQLite。

**热重载**（已验证可行）
- 通过 `module.registerHooks` 注册 resolve 钩子：凡是落在插件目录下的模块 URL，都加上 `?v=<version>`，并把版本号传给它内部的相对导入。插件目录以外的模块（包括 `asabot` 自身）不加版本号，保持单例。
- 重载顺序：先用新版本号 import（若失败，例如语法错误，旧实例继续运行并报告错误）→ 卸载旧实例 → 用新模块执行 setup。依赖它的插件级联重载。
- 用 `fs.watch(dir, { recursive: true })` 监听变化，防抖 300ms，按文件所在的顶层入口定位到插件。`hotReload: auto` 在非 production 环境开启；手动重载随时可用。
- 已知代价：ESM 缓存无法清除，每次重载会多留一份旧模块的内存，需在文档中说明。

## 13. 存储

- 数据库文件 `data/asabot.db`，开启 WAL。
- 框架表：`kv(plugin, key, value, expires_at)`、`migrations(plugin, version)`、`plugin_group_state(plugin, group_key, enabled)`、`access_list(kind, user_key)`。
- KV 过期：读取时惰性删除，另有定期清扫。
- 插件代码是受信任的进程内代码，`ctx.db` 直接暴露句柄，命名规范只是约定。

## 14. 日志与错误

- 使用 pino。开发环境输出 pretty 格式，生产环境输出 JSON。
- 内存中保留最近 2000 条日志（供 M5 面板读取和实时推送）。
- 脱敏：pino `redact` 覆盖 `*.accessToken`、`*.token`、`*.password`、`*.apiToken`。
- 收到的消息记 info 摘要：`[group:123] 昵称(456): 文本截断至 200 字`。
- 错误类型：`ConfigError`、`ApiError`、`ApiTimeoutError`、`NotConnectedError`、`NoBotOnlineError`、`PluginError`、`CommandConflictError`。
- `unhandledRejection` 记 error，进程继续运行。`uncaughtException` 记 fatal，执行优雅退出后 `exit(1)`，由外部（如 Docker 重启策略）负责拉起。

## 15. 启动与退出

- 启动：加载配置 → 打开数据库 → 加载插件（按依赖拓扑排序）→ 启动适配器 → 开启热重载监听。
- 退出（SIGINT/SIGTERM）：停止接收事件 → abort 所有进行中的处理（宽限 5s）→ 按逆序卸载插件 → 停止适配器 → 关闭数据库 → 退出。再收到一次信号则强制退出。

## 16. 测试策略

遵循 CLAUDE.md 的测试哲学：测稳定的契约，不测实现细节和平凡行为。

- **`src/testing/`**（对外导出为 `asabot/testing`，插件作者也能用）：
  - `MockOneBot`：一个 WS 服务端（端口 0），能够：
    - 校验 token；
    - 推送 lifecycle 和 heartbeat 事件；
    - 为常用 action 提供默认响应，也可以用 `onCall(action, handler)` 覆盖；
    - 记录所有调用（`calls`），提供 `waitForCall(action, pred?, timeout?)`；
    - 模拟收到消息：`emitGroupMessage({ groupId, userId, message, role?, nickname? })`、`emitPrivateMessage(...)`、`emitNotice(raw)`、`push(raw)`；
    - 模拟故障：`dropConnections()`、`setHeartbeat(on|off)`、`close()`。
  - `createTestApp({ config?, plugins })`：启动 App 并连上 MockOneBot。返回 `{ app, mock, say(text|segments, { group?, user?, role? }) → 机器人的回复列表, dispose() }`。
- **重点覆盖**：
  - API 调用的 echo 配对和超时，断线时挂起请求被 reject；
  - 重连退避，以及心跳或 ping 超时触发的重连；
  - 命令声明解析、分词、参数类型校验与错误提示；
  - 前缀、@ 和私聊的触发规则；
  - 管线顺序：中间件阻断、prompt 消费、匹配器的优先级和 block；
  - prompt 超时与 abort；
  - 插件 setup 失败时的隔离与资源回收；
  - 卸载后资源确实回收（命令、监听器、定时器都失效）；
  - 热重载：重载后行为更新；语法错误时旧实例保留；
  - 权限与冷却；
  - 配置插值的缺失与默认值，以及校验错误的路径；
  - YAML 写回时保留注释和 `${VAR}`；
  - CQ 码转义的往返一致性；
  - KV 的 TTL；迁移的幂等性。
- **端到端**：用 `createTestApp` 加载示例插件，模拟群里发 `/echo hi`，断言发出了 `send_group_msg` 且内容正确。

## 17. 里程碑与验收标准

每个里程碑的验收都要求 `pnpm typecheck`、`pnpm lint`、`pnpm test` 全部通过。

| # | 内容 | 验收 |
|---|---|---|
| M0 | 脚手架（package.json 自引用 exports、tsconfig、biome、vitest、scripts）；配置加载（schema、插值、`.env`）；logger；duration 工具；`main.ts` 骨架（信号处理）；`asabot.config.example.yaml` | `node src/main.ts` 用示例配置能启动并打印启动日志；配置错误时给出路径化报错 |
| M1 | 消息模型、seg、CQ 码；统一事件、Session（send/reply）；Bot 接口与注册表；Adapter 接口；OneBot 正向 WS 适配器（含重连、活性检测、API 封装）；MockOneBot | 连上 MockOneBot 后，`bot.online` 触发；收到群消息时观察者拿到正确的 Session；`session.reply` 发出了正确的 `send_group_msg`；断线后自动重连 |
| M2 | 分发管线（过滤、观察者、中间件、prompt、命令、匹配器）；命令系统；权限；冷却；错误隔离与 abort | 第 16 节中与管线、命令、prompt、权限相关的测试通过 |
| M3 | 插件系统（definePlugin、Context、PluginManager、依赖顺序、按群开关）；热重载；存储（KV、迁移、状态表）；定时任务；YAML 写回；内置插件 help、status、admin；示例插件 `plugins/echo.ts`、`plugins/guess.ts`；`createTestApp`；README（快速开始与插件开发指南） | 端到端测试通过；手动修改示例插件后自动重载生效 |
| M4 | 反向 WS（多账号，校验 X-Self-ID 和 token）；每个账号独立的发送队列 | — |
| M5 | Hono 服务：对外 API（`POST /api/v1/send`、`GET /api/v1/bots`）、面板后端、日志 WS 推送、`ctx.route` | — |
| M6 | React + Vite + shadcn/ui + Tailwind 面板 | — |
| M7 | Dockerfile、包含 NapCat 的 compose、`pnpm sandbox` 终端沙盒、部署文档 | — |
