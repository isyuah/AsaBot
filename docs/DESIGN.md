# AsaBot 设计规格

> 本文档是实现的权威依据。实现中若发现设计缺陷，在交付说明中提出，不要静默偏离。

## 1. 目标与非目标

**目标**
- 协议无关的机器人框架。核心层不认识任何具体协议，协议通过适配器接入。首个适配器是 OneBot 11：任何实现了 OneBot 11 的服务（NapCat、Lagrange.OneBot、LLOneBot 等）都能接入，框架不针对某一个实现做绑定。以后接入 Satori、QQ 官方 Bot、Telegram 等协议时，只需新增适配器，不改核心。
- 核心能力完整可靠：事件分发、命令系统、多轮会话、权限、插件（含热重载）、存储、定时任务、错误隔离、优雅退出、多账号。
- 第二期：反向 WS、发送队列、对外 HTTP API、Web 管理面板、Docker 部署、终端沙盒。

**非目标（v1）**
- 外部进程插件协议；ORM；多实例集群；同群多 Bot 的消息去重。

### 1.1 协议无关原则

- `src/core/**`、`src/server/**`、`src/plugins/**`（内置插件）和 `web/` 不得出现任何协议专属的类型、字段名、文本格式或假设，例如 OneBot 的 action 名、CQ 码、`qq` 字段，或“用户 ID 是纯数字”这类假设。
- 协议专属的能力只存在于对应的适配器目录中，以包的子路径导出：`import { isOneBot, parseCQ } from 'asabot/onebot11'`。插件确实需要平台专属能力时，显式从子路径导入，并用类型守卫判断。
- 用户、群、消息的 ID 在框架内都是不透明的字符串，只有适配器知道它们的格式。
- 面板和文档的措辞使用“用户 ID / 群 ID / 聊天平台 / OneBot 实现”，不写“QQ 号”或“NapCat”（介绍 OneBot 实现时，NapCat 只作为例子之一出现）。

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

- `adapters` 段：核心 schema 只把它当作 `Record<string, unknown>`，每个适配器在注册表中提供自己的 zod schema 并校验自己那一段，错误路径带上 `adapters.<name>.` 前缀。出现未注册的适配器名时报错，并列出可用的适配器。
- 字符串标量支持 `${VAR}` 与 `${VAR:-default}` 插值；变量缺失且无默认值 → 启动失败并指出变量名与配置路径。
- 整体用 zod 校验；失败时输出可读的路径化错误，例如 `onebot11.connections[0].url: Invalid URL`。
- 时长字段接受 `'10s' | '5m' | '1h30m' | '1d'` 或毫秒数。
- **写回**（M3 起）：基于 `yaml` 的 Document AST 修改指定路径，保留注释与 `${VAR}` 原文，原子写入（写临时文件后 rename）。

```yaml
log:
  level: info               # trace|debug|info|warn|error；面板上可以临时调整，重启后恢复为这里的值
  file:                     # 可选：写入日志文件，按大小轮转
    path: ./data/logs/asabot.log
    maxSize: 10MB
    maxFiles: 5
timezone: Asia/Shanghai     # IANA 时区；cron 和“今日”统计都按它计算。省略时取环境变量 TZ，再没有就用系统时区
dataDir: ./data
superusers: ['10001']       # 平台用户 ID（字符串）

command:
  prefixes: ['/']
  mentionAsPrefix: true     # 群聊中 @机器人 后可不带前缀
  privateRequirePrefix: false
  replyOnError: true        # 命令异常时回复通用错误提示（不含内部细节）
  replyOnDenied: true

dispatch:
  handlerTimeout: 1h        # 单次处理的安全上限（包含其中等待 prompt 的时间），超时触发 abort
  ignoreSelf: true          # 忽略机器人自身发出的消息（OneBot message_sent）
  promptTimeout: 60s        # session.prompt 默认超时
  maxPromptTimeout: 30m

adapters:                   # 每个键是一个已注册的适配器；配置结构由适配器自己的 schema 定义和校验
  onebot11:
    apiTimeout: 30s
    reconnect: { minDelay: 1s, maxDelay: 60s }
    connections:
      - type: forward
        url: ws://127.0.0.1:3001
        accessToken: ${ONEBOT_TOKEN:-}
    reverse:                  # 配置了这一段才接受反向连接（OneBot 实现主动连 AsaBot），地址为 ws://<server>/onebot/v11/ws
      accessToken: ${ONEBOT_REVERSE_TOKEN:-}
    sendQueue: { interval: 500ms, jitter: 300ms, maxPending: 100 }   # M5

pluginLoader:
  dirs: [./plugins]
  hotReload: auto           # auto = NODE_ENV 不为 production 时开启

plugins:                    # 插件名 → 条目；内置插件同样在此配置
  echo:
    enabled: true           # 默认 true
    config: { maxLen: 200 }

server:                     # M4
  host: 127.0.0.1
  port: 5140
  apiToken: ${ASABOT_API_TOKEN:-}     # 为空则不启用对外 API
  panelPassword: ${ASABOT_PANEL_PASSWORD:-}   # 为空则不启用面板
```

## 5. 消息模型

```ts
type Segment =                                       // 框架自己的消息模型，与任何协议无关
  | { type: 'text'; data: { text: string } }
  | { type: 'at'; data: { id: string } }              // 提及某个用户；id 为 'all' 表示全体
  | { type: 'face'; data: { id: string } }            // 平台表情（id 含义由平台决定）
  | { type: 'image'; data: { file: string; url?: string; summary?: string } }
  | { type: 'audio'; data: { file: string; url?: string } }
  | { type: 'video'; data: { file: string; url?: string } }
  | { type: 'file'; data: { file: string; name?: string } }
  | { type: 'reply'; data: { id: string } }           // 引用某条消息
  | { type: 'forward'; data: { id: string } }         // 平台的合并转发
  | { type: string; data: Record<string, unknown> }   // 平台专属或未知类型，原样保留

type Message = Segment[]
type Sendable = string | Segment | Segment[]
```

- **字符串一律视为纯文本**，不解析 CQ 码（防注入）。需要 CQ 码时显式调用 `parseCQ(str)`。
- `seg.text / at / atAll / face / image / audio / video / reply / file / forward`。
- 媒体段的 `file` 是框架约定的来源：`http(s)://`、`base64://`、`file://`，或平台自己的文件标识。适配器负责和协议格式互转（例如 OneBot 的 `record` 对应 `audio`，`at.qq` 对应 `at.id`，图片的 `sub_type` 这类平台字段作为额外字段保留在 `data` 中）。
- 并不是所有平台都支持所有段类型；适配器遇到不支持的段时，按平台惯例降级（例如转成文本），并记 debug 日志。
- `seg.image(src)`：`src` 可为 Buffer、本地路径、`file://`、`http(s)://` 或 `base64://`。Buffer 和本地路径默认转为 `base64://`，因为 OneBot 实现常跑在容器或另一台机器上，读不到 AsaBot 所在主机的路径。
- CQ 码是 OneBot 的文本格式，编解码属于 OneBot 适配器：`import { toCQ, parseCQ } from 'asabot/onebot11'`。
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
  bot: Bot                         // 框架事件 plugin.state 可能发生在任何 Bot 上线之前，因此该事件的 bot 是可选的
}
```

**分层事件名**：派发 `notice.member.join` 时，`notice`、`notice.member`、`notice.member.join` 三级的监听器都会触发。

事件名和字段是**框架自己的词汇**，与任何协议无关；适配器负责把协议事件映射过来。

| 名称 | 字段（除 BaseEvent 外） | OneBot 11 映射（仅供适配器参考） |
|---|---|---|
| `message.private` / `message.group` | Session | `message` |
| `notice.member.join` | `groupId`、`userId`、`operatorId?`、`joinType: 'approve' \| 'invite' \| string` | `group_increase` |
| `notice.member.leave` | `groupId`、`userId`、`operatorId?`、`reason: 'leave' \| 'kick' \| string`（被踢的是机器人自己时 `userId === selfId`） | `group_decrease`（`kick_me` 映射为 reason `kick`） |
| `notice.member.mute` / `notice.member.unmute` | `groupId`、`userId`、`operatorId?`、`duration`（毫秒，仅 mute） | `group_ban` 的 `ban` / `lift_ban`（秒转毫秒） |
| `notice.member.role` | `groupId`、`userId`、`role: 'admin' \| 'member'` | `group_admin` 的 `set` / `unset` |
| `notice.message.recall` | `messageId`、`userId`（原消息作者）、`operatorId?`、`groupId?`（私聊时无） | `group_recall` / `friend_recall` |
| `notice.poke` | `userId`（发起者）、`targetId`、`groupId?` | `notify.poke` |
| `notice.<platform>.<type>[.<subType>]` | 通用 `PlatformNoticeEvent`：`platformType`、`subType?`、`userId?`、`groupId?`、`operatorId?` | 其余未映射的通知，例如 `notice.onebot11.group_upload` |
| `request.friend` / `request.group.join` / `request.group.invite` | `userId`、`comment`，群请求另有必填的 `groupId`；带 `approve(remark?)` / `reject(reason?)` | `request.friend` / `request.group` 的 `add` / `invite` |
| `meta.lifecycle` / `meta.heartbeat` | 元事件（适配器可以选择不派发） | `meta_event` |
| 框架内部：`bot.online` / `bot.offline` / `bot.message.sent` / `plugin.state` | 框架自身派发。机器人自身相关的事件都放在 `bot` 下，不放进 `message`，以保证 `message` 监听器只会收到 Session | — |

`ctx.on` 的事件名到事件类型通过 `EventMap` 获得精确类型。平台专属通知统一用 `notice.<platform>.*` 前缀：订阅具体的通用事件（如 `notice.member`）不会收到平台通知；订阅顶层 `notice` 会收到全部通知，类型为包含 `PlatformNoticeEvent` 的联合类型。平台名不得与通用通知分类重名，`member`、`message`、`poke` 为保留名。

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
  getAvatarUrl?(userId: string): string | undefined  // 平台头像地址（适配器知道规则，例如 OneBot/QQ 的头像 CDN）；不支持的平台不实现
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

**适配器注册表**：`src/adapters/index.ts` 导出 `adapters: Record<string, AdapterDefinition>`，其中 `AdapterDefinition = { configSchema: ZodType; create(config, host): Adapter }`。`bootstrap` 遍历 `config.adapters`，逐个查表、校验、创建。新增协议只需在注册表加一项。

**AdapterHost 的服务能力**：除了 emit 和注册 Bot，host 还提供 `registerUpgrade(path, handler)`，供需要被动接受 WebSocket 连接的适配器（例如 OneBot 的反向 WS）注册路径。通用 HTTP 服务只负责把对应路径的 upgrade 交给 handler，本身不包含任何协议代码。只要有适配器注册了 upgrade 路径，HTTP 服务就会启动。连接方式等展示信息由适配器通过 `host.setBotInfo(bot, { connection, url? })` 提供，`connection` 是自由文本（如 `正向 WS`、`反向 WS`），面板原样展示。

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
- `seg.image('/abs/path')` 和 `seg.image('file:///...')` 先原样保存为 `file://` URL，由 OneBot 适配器在发送前异步读取文件并转成 `base64://`。原因是 OneBot 实现可能运行在容器或另一台机器上，读不到这台主机的路径。文件读取失败时，发送调用以带路径信息的错误 reject。
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
- 发出的消息 ID 写入 toMe 缓存，并派发 `bot.message.sent` 内部事件。

**OneBotApi 首批封装**：`sendPrivateMsg`、`sendGroupMsg`、`deleteMsg`、`getMsg`、`getLoginInfo`、`getVersionInfo`、`getStrangerInfo`、`getFriendList`、`getGroupInfo`、`getGroupList`、`getGroupMemberInfo`、`getGroupMemberList`、`setGroupBan`、`setGroupWholeBan`、`setGroupKick`、`setGroupCard`、`setGroupAdmin`、`setGroupSpecialTitle`、`setFriendAddRequest`、`setGroupAddRequest`、`sendGroupForwardMsg`、`sendPrivateForwardMsg`、`groupPoke`、`friendPoke`（部分 OneBot 实现提供的扩展，例如 NapCat；实现不支持时以 ApiError 失败）。

### 8.1 反向 WS 与发送队列（M5）

**会话与传输分离**：把现在 `OneBotConnection` 中与传输无关的部分抽成 `OneBotSession`，包括 API 的 echo 配对与超时、入站帧处理、事件转换、Bot 生命周期、活性检测（ping/pong 和 heartbeat）、发送队列。正向连接 = 客户端 socket + 退避重连 + 一个 OneBotSession；反向连接 = 服务端接受的 socket + 一个 OneBotSession，不负责重连（由对端的 OneBot 实现负责）。两者行为一致，不允许出现两份重复的协议实现。

**反向 WS**
- 只要配置了 `onebot11.reverse`，HTTP 服务就会启动（即使面板和对外 API 都没开），并在 `/onebot/v11/ws` 接受升级。
- 鉴权：`Authorization: Bearer <token>`，或查询参数 `access_token`（OneBot 11 规范允许）。`reverse.accessToken` 为空时不校验，同时在启动时记一条 warn：“反向 WS 未设置 token”。校验失败返回 401。
- 账号识别：必须带 `X-Self-ID`（纯数字），缺失时返回 400。只支持 `X-Client-Role: Universal`（主流实现的默认值）或不带这个头；`API` 和 `Event` 拆分连接返回 400，并写明原因。
- 握手成功后照样调用 `get_login_info`。返回的 user_id 与 `X-Self-ID` 不一致时关闭连接（1008），记 warn。
- 同一个 selfId 出现新的反向连接时，**新连接替换旧连接**：旧 socket 以 1000 `replaced` 关闭，挂起的请求以 NotConnectedError reject，Bot 实例保持不变，只派发一次 bot.offline/bot.online（或者不派发，由实现决定，但面板的 Bot 状态最终必须正确）。原因：反向模式下这种情况通常是对端重启了，而旧连接已经半死不活。
- 正向连接与反向连接同时登录同一个账号时，沿用第 7 节“先上线者占有”的规则。
- `BotView.connection` 为 `reverse`；`url` 省略。

**发送队列**（每个 Bot 一个）
- 只作用于发送消息的 action：`send_private_msg`、`send_group_msg`、`send_msg`、`send_group_forward_msg`、`send_private_forward_msg`。其他 action 不排队。
- 相邻两次发送的间隔至少为 `interval + random(0, jitter)`。默认 500ms 加 0–300ms 抖动；interval 为 0 时不限速。
- 排队数量超过 `maxPending` 时，新请求立即以 `SendQueueFullError` reject，并记 warn。
- 断线时，排队中尚未发出的请求全部以 NotConnectedError reject，不跨断线缓存。
- 调用方等待的是“真正发出并收到响应”的那一刻，所以 `session.send` 的 await 语义不变。

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
  - 一条消息同时命中用户作用域和 channel 作用域的 prompt 时，用户作用域优先。

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
- **类型**：`string`（默认）、`number`、`integer`、`boolean`、`user`（at 段或任意非空的单个 token，结果为 userId 字符串，不对 ID 格式做假设）、`duration`（毫秒数）、`image`（image 段）、`rest`。
- **分词**：按空白切分，支持 `"..."` 和 `'...'` 引号；每个非文本段单独成为一个 token。
- **类型推断**：`args` 和 `options` 的类型从声明字符串推断（模板字面量类型）。运行时必须做校验，类型推断只是开发体验上的增强。
- **触发规则**：
  - 消息以任一前缀开头时，尝试匹配命令。
  - 群聊中 `toMe` 且 `mentionAsPrefix` 开启时，可以不带前缀。
  - 私聊中 `privateRequirePrefix` 为 false 时，可以不带前缀。
  - 不带前缀时只匹配命令名和别名，匹配不上就交给匹配器。
- **返回值**：action 的返回值（`Sendable`）通过 `session.send` 发出；返回 `undefined` 则不发。
- **选项解析**：支持 `--key value`、`--key=value`、`-k value`，布尔选项写 `-s` 或 `--silent`。选项可以和位置参数交错出现。一旦开始解析 `rest` 参数，或遇到 `--`，后面的内容都按字面处理，不再识别为选项。未知选项报参数错误。
- **命令名匹配**：精确匹配，区分大小写。别名按完整路径解析：给 `plugin reload` 加 `.alias('重载插件')` 得到顶层命令 `/重载插件 <name>`，加 `.alias('plugin rl')` 得到 `/plugin rl <name>`。
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
  name: 'echo',                  // /^[a-z0-9][a-z0-9_-]*$/，全局唯一；'core' 为保留名，供框架自身作为作用域和迁移 owner
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
- **测试注意**：vitest 的模块运行器不经过 Node 的 loader 钩子，所以热重载的集成测试必须在子进程中用 `node` 直接运行（例如测试里 spawn 一个 node 脚本，再断言它的输出），不能在 vitest 进程内 import 插件。

### 12.1 实现约定（M3）

**组装与启动**
- `createApp(config, { configPath?, logger? })`：注册内置插件（静态注册），并为 PluginManager 设置插件目录。
- `app.start()` 的顺序：打开数据库 → 按依赖拓扑加载插件 → 启动适配器 → 开启热重载监听。`app.stop()` 按相反顺序执行。
- `app.plugins` 即 PluginManager；`app.storage` 是存储层。
- 只有提供了 `configPath`，YAML 写回才会生效；没有时（例如测试），全局开关和插件配置的修改只在内存中生效，并记一条 debug 日志。

**状态协调**（reconcile）：PluginManager 的每次变更（enable、disable、reload、updateConfig、热重载）之后，都按拓扑序重新协调一遍：
- 全局启用且依赖全部 active 的插件，加载它；
- 依赖不再 active 的插件，卸载它，并把状态记为 `failed`，原因写“依赖 X 未激活”。依赖恢复后会被自动重新加载。
- 依赖缺失或成环，同样标记为 `failed` 并写明原因。

**插件状态对象**：`{ name, version?, description?, source: 'builtin' | 'file', path?, state: 'loading' | 'active' | 'failed' | 'disabled', error?: string, enabled: boolean, configSchema?: JSONSchema }`。`configSchema` 用 `z.toJSONSchema()` 生成，供 M5 面板渲染表单。

**插件配置**
- `manager.updateConfig(name, value)`：先用插件的 zod schema 校验，失败时抛出带路径的错误、不改动任何状态；成功则写回 YAML 的 `plugins.<name>.config`，然后重载该插件。
- 插件没有声明 `config` schema 时，`ctx.config` 为 `undefined`；此时如果 YAML 里写了 config，记 warn。

**名称与发现**
- `definePlugin` 中的 `name` 是插件的权威名称，同名插件重复出现时，后发现的那个标记为 `failed`。
- 热重载通过“入口文件路径 → 插件名”的映射定位插件。

**按群开关与黑白名单**（替换 M2 中的默认钩子）
- 群的标识 `groupKey` 为 `${platform}:${groupId}`，与具体是哪个机器人账号无关。私聊事件不受按群开关影响。带 groupId 的通知事件同样受按群开关约束。
- 访问控制表 `access_list(list, subject, key)`：
  - `list` 取值 `'block' | 'allow'`，`subject` 取值 `'user' | 'group'`，`key` 为 `${platform}:${id}`。
  - block 中的用户或群，事件一律丢弃。
  - allow 列表按维度分别生效：allow-user 非空时，只有列表中的用户能通过；allow-group 非空时，群事件只有列表中的群能通过（私聊不受这个维度影响）。
  - 超管永远放行。
- 两张表在启动时加载到内存，写入时同步更新，因此钩子可以同步判断。

**空闲判定**：App 记录正在分发中的事件。`app.whenIdle()` 在“所有分发都已结束，或者仅剩阻塞在 prompt 上的处理器”时 resolve。测试辅助的 `say()` 依靠它确定性地拿到机器人的回复，包括多轮对话中的回复。**已知限制（接受）**：处理器如果把 prompt 和其他异步任务并行等待（例如 `Promise.all([session.prompt(), fetch()])`），`whenIdle` 可能在那个异步任务完成前就 resolve。whenIdle 只用于测试辅助，生产路径不依赖它，所以不为此增加显式的活动登记 API。

**虚拟适配器**（`src/adapters/virtual/`，platform 为 `virtual`）：一个完全在进程内运行的适配器，Bot 把“发送”的内容记录下来，而不是发到任何平台。调试台和 `createTestApp` 共用它，因此插件测试不依赖任何具体协议。

**`createTestApp`**（`asabot/testing`，基于虚拟适配器，不走网络）：
```ts
const t = await createTestApp({ plugins?: PluginDefinition[], pluginDirs?: string[], config?: DeepPartial<Config> })
const replies = await t.say('/echo hi', { group?: '10', user?: '20', role?: 'admin', superuser?: boolean })  // 返回这条消息触发的发送内容（plainText 或段数组）
t.app; t.mock; await t.dispose()
```
- 底层是虚拟适配器，数据库用临时目录。OneBot 协议层的测试改用 `MockOneBot`（OneBot 专属测试工具，从 `asabot/onebot11/testing` 导出）。
- `dispose` 时清理所有资源：app、mock 和临时目录。

## 13. 存储

- 数据库文件 `data/asabot.db`，开启 WAL。
- 框架表：`kv(plugin, key, value, expires_at)`、`migrations(plugin, version)`、`plugin_group_state(plugin, group_key, enabled)`、`access_list(list, subject, key)`。框架表结构本身也通过迁移管理，owner 为 `core`。
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
| M3a | 插件系统（definePlugin、Context、PluginManager、状态协调、按群开关和黑白名单）；热重载；存储（KV、迁移、状态表）；定时任务；YAML 写回；`whenIdle`；`createTestApp` | 子进程中的热重载测试通过；插件隔离和资源回收测试通过 |
| M3b | 内置插件 help、status、admin；示例插件 `plugins/echo.ts`、`plugins/guess.ts`；README（快速开始与插件开发指南）；端到端测试 | 用 createTestApp 加载示例插件的端到端测试通过；手动修改示例插件后自动重载生效 |
| M4 | HTTP 服务（第 18 节）：Hono 单端口服务、面板认证、面板 API、实时推送 WS、消息统计、调试台、对外 API、`ctx.route`、静态托管面板 | 第 18 节的接口全部可用，面板契约测试通过 |
| M5 | 反向 WS（多账号，挂在同一个 HTTP 服务上，校验 X-Self-ID 和 token）；每个账号独立的发送队列 | 多账号反向连接和发送限速测试通过 |
| M5b | 协议无关化（第 1.1 节）：OneBot 专属内容移入适配器并以 `asabot/onebot11` 子路径导出；协议无关的消息模型；`adapters` 配置段和适配器注册表；通用 server 的 upgrade 注册接口；虚拟适配器（调试台和 createTestApp 共用）；去掉核心层、内置插件和面板中的纯数字 ID 假设和 QQ/NapCat 措辞 | `src/core`、`src/server`、`src/plugins`、`web/` 中搜索不到协议专属内容；全部测试通过 |
| M5c | 协议无关的事件命名（第 6 节）：核心 EventMap 改用框架自己的通知和请求事件名，OneBot 适配器负责映射，未映射的通知以 `notice.<platform>.*` 透传 | 核心事件类型中不再出现 OneBot 的 notice_type 命名；示例插件和文档同步更新 |
| M6 | Web 面板（第 19 节，由主控 Agent 亲自编写） | 用真实后端走通所有页面 |
| M7 | Dockerfile、compose（只运行 AsaBot 本身，不包含任何 OneBot 实现）、部署文档。原计划的终端沙盒由面板“调试台”取代，不再单独实现 | `docker compose up` 后面板可访问，能通过正向或反向 WS 连上已有的 OneBot 服务 |
| M8 | 插件管理（第 20 节）：重新扫描、上传、卸载与数据清理；npm 包插件（安装、升级、卸载、搜索、兼容性检查、操作进度推送）；对应的聊天命令和面板界面（面板由主控 Agent 编写） | 用本地 registry 夹具完成一次包插件的安装、升级、卸载；上传和卸载文件插件；purge 后数据被清理 |

## 18. HTTP 服务（M4）

**总体**
- 基于 `hono` + `@hono/node-server`，单端口（`server.host` / `server.port`，默认 `127.0.0.1:5140`）。WebSocket 升级统一由 `ws` 的 `noServer` 模式在 node server 的 `upgrade` 事件上按路径分发：面板推送 `/api/panel/ws`，以及 M5 的反向 WS `/onebot/v11/ws`。
- 代码放在 `src/server/`，由 `bootstrap.ts` 组装。`core` 不依赖 server。App 只为 server 提供数据和操作的接口（插件管理、存储、统计、日志订阅、调试台）。
- 面板和对外 API 各自独立启用：`server.panelPassword` 为空时不提供面板 API 和静态页面；`server.apiToken` 为空时不提供 `/api/v1/*`。两者都为空、并且也没有反向 WS 连接时，不监听端口。
- 所有 JSON 错误响应统一为 `{ "error": { "code": string, "message": string, "issues"?: [{ "path": string, "message": string }] } }`，状态码遵循 HTTP 语义（400 参数错误、401 未登录、404 不存在、409 冲突、429 限流、500 内部错误）。错误信息不得包含堆栈。

**面板认证**
- `POST /api/panel/login { password }`：用常量时间比较校验密码。成功后设置 HttpOnly、SameSite=Strict、Path=/ 的会话 cookie `asabot_session`（随机 32 字节，存在内存中，7 天过期，进程重启后失效），返回 `{ ok: true }`。同一 IP 每分钟最多 10 次尝试，超出返回 429。
- `POST /api/panel/logout` 使会话失效；`GET /api/panel/session` 返回 `{ authenticated: boolean }`，不需要登录。
- 其他 `/api/panel/*` 都要求有效会话。为了防 CSRF，修改类请求必须是 `application/json`，并且 `Origin`（若存在）要与 Host 一致。
- 面板的 WebSocket 通过同一个 cookie 鉴权。

**面板 API**（前缀 `/api/panel`，下面的类型就是契约，前后端都按它实现）

```ts
type BotView = { platform: string; selfId: string; nickname?: string; avatar?: string; status: 'connecting' | 'online' | 'offline'; connection: string; url?: string }   // connection 为适配器提供的展示文本；avatar 来自 bot.getAvatarUrl(selfId)
type PluginView = PluginState & { commands: CommandView[]; config?: unknown }   // PluginState 见 12.1；config 为当前生效的配置（经 schema 解析后，没有 schema 时省略）
type CommandView = { owner: string; path: string; usage: string; description: string; aliases: string[]; options: { flags: string[]; description?: string; default?: unknown }[]; examples: string[]; permission: boolean; scope: 'all' | 'group' | 'private'; hidden: boolean }
type StatsPoint = { t: number; received: number; sent: number }   // t：分钟起点的毫秒时间戳
type LogRecord = { time: number; level: number; msg: string; plugin?: string; [key: string]: unknown }
type Target = { type: 'group' | 'private'; id: string }
```

| 方法与路径 | 说明 |
|---|---|
| `GET /overview` | `{ version, node, startedAt, memory: { rss, heapUsed }, bots: BotView[], plugins: { active, failed, disabled }, today: { received, sent } }` |
| `GET /stats/messages?range=1h\|24h` | `StatsPoint[]`。1h 按分钟（60 个点），24h 按 15 分钟聚合（96 个点）；没有消息的时段补 0。统计在内存中，保留 24 小时 |
| `GET /bots` | `BotView[]` |
| `GET /bots/:platform/:selfId/groups` | `{ groupId, groupName, memberCount? }[]`（实时调用平台 API） |
| `POST /send` | `{ platform?, selfId?, target: Target, message: string \| Segment[] }` → `{ messageId }`。不指定 Bot 时使用第一个在线的 |
| `GET /plugins` | `PluginView[]` |
| `POST /plugins/:name/enable` / `disable` / `reload` | 返回最新的 `PluginView`；失败（例如 admin 不允许停用）返回 409 和原因 |
| `PUT /plugins/:name/config` | `{ config }`。校验失败返回 400，`issues` 带字段路径；成功返回最新的 `PluginView` |
| `GET /plugins/:name/groups` | `{ groupKey, enabled }[]`：只列出显式设置过的群 |
| `PUT /plugins/:name/groups/:groupKey` | `{ enabled }` |
| `GET /commands` | `CommandView[]`：全部命令，包括 hidden（带标记） |
| `GET /acl` / `POST /acl` / `DELETE /acl` | `{ list, subject, key }`，与 12.1 一致；不允许 block 超管 |
| `GET /logs?limit=200&level=30` | 最近的 `LogRecord[]`（来自内存环形缓冲） |
| `POST /playground` | 见下文“调试台” |

**实时推送** `GET /api/panel/ws`（升级为 WebSocket）。服务端推送 JSON 帧：
- `{ type: 'log', record: LogRecord }`
- `{ type: 'bot', bot: BotView }`：上线、掉线、状态变化
- `{ type: 'plugin', plugin: PluginView }`：插件状态变化
- `{ type: 'message', direction: 'in' | 'out', platform, selfId, channel: Target, userId?, nickname?, avatar?, preview: string, time }`（avatar：收到的消息取发送者头像，发出的消息取机器人自己的头像，均来自 `bot.getAvatarUrl`）：用于面板的实时消息流，preview 为纯文本摘要，最长 120 字
- `{ type: 'stats', point: StatsPoint }`：每分钟一次，推送刚结束的那一分钟
- 连接建立后，服务端先推送一帧 `{ type: 'hello', overview }`。客户端不发送业务消息；服务端每 30s ping 一次。

**调试台**（Playground，`POST /api/panel/playground`）
- 请求 `{ text?: string, message?: Segment[], user: { id: string; nickname?: string; role?: 'owner' | 'admin' | 'member'; superuser?: boolean }, group?: string | null }`。
- 服务端构造一个虚拟的 Session（platform 为 `playground`，selfId 为 `playground`），投入真实的分发器；它的 Bot 是一个记录发送内容的 PlaygroundBot，不会发到 QQ。`bot.call` 等平台 API 抛出明确的“调试台不支持该操作”错误。
- 返回 `{ replies: { message: Segment[]; text: string }[] }`：等这次分发进入空闲（`whenIdle` 的语义）后，返回期间产生的全部回复。多轮对话就是连续调用该接口，prompt 会正常消费后续消息。
- 调试台的 Session 同样经过黑白名单、按群开关、权限和冷却。超管身份由请求里的 `superuser` 决定，只在调试台内有效。

**健康检查** `GET /healthz`：只要 HTTP 服务在运行就可用，不需要鉴权。返回 `{ ok: true, bots: { online, total } }`，不包含任何敏感信息。供 Docker 的 HEALTHCHECK 和外部监控使用。

**对外 API**（`Authorization: Bearer <server.apiToken>`）
- `POST /api/v1/send`：请求体同面板的 `/send` → `{ messageId }`
- `GET /api/v1/bots` → `BotView[]`

**插件路由** `ctx.route(app => ...)`：插件拿到一个 Hono 子应用，挂在 `/plugins/<name>/` 下，不需要面板登录。插件卸载后该前缀返回 404。实现方式是一个 `/plugins/:name/*` 总入口，按名字转发到当前注册的子应用，从而支持动态挂载和卸载。

**静态托管**：面板启用时，`/` 提供 `web/dist` 的静态文件，其余路径回退到 `index.html`（SPA）。属于后端的只有 `/api/*` 和插件路由 `/plugins/<name>/*`；面板自己的 `/plugins` 页面是精确路径，同样回退到 SPA，以保证深链接可用。`web/dist` 不存在时，`/` 返回一个提示页，说明需要先运行 `pnpm --filter web build`。

## 19. Web 面板（M6）

- 位置：`web/`，pnpm workspace 包。技术栈：Vite + React 19 + TypeScript + Tailwind CSS v4 + Radix 原语（组件代码自己维护，参考 shadcn 的做法）+ `motion` 动画 + TanStack Query + lucide 图标。
- 风格：现代、简洁，参考 Linear 和 HeroUI 的观感。配色柔和，支持浅色和深色，默认跟随系统。动效统一用 spring 曲线：页面切换、列表进出、数字滚动、抽屉和弹窗都要有过渡，并尊重 `prefers-reduced-motion`。
- 字体：英文和数字用 Geist，等宽用 Geist Mono，中文用 Noto Sans SC（按 unicode-range 分片），全部打包在本地。
- 页面：登录、概览（Bot 状态、消息趋势图、插件统计、实时消息流）、插件（列表、启停和重载、由 JSON Schema 生成的配置表单、按群开关、命令列表）、命令速查、日志（实时、按级别和插件过滤、搜索、暂停）、访问控制、机器人（账号、群列表、发送消息）、调试台（聊天界面模拟用户和群）。另有全局 ⌘K 命令面板。
- 开发时 Vite 把 `/api` 和 WebSocket 代理到 `127.0.0.1:5140`；生产构建产物在 `web/dist`，由 M4 的服务托管。

## 20. 插件管理（M8）

插件有三种来源，统一由 PluginManager 管理，状态对象 `source` 取 `builtin | file | package`：

| 来源 | 位置 | 安装 / 卸载 |
|---|---|---|
| builtin | 框架内置（help、status、admin） | 不可卸载，只能停用（admin 在聊天中不能停用） |
| file | `pluginLoader.dirs` 中的 `<name>.ts` / `<name>/index.ts` | 手动放文件或在面板上传；卸载即删除文件 |
| package | 插件包目录（默认 `<dataDir>/packages`）中通过 npm 安装的包 | 在面板或聊天命令中安装、升级、卸载 |

### 20.1 文件型插件的管理

- **重新扫描**：`manager.rescan()` 发现新增文件并加载，移除已经删除的文件对应的插件，对已修改的文件不做处理（修改由热重载或手动 reload 负责）。生产环境（热重载关闭）也可用。返回 `{ added, removed }`。
- **上传**：接收单个 `.ts`/`.js` 文件或 `.zip` 包，写入 `pluginLoader.uploadDir`（默认是 `dirs[0]`）。
  - 文件名和插件名需符合 `/^[a-z0-9][a-z0-9_-]*$/`。zip 解压到 `<uploadDir>/<name>/`，要求根目录或唯一的顶层目录里有 `index.ts` 或 `index.js`。
  - 严格防止路径穿越（拒绝绝对路径、`..`、符号链接条目）；解压后总大小不超过 5 MB，单个上传请求不超过 2 MB。
  - 目标已存在时返回 409，除非请求带 `overwrite: true`；覆盖等同于重载。
  - 写入完成后执行重新扫描或重载，返回最新的 PluginView。导入或 setup 失败时，插件文件保留，状态为 failed，并带上原因。
- **卸载**：只能卸载 `file` 和 `package` 来源的插件。先卸载运行中的实例（依赖它的插件按状态协调规则处理），再删除文件或目录；删除前确认路径确实位于插件目录内。

### 20.2 包插件（npm）

- **插件包约定**：
  - 一个普通的 npm 包，`package.json` 的 `keywords` 包含 `asabot-plugin`，类型为 ESM，入口（`exports['.']` 或 `main`）默认导出 `definePlugin(...)` 的结果。
  - 入口**必须是 JS**：Node 不对 `node_modules` 下的文件做 TypeScript 类型剥离。插件作者需要先编译后发布，并附带 `.d.ts`。
  - 通过 `peerDependencies.asabot` 声明兼容的框架版本范围（semver）。运行时 `import 'asabot'` 始终解析到当前运行的框架实例（由加载钩子保证），不会使用包自带的 asabot 副本。
- **插件包目录**：`packages.dir`（默认 `<dataDir>/packages`），由框架管理一个 `package.json`（`{ "name": "asabot-packages", "private": true, "type": "module", "dependencies": {} }`），其中的 dependencies 就是“已安装插件包”的唯一事实来源。启动时加载其中所有带 `asabot-plugin` 关键词的包。在 Docker 里，这个目录随数据卷持久化，不需要重新构建镜像。
- **安装、升级、卸载**通过子进程执行 npm：
  - 命令：`npm install <spec> --save --omit=peer --ignore-scripts --no-audit --no-fund --registry <registry>`（升级时用 `<name>@latest`，卸载时用 `npm uninstall <name>`），工作目录是插件包目录。
  - `--ignore-scripts` 禁止包的安装脚本运行。
  - 超时时间为 `packages.installTimeout`，超时后杀掉子进程，并回滚 `package.json`（操作前备份）。
  - 所有包操作串行执行。
- **安装前检查**：
  - 先从 registry 读取包的元数据：必须带 `asabot-plugin` 关键词。
  - `peerDependencies.asabot` 必须包含当前框架版本，不包含时拒绝安装，返回 409 并写明需要的版本范围；请求可以带 `force: true` 跳过版本检查。
  - 安装后导入入口：导出不合法或插件名与已有插件冲突时，自动卸载并报错。
- **搜索**：调用 registry 的 `/-/v1/search?text=keywords:asabot-plugin <q>`，结果标注是否已安装以及已安装的版本。
- **更新检查**：PluginView 的 `package.latest` 为 registry 上的最新版本，缓存 1 小时，失败时省略。
- **安全**：包插件与框架运行在同一个进程中，拥有完整权限。安装入口只开放给已登录的面板和超管的聊天命令；面板安装确认框中写明这一点。

### 20.3 卸载时的数据清理（purge）

卸载请求可以带 `purge: true`，此时额外清理：
- YAML 中的 `plugins.<name>` 段；
- KV 中该插件的全部数据；
- migrations 记录；
- 名称以 `p_<name>_` 开头的表（从 sqlite_master 读出表名，带引号执行 DROP）；
- plugin_group_state 中该插件的记录；
- `<dataDir>/plugins/<name>/` 目录。

不带 purge 时只移除代码，以后重新安装可以沿用原来的数据。

### 20.4 配置

```yaml
pluginLoader:
  dirs: [./plugins]
  uploadDir: ./plugins          # 面板上传的插件写到这里，默认 dirs[0]
packages:
  dir: ./data/packages          # 默认 <dataDir>/packages
  registry: https://registry.npmjs.org   # 国内可改为 https://registry.npmmirror.com
  npm: npm                      # npm 可执行文件
  installTimeout: 5m
```

### 20.5 接口（面板 API 增量）

```ts
type PluginView = PluginState & {
  commands: CommandView[]; config?: unknown
  source: 'builtin' | 'file' | 'package'
  removable: boolean                                   // file 和 package 为 true
  package?: { name: string; version: string; latest?: string; peerRange?: string; compatible: boolean }
}
type PackageOperation = {
  id: string; kind: 'install' | 'update' | 'uninstall'; name: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  startedAt: number; finishedAt?: number
  log: string[]                                        // npm 输出（去掉 token 等敏感内容），最多 200 行
  error?: string; plugin?: PluginView
}
type PackageSearchItem = { name: string; version: string; description?: string; author?: string; date?: string; links: { npm: string; homepage?: string; repository?: string }; installed: boolean; installedVersion?: string }
```

| 方法与路径 | 说明 |
|---|---|
| `POST /plugins/rescan` | → `{ added: string[]; removed: string[]; plugins: PluginView[] }` |
| `POST /plugins/upload` | `{ filename, content /* base64 */, overwrite? }` → 201 `PluginView`；冲突 409；格式错误 400 |
| `POST /plugins/:name/uninstall` | `{ purge: boolean }` → `{ ok: true }`；builtin 返回 409 |
| `GET /packages/search?q=&from=0` | → `{ total: number; items: PackageSearchItem[] }` |
| `POST /packages/install` | `{ name, version?, force? }` → 202 `PackageOperation` |
| `POST /packages/update` | `{ name }` → 202 `PackageOperation` |
| `POST /packages/uninstall` | `{ name, purge }` → 202 `PackageOperation` |
| `GET /packages/operations` | 最近 20 条 `PackageOperation`（内存中保存） |

- 实时推送新增帧 `{ type: 'package', operation: PackageOperation }`：状态变化或新增日志行时推送，日志节流到每 300ms 最多一帧。
- 插件包的 npm 包名可能带 `/`（scope），所以一律放在请求体里传，不放路径参数。

**聊天命令**（admin 插件，仅超管可用）：`/plugin scan`、`/plugin install <package> [-f]`、`/plugin update <package>`、`/plugin uninstall <name> [--purge]`。安装、升级在后台执行，开始和结束时各回复一条消息。

## 21. 改进批次 1（缺陷与运维）

本节修订前面相关章节，以本节为准。

**E1 数据表归属（修订 13、20.3）**：purge 不再按 `p_<name>_` 前缀匹配，因为插件名允许下划线，`foo` 会误删 `foo_bar` 的表。改为记录表的归属：`ctx.migrate()` 执行每一步迁移的前后各对比一次 sqlite_master，新出现的表记入 `plugin_tables(plugin, table_name)`，迁移中被删掉的表从记录里移除。purge 只 DROP 记录在该插件名下的表。直接用 `ctx.db.exec` 建的表不在记录里，文档说明建表应通过 migrate。

**E3 不吞异常（修订 14、18）**：HTTP 的 onError 在日志中带上 `err`、请求方法和路径；dispatch 订阅者等内部回调中不允许出现空 catch，异常一律带上下文记录 error 日志。

**A5 时区（修订 4、12、18）**：
- 新增 `timezone` 配置。croner 任务默认使用它，`ctx.cron(expr, fn, { timezone? })` 可单独覆盖。
- cron、interval、timeout 的回调都会收到一个 `AbortSignal`，插件卸载时 abort。
- 面板“今日收到/发出”和 24 小时统计的日界线按 `timezone` 计算。
- Docker 镜像安装 tzdata；compose 示例里给出 `TZ` 的设置方法。

**C2 日志（修订 4、14、19）**：
- 配置从 `logLevel` 改为 `log.level`，新增可选的 `log.file`。日志文件由框架自己的写入流按大小轮转（`asabot.log` → `asabot.log.1` … 最多 `maxFiles` 个），不引入新依赖。轮转失败时记 warn 并继续写 stdout，不影响运行。
- 插件相关日志统一使用 `plugin` 字段（分发器、Context、调度器、PluginManager 中原来用 `owner` 的地方都改过来），面板按插件筛选时就能看到处理器的异常。
- 面板 API 新增 `GET /logs/level` → `{ level }`、`PUT /logs/level { level }` → `{ level }`，运行时调整日志级别，不写回配置。

**E4 插件管理不阻塞（修订 12、20）**：
- `pluginLoader.setupTimeout`（默认 30s）：setup 超时后插件记为 failed，原因写“setup 超时”，并回收它已注册的资源（setup 中的 Promise 继续运行也不再影响状态）。
- 包操作中的 npm 执行在插件管理的串行队列之外进行，只有安装完成后的加载、卸载前的停止这两步进入队列。安装期间仍然可以启停插件、重载、保存配置。
- `GET /plugins` 不再等待 registry：`package.latest` 只返回缓存中的值，缓存缺失或过期时在后台刷新，刷新完成后通过 `plugin` 推送帧更新。

**B4 插件发现规则（修订 12）**：插件目录顶层扫描时忽略以 `_` 或 `.` 开头的文件和目录，以及 `*.test.*`、`*.spec.*`、`*.d.ts`。热重载监听和 rescan 使用同一套规则。

## 已知限制

- **取消是协作式的**：插件代码如果不理会 `signal`，被取消（超时、卸载、退出）后仍会继续执行；框架只是不再等待它，也不会自动发送它的返回值。
- **热重载的内存代价**：Node 的 ESM 模块缓存无法清除，每次重载都会保留一份旧模块，长时间频繁重载后应重启进程。
- **超大数字 ID**：OneBot JSON 中的数字按 JavaScript `Number` 解析，超过 2^53 的 ID 会丢失精度。QQ 号、群号和常见 OneBot 实现的 message_id（int32）都远小于这个范围，暂不处理。
- **whenIdle**：见 12.1，处理器把 prompt 与其他异步任务并行等待时可能提前 resolve，只影响测试辅助。
- **删除插件文件**：入口文件删除后插件会被卸载并从列表中移除；依赖它的插件进入 failed，入口恢复后自动恢复。
