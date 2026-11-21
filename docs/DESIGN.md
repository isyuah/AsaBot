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
| 运行时 | Node.js ≥ 24，ESM（`"type": "module"`），仓库内**直接运行 .ts**（原生类型剥离）；只有发布 npm 包时才构建（24.12） |
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
- 用户插件通过包自引用导入框架：`import { definePlugin, z, seg } from '@asabot/core'`（仓库内 `package.json` 的 `exports` 指向 `./src/index.ts`，发布时指向 dist）。zod 必须从 `@asabot/core` 再导出，保证单实例。
- 依赖通过 `pnpm add` 安装，不手写版本号、不手改 lockfile。

## 3. 目录结构

```
src/
  index.ts                 # 公共 API 出口（插件作者唯一入口）
  cli.ts                   # 命令行入口（asabot start / dev）：加载配置 → 创建 App → 启动 → 信号处理
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

- `connections` 数组：每条连接有独立 id、名称、adapter、enabled 和 config；核心校验公共结构，注册的适配器定义校验 config。`adapterModules` 指定启动时从项目安装目录加载的额外适配器包。
- 字符串标量支持 `${VAR}` 与 `${VAR:-default}` 插值；变量缺失且无默认值 → 启动失败并指出变量名与配置路径。
- 整体用 zod 校验；失败时输出可读的路径化错误，例如 `connections.primary.config.url: Invalid URL`。
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
superusers: [{ platform: onebot11, selfId: "10000", userId: "10001" }]

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

adapterModules: []
connections:
  - id: onebot-main
    name: OneBot 主连接
    adapter: onebot11
    enabled: true
    config:
      type: forward
      url: ws://127.0.0.1:3001
      accessToken: ${ONEBOT_TOKEN:-}
      apiTimeout: 30s
      reconnect: { minDelay: 1s, maxDelay: 60s }
      sendQueue: { interval: 500ms, jitter: 300ms, maxPending: 100 }

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

**适配器注册表**：`src/adapters/index.ts` 导出内置 `AdapterDefinition[]`，bootstrap 与外部包使用同一契约注册到 Connections。每条连接按自己的适配器定义校验、创建独立驱动；包通过 `defineAdapter()` 默认导出元数据、schema 和 create，无需修改核心。

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
- 只要某条启用连接的 `adapter` 为 onebot11 且 `config.type` 为 reverse，HTTP 服务就会启动（即使面板和对外 API 都没开），并在 `/connections/<id>/onebot/v11/ws` 接受升级。
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
- 群的标识 `groupKey` 为 `${platform}:${selfId}:group:${groupId}`，隶属于指定机器人。私聊事件不受按群开关影响。带 groupId 的通知事件同样受按群开关约束。
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
- 基于 `hono` + `@hono/node-server`，单端口（`server.host` / `server.port`，默认 `127.0.0.1:5140`）。WebSocket 升级统一由 `ws` 的 `noServer` 模式在 node server 的 `upgrade` 事件上按路径分发：面板推送 `/api/panel/ws`，以及 M5 的反向 WS `/connections/<id>/onebot/v11/ws`。
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
type BotView = { platform: string; selfId: string; nickname?: string; avatar?: string; status: 'connecting' | 'online' | 'offline'; connection: string; connectionId?: string; capabilities?: BotCapabilities; lastOnlineAt?: number }
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
| `GET /plugins/:name/readme` | 读取已安装 npm 插件随包附带的 README，返回 `{ readme?: string }`；文档缺失时省略 `readme` |
| `POST /plugins/:name/enable` / `disable` / `reload` | 返回最新的 `PluginView`；失败（例如 admin 不允许停用）返回 409 和原因 |
| `PUT /plugins/:name/bot-default` | `{ defaultOnNewBots: boolean }`。设置新机器人的初始开关，返回最新的 `PluginView` |
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

**E2 接口不得读取本地文件（修订 18）**：面板的 `/send`、对外 API 的 `/api/v1/send`、调试台的 `message`，这些来自 HTTP 请求的消息段中，`image`、`audio`、`video`、`file` 的 `file` 字段不允许以 `file:` 开头（大小写不敏感），也不允许是绝对路径（POSIX 的 `/…`、Windows 的 `C:\…` 或 `C:/…`、UNC 路径），因为 OneBot 实现会把绝对路径当作它所在主机上的文件来读。违反时返回 400 `BAD_REQUEST`，`issues` 指出具体的段。只有插件代码中的 `seg.image('/本地路径')` 这类受信任的调用才会让适配器读取本地文件。

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

## 22. 改进批次 2（插件能力）

本节修订前面相关章节，以本节为准。新增的公开名称都从 `asabot` 导出。

**A2 对话助手（修订 6 的 Session）**
- `session.prompt(text?, opts)` 新增两个选项：
  - `validate?: (reply: Session) => true | string | Promise<true | string>`：返回字符串表示回答无效，框架把这个字符串回复给用户并重新等待；
  - `retries?: number`：只在提供了 `validate` 时生效，默认 2。重试用尽后返回 `null`。
  - 每次等待都单独计时，超时同样返回 `null`。
- 取消：提供了 `validate` 的 prompt，以及下面的 `confirm`、`choose`，在用户回复 `取消` 或 `cancel` 时（去掉首尾空白后整句匹配，忽略大小写）立即返回 `null`，框架不发送任何内容。不带 `validate` 的 prompt 行为不变，原样返回回复。
- `session.confirm(text, opts?)` → `Promise<boolean | null>`：
  - 回复 `是`、`是的`、`好`、`好的`、`确认`、`确定`、`y`、`yes`、`ok` 时返回 `true`；
  - 回复 `否`、`不`、`不要`、`不是`、`n`、`no` 时返回 `false`；
  - 判断时去掉首尾空白，整句匹配，忽略大小写；
  - 其他回答提示 `请回复“是”或“否”` 并重问，重试规则与 `validate` 相同。
  - `opts` 支持 `timeout`、`scope`、`retries`。
- `session.choose(text, choices, opts?)`：
  - 发送 `text`，后面附上 `1. 选项` 形式的编号列表；
  - `choices` 为 `string[]`，或 `{ label: string; value: T }[]`；
  - 回复编号或完整的 label 都算选中，返回对应的 value（`string[]` 时返回该字符串）；
  - 无效回答提示 `请回复 1-N 的编号` 并重问；
  - 超时、取消、重试用尽时返回 `null`。
- 三者都基于现有 prompt 实现，`whenIdle` 的语义不变。

**A3 协议无关的群管理（修订 7 的 Bot）**
```ts
interface Bot {
  // ……原有方法
  getMessage(messageId: string): Promise<MessageInfo>
  getGroupMembers(groupId: string): Promise<GroupMemberInfo[]>
  muteMember(groupId: string, userId: string, duration: number): Promise<void>   // 毫秒，0 表示解除禁言
  kickMember(groupId: string, userId: string, options?: { rejectRequest?: boolean }): Promise<void>
  setMemberCard(groupId: string, userId: string, card: string): Promise<void>     // 空字符串表示清除群名片
}
interface MessageInfo {
  messageId: string; messageType: 'private' | 'group'; userId: string; groupId?: string; time: number
  message: Message; sender: { userId: string; nickname: string; card?: string; role?: 'owner' | 'admin' | 'member' }
}
```
- 平台不支持某项操作时，抛出 `UnsupportedError`。它定义在 core，带 `platform` 和 `operation` 字段，消息为 `<platform> 不支持 <operation>`。权限不足之类的平台错误照常以 `ApiError` 抛出，框架不预先检查权限。
- OneBot：禁言时长从毫秒转为秒，向上取整，0 表示解除；`getMessage` 基于 `get_msg`，转换成中立的消息段。
- 虚拟适配器：
  - 原来抛 `Error('虚拟适配器不支持该操作')` 的地方统一改为 `UnsupportedError`；
  - 群管理操作记入 `bot.actions: { action: string; params: Record<string, unknown> }[]` 后直接成功，供插件测试断言；
  - `getMessage` 只能查到虚拟 Bot 自己发出或收到过的消息，查不到时 reject。

**A4 合并转发（修订 5、7）**
```ts
interface ForwardNode { userId: string; nickname: string; message: Sendable }        // 发送用
interface ForwardMessage { userId: string; nickname: string; time?: number; message: Message }  // 读取结果
bot.sendForward(target: { type: 'group' | 'private'; id: string }, nodes: ForwardNode[]): Promise<SendResult>
bot.getForward(id: string): Promise<ForwardMessage[]>   // id 取自收到的 forward 段
session.sendForward(nodes): Promise<SendResult>          // 发到当前会话
```
- 节点内容可以再包含 `forward` 段（是否支持嵌套由平台决定）。
- OneBot：发送用 `send_group_forward_msg` / `send_private_forward_msg`，读取用 `get_forward_msg`，两个方向都做中立段转换。
- 发送成功后派发 `bot.message.sent`，其中 `message` 为 `[seg.forward(messageId)]`，面板显示为合并转发。
- 不支持的平台抛 `UnsupportedError`。

**A6 可持久化的一次性任务（修订 12、13、20.3）**
```ts
const remind = ctx.task<{ channel: string; text: string }>('remind', async (payload, { signal, key, runAt, taskId, attempt }) => { … }, { retry: { maxRetries: 2, delay: '5s', maxDelay: '5m' }, timeout: '1m' })
remind.schedule(payload, { at?: Date | number; delay?: Duration; key?: string }): string   // at 与 delay 必须且只能给一个；返回 key
remind.cancel(key): boolean
remind.list(): TaskRecord<T>[] // 未完成任务
remind.get(key): TaskRecord<T> | undefined // 此逻辑键的最新任务
remind.attempts(key): TaskAttempt[]
remind.retry(key): boolean // 手动重试失败任务
```
- **存储**：`tasks` 每次 schedule 生成独立 ID；`task_attempts` 保存每次执行结果。旧 `scheduled_tasks` 一次性迁移后删除。同一 `(plugin, name, key)` 的新任务取消旧任务并等待其回调结束，保留两者历史。
- **装载**：应用级 TaskService 统一调度，插件 setup 成功后激活处理器。到期任务立即进入队列；未注册或未激活的处理器显示阻塞原因。全局并发默认 4，可用 `tasks.maxConcurrent` 配置。
- **状态**：`pending → running → succeeded/failed/retry_wait`；取消及超时经过 `cancelling`，等待回调结束。超时和取消均通过 AbortSignal 协作；未退出的回调继续占用并发和同键锁，禁止重叠重试。
- **结果落库**：回调结束后若持久化暂时失败，保留并发和同键锁并重试写入，不重新执行回调。已落库的结果不会因紧接着发生的插件卸载被改写为中断。
- **重试与恢复**：自动重试默认关闭，插件显式传入 retry 开启指数退避。失败任务保留；手动重试保留 attempt 历史并重置失败重试额度。进程中断、插件卸载将本次 attempt 记为 interrupted，任务恢复 pending，不消耗业务重试额度。持久化任务为至少一次语义，插件应对外部副作用做幂等处理。
- **生命周期与清理**：卸载时 abort 回调、解除处理器；旧回调完成后释放锁，不允许回写已恢复或 purge 的任务。终态默认保留 7 天、最多 10000 条，运行中和待执行任务不清理。purge 删除插件任务和尝试记录。
- 任务时间是绝对时间戳，与 `timezone` 无关。

任务中心只管理 `ctx.task`，不包含 cron/interval/timeout。面板提供 `GET /api/panel/tasks`（plugin/name/state/q/offset/limit 服务端筛选分页）、`GET /tasks/:id`、`GET /tasks/:id/attempts`、`POST /tasks/:id/cancel` 和 `POST /tasks/:id/retry`，沿用面板认证及 Origin 验证。WebSocket 发送无参数内容的 task 变更通知，客户端失效查询后重新获取脱敏视图。面板不创建或编辑插件任务。

**A9 发送前钩子（修订 7、12）**
```ts
ctx.beforeSend(
  (input: { bot: Bot; target: { type: 'group' | 'private'; id: string }; message: Message }) =>
    Message | false | undefined | Promise<Message | false | undefined>,
  { priority?: number },
): Disposer
```
- 返回值：新的 `Message` 表示替换内容，`false` 表示拦截，`undefined` 表示保持不变。
- **顺序**：按 priority 降序，同一优先级按注册顺序。前一个钩子的输出作为后一个的输入。
- **拦截**：被拦截的发送调用以 `SendBlockedError` reject，错误中带上拦截它的插件名。分发器遇到这种错误记 info，不记 error。
- **钩子出错**：钩子抛出异常记 error，超过 3 秒没有返回记 warn，两种情况都跳过这个钩子，发送继续进行（失败时放行）。
- **实现位置**：`AdapterHost` 新增 `prepareOutgoing({ bot, target, message }): Promise<Message>`。
  - 适配器必须在每条中立发送路径上调用一次：`sendPrivate`、`sendGroup`、Session 的 `send` 和 `reply`，以及 `sendForward` 的每个节点（任意一个节点被拦截，整条转发都不发送）。
  - OneBot 专属的 `bot.onebot.send*` 同样经过钩子。
  - `bot.call()` 透传不经过钩子，列入已知限制。
  - OneBot 专属转发 API 中只带消息 ID 的引用式节点，引用的是平台上已有的消息，原样透传，不经过钩子。
- **防止递归**：钩子内部发出的消息不再经过钩子，用 AsyncLocalStorage 标记。
- `bot.message.sent` 中带的是经过钩子处理后的最终内容。

**A10 插件间服务（修订 12、12.1）**
```ts
// 提供方
declare module 'asabot' { interface Services { coins: CoinService } }
export default definePlugin({ name: 'sign-in', setup(ctx) { ctx.provide('coins', service) } })
// 使用方
export default definePlugin({ name: 'shop', inject: ['coins'], setup(ctx) { const coins = ctx.inject('coins') } })
```
- **类型**：`Services` 是一个空接口，靠声明合并补充类型。`provide` / `inject` 的类型取 `K extends keyof Services ? Services[K] : unknown`。
- **提供**：同一个服务名同一时刻只能有一个提供方，后一个提供方的 setup 失败，原因与命令冲突一样写明冲突对象。服务作为提供方的 ctx 资源，插件卸载时撤销。
- **使用**：`definePlugin` 新增 `inject?: string[]`。所列服务全部可用时，插件才会加载。
  - 有服务不可用时，插件状态为 `failed`，原因写 `服务 coins 不可用`。服务恢复后，由 reconcile 自动加载它，规则与 depends 相同。
  - 提供方卸载时，使用方级联卸载；提供方重载时，使用方级联重载。
- `ctx.inject(name)` 只能获取 `inject` 中声明过的服务，否则直接抛错，以保证生命周期可以追踪。
- **加载顺序**：先按 `depends` 做拓扑排序；因为只有插件 setup 之后才知道它提供了哪些服务，所以 reconcile 会反复执行，直到状态不再变化。
- `depends` 保留，用于依赖某个具体的插件；`inject` 用于依赖某种能力，不关心由哪个插件提供。
- `PluginState` 和面板的插件视图新增 `provides: string[]`、`inject: string[]`。

**B5 消息段类型与媒体来源（修订 5、7）**
- 消息段类型拆成 `Segment = KnownSegment | UnknownSegment`，其中 `UnknownSegment = { type: string; data: Record<string, unknown> }`。
  - 因为联合类型中有 `type: string`，直接比较 `segment.type === 'image'` 无法收窄类型。为此提供类型守卫 `isSegment(segment, 'image')`，配合 `message.filter((s) => isSegment(s, 'image'))` 使用。
- `seg.image / audio / video / file` 的 `source` 判定规则，按顺序：
  1. `Buffer` → 转成 `base64://`。
  2. `URL` 对象 → 使用 `href`。推荐写法是 `seg.image(new URL('./assets/cat.png', import.meta.url))`，路径相对于插件文件，热重载也不受影响。
  3. 以 `http://`、`https://`、`base64://`、`file://` 开头的字符串 → 原样使用。
  4. 绝对路径（POSIX 的 `/…`、Windows 的 `C:\…` 或 `C:/…`、UNC 路径）→ 转成 `file://` URL，由适配器读取本地文件。
  5. 以 `./` 或 `../` 开头 → 抛出 TypeError，提示改用 `new URL(…, import.meta.url)` 或绝对路径。插件不应依赖进程的工作目录。
  6. 其他字符串 → 当作平台文件标识原样透传，例如收到的图片段中的 `file`。

## 23. 改进批次 3（面板设置与插件市场）

本节修订前面相关章节，以本节为准。

**C4 面板设置（修订 4、7、18、19）**

- `GET /settings` 返回 `{ superusers: { platform, selfId, userId }[], timezone, command, restartRequired }`，`PUT /settings` 接受其中可编辑字段。管理员和命令立即生效，时区重启后生效。
- `dataDir`、`pluginLoader`、`packages`、`server`、`log.file` 通过配置文件修改。
- 连接从设置页移至「机器人 → 连接」。`GET /adapters` 返回加载的适配器元数据、来源、实现能力及 JSON Schema；`GET /connections` 返回持久连接与实际运行状态。`POST /connections`、`PUT /connections/:id`、`DELETE /connections/:id` 管理单条记录，`POST /connections/:id/reconnect` 手动重连。
- 表单使用插值前的原始配置，保留 `${VAR}` 引用；常见敏感字段及 schema.writeOnly 字面量遮蔽为 `********`，保存占位符时保持原值。
- 所有保存先插值并校验，再原子写回 YAML，保留注释，然后应用到运行实例。写入与插件管理串行执行；没有 configPath 时只更新内存。
- Adapter.reconfigure 接收已校验的单条连接配置，仅重配对应驱动。OneBot 按 selfId 保留 Bot 实例；删除连接回收驱动与升级路径。反向监听使用连接 ID 作为路径命名空间。

**首次运行向导**
- **触发条件**（只在 `main.ts` 中判断，`createApp` 和测试不受影响）：
  - `ASABOT_CONFIG`（或默认路径）指向的配置文件不存在；
  - 或者配置中 `server.panelPassword` 为空、`connections` 也为空。
- **生成配置**：文件不存在时，先生成一份最小配置，然后进入设置模式。
  - 文件内容包括注释（指向 `asabot.config.example.yaml`）、`superusers: []`、`connections: []`、`adapterModules: []`，以及 `server` 的 host、port、`panelPassword: ''`。
  - host 和 port 取环境变量 `ASABOT_HOST`、`ASABOT_PORT`，缺省为 `127.0.0.1` 和 `5140`。这两个变量只在生成配置时使用。
  - Docker 镜像设置 `ASABOT_HOST=0.0.0.0`。
- **设置码**：进入设置模式时生成一次性设置码，格式为 `XXXX-XXXX`，使用不含易混淆字符的 base32 字母表。
  - 设置码用 `process.stderr.write` 直接打印到控制台，**不经过 logger**，因此不会进入日志文件、内存日志和面板。
  - 设置码只在本次进程中有效。
- **设置模式下的接口**：
  - `GET /session` 返回 `{ authenticated: false, setup: true }`；
  - 除了 `/session`、`/setup` 和静态页面以外，面板 API 一律返回 401；
  - 对外 API 不启用。
- **`POST /setup { code, password, superusers }`**：
  - 设置码用常量时间比较，失败次数计入登录限流；
  - `password` 至少 8 个字符；
  - 处理顺序：写回配置（`server.panelPassword` 以明文写入配置文件，与手写配置相同；文档建议之后改用环境变量引用）→ 应用管理员与密码 → 退出设置模式 → 设置登录 cookie 并返回 `{ ok: true }`。
- **面板向导的步骤**：设置码 → 面板密码 → 进入概览页；连接与管理员在对应管理页添加。

**D4 插件市场（修订 20.2、20.5）**
- **搜索**：`GET /packages/search?q=&from=&sort=`，其中 `sort` 取 `relevance`（默认）、`updated` 或 `name`。
  - 后端向 registry 一次请求最多 250 条结果，缓存 5 分钟（缓存键为 `q`），在本地排序后按每页 20 条分页。
  - `total` 取 registry 总数和 250 中的较小值。
  - 生态规模较小，通常一次就能取全；超出 250 条的部分不参与排序，列入已知限制。
- **详情**：新增 `GET /packages/info?name=`，返回：
  ```ts
  {
    name: string; description?: string; license?: string; links: {...}
    readme?: string                                   // Markdown，超过 200KB 时截断
    latest?: string
    installed?: string                                // 已安装的版本
    versions: { version: string; date?: string; peerRange?: string; compatible: boolean; deprecated?: string }[]  // 新版本在前，最多 50 个
  }
  ```
  - 数据来自 registry 的完整 packument（`accept: application/json`），缓存 10 分钟。
  - npm 官方源的 packument 已经不再附带 README（npmmirror 等镜像仍然附带）。packument 中没有 README 时，从 latest 版本的 tarball 中读取顶层的 `README*`：tarball 地址取自同一个 registry 返回的 `dist.tarball`，大小上限 5MB。读取失败记 warn，详情照常返回，只是没有 README。
  - 安装时的元数据仍然使用现有的精简格式。
- **安装指定版本**：沿用 `POST /packages/install { name, version, force? }`。版本不兼容时返回 409，面板确认后带 `force` 重试，与 20.5 一致。
- **面板**：
  - 点击市场卡片打开详情抽屉。
  - README 用 react-markdown 加 remark-gfm 渲染，不渲染原始 HTML；链接在新标签页打开（`rel="noopener noreferrer"`）；图片只加载 `https:` 地址。
  - 版本下拉框中标出兼容的版本。
  - 搜索框旁边增加排序切换。

## 24. 批次 4（插件生态与运营）

本节修订前面相关章节，以本节为准。新增的公开名称都从框架包导出（包名见 24.12）。

**放在哪一层**：只有通用、或者用插件不好表达的能力才进核心；其余能力尽量做成内置插件，或者做成官方插件包。
| 位置 | 条目 |
|---|---|
| 核心 | I1 能力声明与统一降级、F3 推送目标、F4 命令增强、F5 过滤上下文与按群配置、F12 平台 API 拦截、G1 指令覆盖、G2 的分发追踪、F10 插件面板页的宿主、A9/A10 的小扩展 |
| 内置插件（随框架发布，可在 `plugins:` 中停用） | `http`（F8）、`history`（G2 的消息记录）、`long-message`（G6） |
| 官方插件包（单独发布，按需安装） | `@asabot/plugin-render`（F2）。依赖体积约 40MB（satori、resvg 原生模块、中文字体），不适合打进框架本体 |
| 服务端与面板 | G3 群组规则页、G4 调试台、G1 指令管理页、F10 插件页面、G2 消息记录页 |

### 24.1 I1 能力声明与统一降级（修订 5、7、8）

**能力声明**
```ts
interface BotCapabilities {
  segments: readonly string[]       // 能原生发送的段类型；平台专属段写成 '<platform>:*' 表示整个命名空间
  textStyles: readonly TextStyle[]  // text 段 style 中能原样呈现的样式
  actions: readonly string[]        // 支持的 Bot 方法名，例如 'sendForward'、'muteMember'
}
interface Bot { readonly capabilities: BotCapabilities /* ……原有成员 */ }
function supports(bot: Bot, feature: string): boolean   // feature 是段类型或 Bot 方法名
```
- 能力按 Bot 实例声明，因为同一协议的不同实现能力可能不同；适配器最晚在 Bot 上线时确定能力。
- 方法不在 `actions` 中时，调用照旧抛 `UnsupportedError`。`supports()` 只是让插件和框架可以提前判断。
- OneBot 11：`segments` 为 text、at、face、image、audio、video、file、reply、forward 和 `onebot11:*`；`textStyles` 为空；`actions` 包含第 7、22 节的全部中立方法。
- 虚拟适配器：默认支持全部中立段、全部样式和全部方法，可以通过构造选项 `capabilities` 覆盖。`createTestApp({ capabilities })` 和调试台（24.11）都用它模拟能力较弱的平台。
- 面板的 `BotView` 新增 `capabilities`，机器人页展示能力表。

**IR 扩充**（第 5 节新增，仍是扁平的段列表）
```ts
type TextStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'spoiler'
| { type: 'text'; data: { text: string; style?: TextStyle[] } }
| { type: 'markdown'; data: { content: string } }
| { type: 'button'; data: { label: string; kind: 'link' | 'command'; value: string } }  // link：value 为 URL；command：value 为点按后要发送或填入的文本
```
- 构造器：`seg.text(text, style?)`、`seg.markdown(content)`、`seg.button(label, { link } | { command })`。
- 按钮点击回调需要新的事件模型，等接入支持回调按钮的平台时再加。

**平台专属段的命名空间**
- 中立段以外的类型一律写成 `<platform>:<type>`，例如 `onebot11:json`、`onebot11:mface`。收发两个方向使用同一名称：OneBot 适配器入站时加前缀，出站时去掉前缀；CQ 码解析的结果同样带前缀。
- 不带命名空间、又不属于中立段的类型视为插件错误。降级时丢弃这类段，并记 warn。

**统一降级**（`src/core/message/lower.ts`）
- `App.prepareOutgoing` 的顺序改为：先执行发送前钩子（A9），再按目标 Bot 的能力做降级，最后交给适配器编码。合并转发的每个节点分别降级。
- 钩子内部发出的消息会跳过钩子，但仍然要经过降级。
- 降级规则集中在这一处，只测一次。只降级不在 `segments` 中的段：
  | 段 | 降级结果 |
  |---|---|
  | text 的 style | 去掉不支持的样式 |
  | markdown | 去掉标记后的纯文本：标题和列表保留文字，`**x**`、`` `x` `` 去掉符号，`[t](u)` 写成 `t (u)`，代码块保留内容 |
  | button | link 写成 `label: URL`，command 写成 `label：发送 value` |
  | at | `@<id>` |
  | face | `[表情]` |
  | image / audio / video | `[图片]` / `[语音]` / `[视频]` |
  | file | `[文件 name]` |
  | forward | `[合并转发]` |
  | reply | 丢弃 |
  | 其他平台的命名空间段 | 丢弃 |
- 降级后相邻的 text 段合并。降级后消息为空时，发送以 `UnsupportedError(platform, '发送 <段类型>')` 失败。发生降级时记 debug 日志，列出被降级的段类型。
- `bot.message.sent` 里带的是降级后的最终内容。

### 24.2 A9、A10 的扩展

**发送前钩子代为发送**：`BeforeSend` 的返回值新增 `{ deliver: () => Promise<SendResult> }`。
- 含义：钩子决定用别的方式发送这条内容，例如改成合并转发或分段发送。
- 后续钩子不再执行，适配器也不再发送原消息。框架在钩子链之后执行 `deliver`，原调用以它的结果 resolve，它抛出的异常原样传给调用方。
- `deliver` 不受钩子 3 秒超时的限制：钩子只负责尽快做出决定，耗时的发送放在 `deliver` 里。如果直接在钩子里逐条发送，超时后原消息会被照常发出，造成重复。
- `deliver` 里发出的消息跳过钩子，但仍然经过降级，并且各自派发 `bot.message.sent`。
- `AdapterHost.prepareOutgoing` 的返回值为 `Message | { sent: SendResult }`：交付由框架执行，适配器只会拿到它的结果。

**可选服务**：`definePlugin` 的 `inject` 改为接受 `string[] | { required?: string[]; optional?: string[] }`，数组形式等同于 `required`。
- 可选服务缺失时，插件照常加载。`ctx.injectOptional(name)` 返回服务实例或 `undefined`；对没有在 `optional` 中声明的名称调用时，直接抛错。
- 可选服务的提供方出现、消失或重载时，使用方级联重载，因此插件在 setup 中拿到的引用始终有效。
- 面板插件视图的 `inject` 改为 `{ name: string; optional: boolean }[]`。

### 24.3 F3 推送目标（修订 6、7、18）

```ts
interface Target { platform: string; selfId?: string; type: 'group' | 'private'; id: string }
session.target: Target                          // 带 selfId
ctx.send(target: Target | string, content: Sendable): Promise<SendResult>
ctx.broadcast(targets: (Target | string)[], content: Sendable, options?: { interval?: Duration }): Promise<{ target: Target; result?: SendResult; error?: Error }[]>
formatTarget(target): string                    // 'platform:type:id'，带 selfId 时为 'platform:selfId:type:id'（与 channelKey 一致）
parseTarget(text): Target                       // 第二段是 group/private 时按三段解析，否则按四段解析；最后一段之后的内容都属于 id
targetSchema                                    // zod：接受上面的字符串或对象，输出 Target，供插件配置使用
```
- **选择 Bot**：
  - 指定了 `selfId` 时，只用这个 Bot；它不在线时抛出 `DeliveryError`，错误码为 `NO_BOT_ONLINE`。
  - 没有指定时，用该平台第一个在线的 Bot。
- `broadcast` 逐个发送：单个目标失败不影响其余目标，失败记在对应结果的 `error` 中。`interval` 默认为 0，各 Bot 的发送队列照常限速。
- `Target` 是可以序列化的普通对象，可以直接存进 KV 或持久任务（A6）。`MessageTarget { type, id }` 仍然用于 Bot 自己的方法。
- 字符串形式要求 platform 和 selfId 不含冒号，并且 selfId 不能恰好是 `group` 或 `private`；不满足时只能使用对象形式。
- 面板的 `/send` 和对外 API 的 `/api/v1/send` 请求体改为 `{ target: Target | string, message }`，不再接受单独的 `platform`、`selfId` 字段。
- `DeliveryError` 使用稳定的 `code`、`outcome` 和实际目标 `target`，可带 `platformCode`、`confirmedMessageIds`。`not_sent` 表示确定未发出，`unknown` 表示没有可信回执，`partial` 表示至少一段已确认送达。适配器应按回执和请求阶段分类，避免把发出后的断线归为未发送。原始平台错误文本不进入 HTTP 响应。
- 发送 HTTP 错误返回 `{ error: { code, message, outcome, target, platformCode?, confirmedMessageIds? } }`。离线和会话不可用返回 409，限流返回 429，回执超时返回 504，平台拒绝或结果未知返回 502；部分送达一律返回 409，客户端根据 `outcome` 判断能否重发。
- 执行记录和分发步骤保留 `deliveryFailure`，普通投递错误不会触发同一会话的通用错误回复。任务自动重试既要符合任务策略，也要满足投递错误属于确定未发出的离线或限流；收到部分送达或未知结果时需手动确认（`POST /api/panel/tasks/:id/retry?confirmDelivery=1`）。进程在任务运行中异常退出时仍采用既有的至少一次恢复语义。

### 24.4 F4 命令增强（修订 9、10）

- **新类型**：
  - `posint`：正整数；
  - `natural`：非负整数；
  - `date`：返回 `Date`，接受 `YYYY-MM-DD`、`YYYY-MM-DD HH:mm`、`MM-DD`、`HH:mm`，省略的部分取 `timezone` 下的今天。
- **枚举**：类型位置写成 `on|off`，例如 `<mode:on|off>`，选项中同样可以这样写。推断出的类型是 `'on' | 'off'`，输入不在列表中时报参数错误，并列出可选值。
- **约束**：参数用 `.arg(name, settings)` 设置约束，选项在 `.option(name, spec, settings)` 的 `settings` 中设置，两者的字段相同：
  ```ts
  { description?: string; min?: number; max?: number; pattern?: RegExp; validate?: (value) => true | string }
  ```
  - `min`、`max` 用于数值类型，包含边界；`pattern` 用于 `string` 类型。
  - `validate` 返回字符串时，把它作为错误原因回复给用户。
  - `.arg` 指定了未声明的参数名时，注册直接抛错。
  - 错误文案集中放在 `messages.ts`。
  - 参数说明会显示在 help 的命令详情中。
- **匹配器上下文**：`MatchHandler` 改为 `(context: { session; signal; match?: RegExpExecArray }) => …`。pattern 为 RegExp 时，`match` 是对 `session.text` 的匹配结果。现有调用点全部改用新签名。
- **相似命令提示**：新增配置 `command.suggest: 'off' | 'direct' | 'always'`，默认 `direct`。
  - 触发条件：命令没有匹配上，且没有任何匹配器命中，并且满足下面之一：
    - `direct`：私聊、`toMe`；
    - `always`：再加上所有带前缀的消息。
  - 比较方式：取第一个 token，与当前会话可见的命令名和别名比较（与 help 的可见规则相同）。编辑距离不超过 1（名称不超过 4 个字符时）或不超过 2（更长的名称），且只有唯一的最近结果时，回复 `没有这个命令，你是不是想用 /xxx？`。
  - 只给出提示，不自动执行。
  - 设置页的 `command` 表单增加这一项。

### 24.5 F5 过滤上下文与按群配置（修订 9、12、20.3）

**过滤上下文**
```ts
ctx.filter(predicate: (event: DispatchEvent) => boolean): FilteredContext
ctx.platform(...names: string[]): FilteredContext
groupKeyOf(event): string | undefined           // `${platform}:${selfId}:group:${groupId}`；没有 groupId 时为 undefined
```
- `FilteredContext` 只提供 `on`、`middleware`、`command`、`match`、`filter`、`platform`。多次过滤是“且”的关系。资源仍然归原插件所有，随插件卸载回收。
- 实现方式：`Scope` 新增可选的 `filter`。观察者、中间件、命令、匹配器在执行前都检查它；`listCommands`、help 和相似命令提示也按它过滤。
- 带过滤的命令仍然占用全局的命令路径，两个插件不能用互不相交的过滤条件注册同名命令。

**按群配置覆盖**
- `ctx.configFor(target: string | { platform: string; selfId: string; groupId?: string }): Readonly<Config>`：返回该群的有效配置。
  - 字符串参数为 `platform:selfId:group:groupId`。私聊会话应用机器人覆盖。
- **覆盖方式**：按全局原始输入、机器人、群逐层递归合并对象，数组替换，再 schema.parse，填充默认值。结果按插件和作用域缓存，配置变更时失效。
- **存储**：新表 `plugin_group_config(plugin, group_key, config)`，config 为 JSON，通过新增一步 core 迁移创建。purge 时删除该插件的行。
- 修改覆盖项不会重载插件，只有通过 `configFor` 读取的代码会生效；插件在 setup 中读取的全局配置不受影响。
- 全局或机器人配置保存前校验所有受影响子级，任意失败则拒绝保存。
- **PluginManager**：
  - `getGroupConfig(name, groupKey)`；
  - `setGroupConfig(name, groupKey, override | null)`：先对合并结果做校验，失败抛 `PluginConfigError`，带上字段路径；
  - 插件没有声明 config schema 时，拒绝设置覆盖项。

### 24.6 F12 平台 API 拦截

```ts
ctx.interceptApi(
  (call: { bot: Bot; method: string; args: unknown[] }, next: () => Promise<unknown>) => Promise<unknown>,
  { priority?: number },
): Disposer
```
- 采用洋葱模型：
  - 在 `next()` 之前可以修改 `call.args`；
  - 在 `next()` 之后可以修改返回值；
  - 不调用 `next()` 时，直接返回模拟结果；
  - 抛出的异常原样传给调用方。
- 按 priority 降序执行，同一优先级按注册顺序。
- **覆盖范围**：Bot 的所有异步中立方法，加上 `call`。`getAvatarUrl` 只是同步拼出地址、不调用平台，所以不经过拦截器。Session 的 `send` 和 `reply` 按 `sendGroup` / `sendPrivate` 计入；平台专属封装（例如 `bot.onebot.*`）内部统一走 `bot.call`，因此以 `call` 的形式出现。
- **实现位置**：`registerBot` 时，core 在 Bot 实例上原地包装这些方法。适配器在事件中放入的是同一个实例，所以无论从哪里拿到 Bot 引用，调用都会经过拦截器。
- **执行顺序**：发送类调用先经过拦截器，再在适配器内部经过发送前钩子和降级。
- 拦截器内部发起的 API 调用不再经过拦截器（用 AsyncLocalStorage 标记，与 A9 相同）。

### 24.7 G1 指令覆盖（修订 10、18）

```yaml
command:
  prefixes: ['/']
  suggest: direct
  overrides:                       # 键为命令的主路径
    'plugin reload': { permission: superuser }
    echo: { enabled: false }
    weather: { aliases: [天气预报], cooldown: { duration: 30s, scope: group } }
```
```ts
type CommandOverride = {
  enabled?: boolean
  aliases?: string[]                                  // 追加的别名（完整路径）
  permission?: 'everyone' | 'superuser' | 'group.admin' | 'group.owner'   // 替换插件声明的权限；everyone 表示不限制
  cooldown?: { duration: Duration; scope?: 'user' | 'group' | 'global' } | false   // false 表示取消冷却
  hidden?: boolean
}
```
- 覆盖项在运行时生效，分发器在匹配时读取当前值。修改覆盖项不重载插件。
- 停用的命令对所有人（包括超管）都等于不存在：消息会继续交给匹配器处理。
- **别名冲突**：追加的别名与现有路径冲突时，跳过这个别名并记 warn，冲突原因写进 `CommandView.overrideIssues`；插件的加载不受影响。
- 尚未注册的命令，它的覆盖项保留在配置里，等插件加载后生效。
- **按群停用命令**：新表 `command_group_state(command, group_key, enabled)`，由 core 迁移创建。
- **接口**：
  - `CommandView` 新增 `override?: CommandOverride`、`disabledGroups: string[]`、`overrideIssues: string[]`；
  - `PUT /commands/override { path, override: CommandOverride | null }`：写回 YAML `command.overrides.<path>`（null 表示删除），返回最新的 `CommandView`；
  - `PUT /commands/groups { path, groupKey, enabled }`；
  - 命令路径包含空格，所以放在请求体中传递。
- 设置接口（C4）的 `command` 不包含 `overrides`，覆盖项只通过上面的接口修改。
- **面板**：命令页增加启用开关和编辑抽屉，可以编辑别名、权限、冷却和隐藏。

### 24.8 G2 分发追踪与消息记录（修订 6、9、14）

**核心：追踪**
```ts
type TraceStep = {
  stage: 'filter' | 'observer' | 'middleware' | 'prompt' | 'command' | 'matcher' | 'suggest'
  plugin?: string; command?: string
  outcome: 'handled' | 'passed' | 'blocked' | 'denied' | 'cooldown' | 'invalid' | 'error' | 'timeout'
  duration: number; error?: string
}
type DispatchTrace = {
  eventId: string; name: string; platform: string; selfId: string
  channel?: string                // channelKey
  userId?: string
  time: number; duration: number
  steps: TraceStep[]
  sent: string[]                  // 处理过程中发出的消息 ID
}
```
- **记录哪些步骤**：只记录实际执行过的处理器，跳过的不记录。
  - 匹配器只记命中的；中间件调用了 `next` 记为 `passed`，否则记为 `handled`。
  - 被黑名单拦下的事件只有一步：`filter` / `blocked`。
  - 被 prompt 消费的消息记为 `prompt`，`plugin` 填等待中的那个插件。
  - `invalid` 表示参数错误。
- **派发时机**：一次分发（包括观察者）全部结束后，派发内部事件 `dispatch.trace`，事件体为 `{ trace }`，`EventMap` 中有对应类型。内部事件和 meta 事件不产生追踪，`dispatch.trace` 自身也不会被追踪。
- **事件上下文**：分发器在调用处理器时，用 AsyncLocalStorage 记录当前的 eventId。
  - 发出的消息据此关联到触发它的事件：`bot.message.sent` 新增 `eventId?`，同时写入 trace 的 `sent`。
  - logger 用 pino 的 `mixin` 给处理期间的每条日志加上 `eventId`，`LogRecord` 也相应带上这个字段。
- **面板日志页**：可以按 eventId 筛选日志。

**内置插件 `history`**（`src/plugins/history.ts`）
- **记录内容**：收到的消息（`message.*` 会话）、发出的消息（`bot.message.sent`），以及 `dispatch.trace`。
  - 表通过 `ctx.migrate` 创建：`p_history_messages`（自增 id、event_id、direction、platform、self_id、channel、user_id、nickname、message_id、message JSON、text、time）和 `p_history_traces`（event_id 主键、trace JSON、time）。
  - 消息中的 `base64://` 内容只保留前 64 个字符和原始长度，避免撑大数据库。
- **配置**：`retention: 7d`、`maxMessages: 100000`、`ignorePlatforms: ['virtual']`（默认不记录调试台的消息）。每小时清理一次过期数据和超出上限的旧数据。
- 被黑名单拦下的消息不会进入观察者阶段，因此只有 trace（`filter` / `blocked`），没有消息内容。
- **服务 `history`**：
  - `query({ channel?, userId?, before?, limit?, q? })` 返回按时间倒序的消息；
  - `trace(eventId)` 返回对应的追踪记录。
- **面板接口**（通过 F10 的 `ctx.panel.route`，即 `/api/panel/ext/history/*`，需要登录）：
  ```ts
  type HistoryMessage = {
    id: number; eventId?: string; direction: 'in' | 'out'
    platform: string; selfId: string; channel: string    // channelKey
    userId?: string; nickname?: string; messageId?: string
    message: Segment[]; text: string; time: number
  }
  type HistoryChannel = { channel: string; platform: string; selfId: string; type: 'group' | 'private'; id: string; count: number; last: HistoryMessage }
  ```
  - `GET /channels` → `HistoryChannel[]`：按最后一条消息的时间倒序，最多 200 个；
  - `GET /messages?channel=&before=&limit=&q=` → `{ items: HistoryMessage[]; more: boolean }`：
    - 按 id 倒序；
    - `before` 是上一页最后一条的 id；
    - `limit` 默认 50，最大 200；
    - `q` 对 text 做包含匹配；
    - 省略 channel 时查全部会话；
  - `GET /traces/:eventId` → `DispatchTrace`，没有记录时返回 404；
  - `GET /export?channel=` → `application/x-ndjson`，每行一条 `HistoryMessage`，按时间正序。
- **面板**：原生页面“消息记录”，由我编写，插件处于 active 时显示。左侧是会话列表，右侧是消息流；点击收到的消息可以展开查看它的处理链，以及这次处理产生的日志。

### 24.9 F10 插件面板页（修订 12、18、19）

```ts
ctx.panel.page({ title: string; icon?: string; root: URL | string; entry?: string })   // root 为静态文件目录，entry 默认 index.html；每个插件最多一个页面
ctx.panel.route((app: Hono) => void)                // 挂在 /api/panel/ext/<name>/*，需要面板登录，CSRF 规则与其他面板接口相同
ctx.panel.push(topic: string, data: unknown)        // 通过面板实时推送发出 { type: 'plugin-event', plugin, topic, data }
```
- **静态文件**：通过 `/plugin-pages/<name>/*` 提供。
  - 不需要登录，因为沙箱 iframe 的请求不会带上 cookie。文档要求页面文件中不能放敏感数据，数据一律通过 `panel.route` 获取。
  - 响应头带 `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`，即使有人直接打开这个地址，页面也处在沙箱中。另带 `Access-Control-Allow-Origin: *`，保证沙箱页面能加载模块脚本。
  - 路径穿越检查与插件上传相同。
- **面板宿主**：
  - 路由为 `/pages/<name>`，用 `<iframe sandbox="allow-scripts allow-forms allow-popups">` 加载页面，不给 `allow-same-origin`，页面因此读不到面板的 cookie 和 DOM。
  - 侧边栏增加“插件页面”分组。
  - 页面标题固定在 iframe 上方，iframe 填满剩余空间，宿主正文不滚动。插件可以直接滚动 iframe 内的文档，或用 `PluginPageLayout` 固定工具栏，把滚动放在正文区域。
  - `PluginView` 新增 `page?: { title: string; icon?: string }`。
- **桥接协议**（postMessage；宿主只处理当前页面 iframe 发来的消息）：
  - 页面 → 宿主：
    - `{ asabot: 1, kind: 'ready' }`：SDK 加载后立即发送，宿主收到后回复一次 theme；
    - `{ asabot: 1, id, kind: 'fetch', path, method, body? }`：宿主带 cookie 请求 `/api/panel/ext/<name><path>`，然后回复 `{ asabot: 1, id, status, body }`。网络失败时 `status` 为 0；
    - `{ asabot: 1, kind: 'toast', text, level? }`：在面板中显示提示；
    - `{ asabot: 1, kind: 'open-command-palette' }`：SDK 在插件页捕获 `Ctrl/⌘ + K` 后发送。宿主仅在该 iframe 有焦点时打开命令面板，关闭时若仍在原页面则把焦点还给插件。
  - 宿主 → 页面：
    - `{ asabot: 1, kind: 'theme', mode, tokens }`：收到 ready 时和主题切换时发送；
    - `{ asabot: 1, kind: 'restore-focus' }`：命令面板关闭后，SDK 把焦点还给触发快捷键的控件；
    - `{ asabot: 1, kind: 'event', topic, data }`：转发该插件的 `plugin-event`。
- **客户端 SDK**：
  - SDK 是面板的一部分，源文件为 `web/public/plugin-pages/_sdk.js`，随面板构建进入 `web/dist`，由现有的面板静态托管在 `/plugin-pages/_sdk.js` 提供。`/plugin-pages/:name/*` 路由只处理合法的插件名，以 `_` 开头的路径交给面板静态托管。
  - 插件页面用普通 `<script src="/plugin-pages/_sdk.js">` 加载 SDK。
  - 提供 `asabot.fetch(path, init)`、`asabot.json(path, init)`、`asabot.on(topic, fn)`、`asabot.toast(text, level?)`、`asabot.theme`。
  - 自动把主题变量写到 `:root`，插件页面直接使用面板的配色。
- **共享 UI**：控制台和 React 插件复用 `@asabot/panel-ui` 的组件和主题。插件将组件、`styles.css` 与自己的代码打包进 iframe 页面；字体单独从 `fonts.css` 按需导入。共享组件通过 props 读写数据，控制台的路由和 API 客户端不进入该包。
- 内置插件（例如 history）的页面由面板原生实现，但数据接口同样走 `ctx.panel.route`。

### 24.10 G3 群组规则（修订 18、19）

- **`GET /groups`** 返回 `GroupView[]`：
  ```ts
  { groupKey, platform, selfId, groupId, name?, bots: string[], rules: { plugins: number; configs: number; commands: number }, access?: 'block' | 'allow' }
  ```
  - 群列表合并两个来源：在线 Bot 的群列表（缓存 5 分钟，`?refresh=1` 时强制刷新），以及在 `plugin_group_state`、`plugin_group_config`、`command_group_state` 中出现过的 groupKey。
- **`GET /groups/:groupKey`** 返回：
  ```ts
  { group: GroupView; plugins: { name; enabled: boolean; configurable: boolean; override?: unknown }[]; commands: { path; owner; enabled: boolean }[] }
  ```
- **修改**：
  - `PUT /plugins/:name/groups/:groupKey { enabled?, config?: object | null }`：配置覆盖项校验失败时返回 400，`issues` 带字段路径；
  - `PUT /commands/groups`（见 24.7）；
  - 访问控制沿用 `/acl`。
- `GET /plugins/:name/groups` 返回 `{ groupKey, enabled?, config? }[]`，只列出有设置的群。
- **面板**：新增“群组”页面。点开某个群后有三个分区：
  - 插件：开关，以及配置覆盖表单。表单预填有效配置，保存时只提交与全局配置不同的顶层键。
  - 命令：开关。
  - 访问控制：拉黑或加入白名单。

### 24.11 G4 调试台（修订 18）

- **`POST /playground`**：
  - 请求新增 `capabilities?: Partial<BotCapabilities>`，用来模拟能力较弱的平台。
  - 响应改为：
    ```ts
    { incoming: { messageId }; replies: { messageId; message: Segment[]; text: string }[]; actions: { action: string; params: Record<string, unknown> }[]; traces: DispatchTrace[]; logs: LogRecord[] }
    ```
    - `actions` 是虚拟 Bot 在这次处理中记录的群管理等操作；
    - `traces` 和 `logs` 包含这次请求触发的所有事件。
  - 收发的消息都有 messageId，面板可以引用之前的消息（reply 段），虚拟 Bot 的 `getMessage` 能查到这些消息。
- **`POST /playground/event { name, user, group?, fields? }`**：模拟通知和请求事件，响应格式同上，只是没有 `incoming`（通知和请求没有消息 ID）。
  - 支持的 name：`notice.member.join`、`notice.member.leave`、`notice.member.mute`、`notice.poke`、`notice.message.recall`、`request.friend`、`request.group.join`、`request.group.invite`。
  - 请求事件被 `approve` / `reject` 时，记入 `actions`。
- 消息段仍然遵守 E2：图片以 `base64://` 上传，单个请求不超过 2MB。
- **面板**：
  - 输入区支持粘贴或选择图片、@ 某个用户、引用某条消息，以及从菜单发送通知或请求；
  - 气泡中渲染图片；
  - 每次回复下面可以展开处理链和日志；
  - 有一个开关用来模拟纯文本平台。

### 24.12 F1 发布与起步（修订 2、3、20.2）

- **包名**：
  - 框架发布为 `@asabot/core`，子路径不变：`@asabot/core/testing`、`@asabot/core/onebot11`、`@asabot/core/onebot11/testing`。
  - 仓库内所有 `from 'asabot'` 改为 `from '@asabot/core'`，`declare module 'asabot'` 同样改。
  - 插件包的 `peerDependencies` 改为声明 `@asabot/core`。加载钩子保证 `@asabot/core` 解析到当前运行的框架实例。
  - 第三方插件包继续使用 `asabot-plugin-*` 命名和 `asabot-plugin` 关键词；官方插件包命名为 `@asabot/plugin-*`，同样带这个关键词。
- **构建**：
  - 仓库内的开发方式不变，仍然直接运行 `.ts`。
  - `pnpm build` 依次构建共享 UI 包、面板（`web/dist`）和框架代码（`dist`，只包含 `src`，排除测试文件）。面板从 workspace 读取共享组件和主题源码，单独构建面板时无需预先构建 UI 包。
  - 发布用的 `exports`、`bin` 放在 `publishConfig` 中，`pnpm publish` 时替换成 dist 路径；`files` 为 `dist`、`web/dist`、README、LICENSE、`asabot.config.example.yaml`。
  - 服务端按模块相对路径 `../../web/dist` 查找面板，这个相对路径在仓库和发布包中都成立。
- **CLI**：`bin: { asabot }`。
  - `asabot start [--config <path>]`：现在 `main.ts` 的行为。
  - `asabot dev`：强制开启热重载，使用 pretty 日志。
  - `asabot --version`。
  - `main.ts` 的逻辑移入 `src/cli.ts`，`pnpm start` / `pnpm dev` 改为调用它。
- **脚手架** `@asabot/create`（workspace 包 `packages/create`，用法 `npm create @asabot@latest [dir]`）：
  - 交互式询问模板和目录，基于 node:readline，不引入依赖；也可以用 `--template bot|plugin --name <n> --yes --install` 跳过询问。
  - **`bot` 模板**：
    - `package.json`：依赖 `@asabot/core`，scripts 为 `start` / `dev`；
    - `plugins/hello.ts`；
    - `tsconfig.json`：只用于编辑器类型检查；
    - `.gitignore`：忽略 data、`asabot.config.yaml`、`.env`；
    - README。
    - 不生成配置文件，首次启动走设置向导（第 23 节）。
  - **`plugin` 模板**：
    - 一个 `asabot-plugin-<name>` 包；
    - `src/index.ts`，用 tsc 构建出 JS 和 `.d.ts`；
    - keywords 和 `peerDependencies`；
    - 一个 `createTestApp` 的 vitest 示例；
    - 发布说明。
- **文档注释**：`src/index.ts` 导出的每个公开 API 都有 JSDoc，Context 的方法和 Session、Bot、seg 的成员要写到“做什么、何时失败”。
- **发布流程**：
  1. 用 `pnpm pack` 打出 tarball；
  2. 在临时目录中用 `bot` 模板和这个 tarball 起一个项目，验证首次运行向导、插件加载和面板访问；
  3. 用 `plugin` 模板构建一个插件包，并验证能安装到这个项目；
  4. 上述全部通过后才发布。首个版本为 0.1.0。

### 24.13 F8 内置插件 `http`

```ts
interface HttpService {
  fetch(url: string | URL, init?: HttpInit): Promise<Response>
  json<T = unknown>(url: string | URL, init?: HttpInit): Promise<T>
  text(url: string | URL, init?: HttpInit): Promise<string>
  buffer(url: string | URL, init?: HttpInit): Promise<Buffer>
}
type HttpInit = RequestInit & { timeout?: Duration; proxy?: boolean | string; maxSize?: number }
```
- **配置**：
  ```yaml
  proxy: ''              # 例如 http://127.0.0.1:7890，可写 ${HTTPS_PROXY:-}
  noProxy: []            # 不走代理的主机，支持 *.example.com
  timeout: 30s
  userAgent: ''          # 为空时用 AsaBot/<version>
  ```
- 代理通过 `undici` 的 `ProxyAgent` 实现。`proxy: false` 表示这次请求不走代理，传入字符串则使用指定的代理。
- **错误与限制**：
  - `json`、`text`、`buffer` 在响应不是 2xx 时抛 `HttpError { status, url }`，其中 url 只保留 origin 和 pathname，避免泄露查询参数里的 token。
  - 响应体超过 `maxSize`（默认 10MB）时中止请求。
  - 插件传入的 `signal` 与超时信号合并。
- 缓存不另做服务，文档推荐使用 `ctx.store.set(key, value, { ttl })`。

### 24.14 G6 内置插件 `long-message`

- 通过发送前钩子处理过长的消息，priority 为 -100，排在修改内容的钩子之后。
- **配置**（支持按群覆盖，通过 `configFor(target)` 读取）：
  ```yaml
  threshold: 1000        # 纯文本长度超过这个值时处理
  strategy: forward      # forward | image | split
  chunkSize: 800
  splitInterval: 1s
  markdownAsImage: true  # 平台不支持 markdown 段、且有 render 服务时，把 markdown 段渲染成图片
  ```
- **适用范围**：只处理由 text、at、face、reply、markdown 组成的消息；带媒体的消息原样放行。
- **三种策略**（条件不满足时依次退到下一种）：
  - `image`：需要 `render` 服务（可选注入）。text 用 `render.text`，markdown 用 `render.markdown`，结果作为一张图片，替换原消息返回。
  - `forward`：需要 `supports(bot, 'sendForward')`。按段落把文本切成不超过 `chunkSize` 的节点，节点的发送者为机器人自己，通过 `{ deliver }` 发出合并转发。
  - `split`：按段落和句子切成不超过 `chunkSize` 的多条消息，通过 `{ deliver }` 间隔 `splitInterval` 依次发出；reply 段只保留在第一条，原调用拿到最后一条的结果。

### 24.15 F2 官方插件包 `@asabot/plugin-render`

- **位置**：workspace 包 `packages/plugin-render`，插件名 `render`，提供 `render` 服务，可选注入 `http`（用来下载 emoji）。
  ```ts
  interface RenderService {
    element(node: RenderNode, options?: RenderOptions): Promise<Buffer>      // satori 的 { type, props } 节点；PNG
    html(html: string, options?: RenderOptions): Promise<Buffer>             // 用 satori-html 解析，只支持 satori 的 CSS 子集（flex 布局）
    markdown(markdown: string, options?: RenderOptions & { theme?: 'light' | 'dark' }): Promise<Buffer>
    text(text: string, options?: RenderOptions & { theme?: 'light' | 'dark' }): Promise<Buffer>
    page(input: { html: string } | { url: string }, options?: { width?: number; selector?: string; timeout?: Duration }): Promise<Buffer>  // 浏览器后端
  }
  type RenderOptions = { width?: number; height?: number; scale?: number }
  ```
- **默认后端**：satori 加 `@resvg/resvg-js`。
  - resvg 必须关闭系统字体加载（`font.loadSystemFonts: false`）。satori 输出的是字形路径，resvg 用不到字体；不关闭的话每次渲染会多花约 500ms。
  - 实测首次渲染需要约 0.8s 解析字体，之后每张图不到 10ms。
- **markdown 的渲染**：用 `marked` 的词法分析结果构建 satori 节点树。所有块级元素都用 flex 列布局；支持标题、段落、列表、引用、代码块、行内样式和链接文字，表格按行列简单排版。
- **字体**：
  - 内置 Noto Sans SC 的 400 和 700 两个字重，每个字重是约 100 个 unicode-range 子集的 woff 文件，各约 4.7MB。构建时从 `@fontsource/noto-sans-sc`（devDependency）复制到包内的 `fonts/`，同时附带 OFL 许可证。
  - 每个子集注册为不同的字体名。实测这样才能按字符回退；用同一个名字注册时会全部显示成方块。
  - 配置 `fonts: string[]` 可以追加 ttf、otf、woff 文件，追加的字体排在前面。satori 不支持 woff2 和 ttc。
- **emoji**：通过 satori 的 `loadAdditionalAsset` 加载 Twemoji SVG。
  - 配置 `emoji: twemoji | none`，以及 `emojiBaseUrl`（默认为 jsDelivr 上的 jdecked/twemoji）。
  - 缓存在内存和 `ctx.dataDir/emoji/` 中。
  - 下载失败时这个字符留空，并记 debug 日志。
- **浏览器后端**：配置 `browser.executablePath`（本机的 Chrome 或 Edge）或 `browser.wsEndpoint`，用 `puppeteer-core` 驱动。
  - 未配置时，`page()` 抛 `UnsupportedError('render', 'page')`。
  - 浏览器实例懒启动，空闲 5 分钟后关闭，同时打开的页面数不超过 `browser.concurrency`（默认 2）。
  - `page({ url })` 只接受 http(s) 地址。
- 渲染失败时以带原因的错误 reject，插件自己决定是否降级成文本。

### 24.16 实施顺序

1. **F1a**：改包名和导入、构建、CLI、`publishConfig`（暂不发布）。这一步最机械，但会改动所有文件，所以放在最前面，避免和后续改动冲突。
2. **核心**：I1、24.2、F3、F4、F5、F12、G1 的核心部分、G2 的追踪和日志 eventId。
3. **服务端接口**：F10、G1、G3、G4 的接口，`BotView.capabilities`，`/send` 的新请求体。
4. **插件**：内置插件 http、history、long-message，以及官方插件包 plugin-render。
5. **F1b**：脚手架、JSDoc、README，然后按 24.12 的流程验证并发布。
6. **面板**（我编写，接口就绪后进行）：能力表、命令管理、群组页、消息记录、调试台增强、插件页面宿主、设置项 `command.suggest`。

## 飞书第二适配器

- `connections` 中每条飞书记录配置独立 appId/appSecret，支持多个国内飞书企业自建应用，使用官方 SDK 长连接。SDK ready/reconnecting/error 驱动机器人状态，关闭和重配置回收连接并隔离旧回调。
- 平台 ID 为机器人/用户 open_id、群 chat_id；平台专属 API 和类型从 `@asabot/core/feishu` 导出，核心保持协议无关。
- 收发文本、提及、引用、富文本、图片、语音、视频和文件；媒体统一限制超时和大小。另支持飞书表情、表情包和分享名片。混合消息按原顺序拆分，逐条记录发送，返回最后 ID。成员、机器人进退群与撤回事件按可用身份信息映射，事件使用有界 TTL 去重。
- `Target`、`Session`、`SendResult` 和收发记录可携带 `thread: { id, rootMessageId }`。使用 `sendTo` 按完整地址投递；飞书用根消息 ID 发话题回复，用话题 ID 转发和查历史。追问与消息记录按话题隔离，群策略与群冷却使用所在群。主动开话题的发送钩子可通过 `sendFirst` 先交付首段，取得话题地址后再继续发送。
- 飞书专属 API 按页读取会话及话题历史、已读成员、表情回复与 Pin；支持转发已有消息、切换群消息形式、处理群成员与应用内加急。合并转发、加人、加急保留平台报告的部分失败结果。增加表情回复、群配置变更、单聊已读三类通知。
- 配置、权限和真实联调步骤见 [FEISHU.md](FEISHU.md)。本轮不增加业务内置插件。
- Markdown、按钮及 JSON 2.0 原生卡片通过适配器发送；`notice.feishu.card.action` 保留完整表单，并提供 2 秒内一次性的 `respond`。超时后可通过 `feishu.updateCard` 更新；有签名的命令按钮以点击者身份进入现有命令管线，表单值不转换为命令。卡片话题先读本地有界缓存，再通过原消息恢复；查不到目的地时不执行签名命令。

## 已知限制

- **取消是协作式的**：插件代码如果不理会 `signal`，被取消（超时、卸载、退出）后仍会继续执行；框架只是不再等待它，也不会自动发送它的返回值。
- **热重载的内存代价**：Node 的 ESM 模块缓存无法清除，每次重载都会保留一份旧模块，长时间频繁重载后应重启进程。
- **超大数字 ID**：OneBot JSON 中的数字按 JavaScript `Number` 解析，超过 2^53 的 ID 会丢失精度。QQ 号、群号和常见 OneBot 实现的 message_id（int32）都远小于这个范围，暂不处理。
- **whenIdle**：见 12.1，处理器把 prompt 与其他异步任务并行等待时可能提前 resolve，只影响测试辅助。
- **`bot.call()` 不经过发送前钩子**：透传的平台 API 由插件自己负责，框架不解析其中是否在发送消息。
- **插件市场排序范围**：搜索结果最多取 250 条参与排序和分页，超出部分需要更精确的关键词。
- **删除插件文件**：入口文件删除后插件会被卸载并从列表中移除；依赖它的插件进入 failed，入口恢复后自动恢复。
- **带过滤的命令仍占用全局路径**：两个插件不能用互不相交的过滤条件注册同名命令（24.5）。
- **按群配置只对 `configFor` 生效**：插件在 setup 中读取的全局配置（例如 cron 表达式）不会随群覆盖变化。
- **satori 的 CSS 子集**：`render.html` 只支持 flex 布局和 satori 支持的属性，需要完整 CSS 时用浏览器后端的 `render.page`。
- **插件页面的静态文件公开**：`/plugin-pages/<name>/*` 无需登录即可访问，数据必须走需要登录的 `ctx.panel.route`。


## 机器人作用域与插件配置

- 框架管理员 `superusers` 使用 `{ platform, selfId, userId }` 身份；机器人的管理员存于 `bot_admins`，通过 `Session.isBotAdmin` 和 `bot.admin` 权限访问本机器人管理操作。包安装、卸载和全局插件启停仍要求框架管理员。
- 群规则键统一为 `platform:selfId:group:groupId`，同平台的不同机器人拥有独立群规则。访问控制列表仍为框架级平台用户/群列表。
- 插件可以声明 `capabilities: { required?, optional? }`，各项包含 `segments`、`textStyles`、`actions`。能力缺失仅用于兼容性提示；`inject.required` 服务缺失仍阻止插件加载。
- `plugin_bot_policy` 保存机器人插件开关与配置覆盖。机器人插件停用影响事件、命令、发送前钩子、API 拦截和该插件的后台 Bot API 调用。插件实例、服务与任务调度仍为全局资源。
- 插件首次载入时，如果 `plugins.<name>.defaultOnNewBots` 未设置，保存插件声明的值，未声明时保存 `false`。账号首次登记时，`bot_plugin_defaults` 保存当时默认启用的插件。全局停用优先；全局启用时使用机器人的开关覆盖或登记时的初始值，再检查群开关。调试台使用全局启用的插件。
- `ctx.config` 是全局配置；`ctx.configFor(botOrSession | groupKey)` 按全局原始配置 → 机器人覆盖 → 群覆盖递归合并对象、整体替换数组，再执行 schema 解析和默认值填充。删除覆盖项恢复继承。
- 保存父级配置前校验所有受影响的子级有效配置，失败时拒绝写入；不再静默回落全局配置。本节替代 24.5 中的顶层覆盖及失效回落规则。


## 独立连接与适配器注册

- 根配置使用 `connections: [{ id, name, adapter, enabled, config }]`；`id` 在登录前已存在，每条记录拥有独立驱动、错误、状态变化和重试时间。飞书每个应用一条连接；OneBot 正向和反向分别建连接，反向监听允许多账号接入。根配置的旧 `adapters` 分组格式已移除。
- 连接状态包括 disabled、connecting、waiting、online、retrying、error、offline；真实驱动通过可选 `AdapterHost.connection.update()` 上报。成功上线会保留最近一次错误及发生时间，便于排查，当前状态单独展示。
- 反向接入点为 `/connections/<id>/onebot/v11/ws`。连接单独编辑、停用、重连和删除；同协议的其他连接不受影响。
- 核心公开 `AdapterDefinition`、`defineAdapter()`。独立包默认导出适配器定义，包含 id、platform、name、version、description、connectionTypes、capabilities、configSchema 和 create。内置驱动与外部包使用同一注册契约。
- 已知固定账号的驱动可声明 `accountId(config)`（扫码驱动必填）。配置保存和启动前按平台及账号查重；换号时停止原驱动、清除状态并使用新账号的存储命名空间。企业微信按 BotID 绑定，认证失败、订阅超时或服务端通知被另一连接替换时停在错误状态，普通断线自动重连。
- `bot_accounts` 按平台与 selfId 保存账号档案，记录昵称、公开头像、能力、连接关联和最近上线时间。面板从档案与实时实例合成视图；列表、详情与策略编辑可以离线使用，群列表和发送仍需要在线实例。框架会从旧版已记录的账号初始化档案，待下次上线补齐资料；虚拟机器人不持久化。
- selfId 只能在平台登录后得知时，适配器可用 `botBinding(config)` 提供稳定的远端标识。框架用连接 ID 和标识的摘要识别关联；删除连接、改变标识或单账号连接识别到新账号时，解除旧账号关联。反向监听可声明 `multiple: true`，保留多个已接入账号。
- 用户先用项目包管理器安装包，再在 `adapterModules` 中填写 npm 包名（可包含子路径），CLI 从项目工作目录按 Node import 条件解析并在启动时加载。程序化 `createApp` 可通过 options.adapters 注入定义。面板展示来源、schema 和实现能力，本轮不提供适配器市场或热升级。
- 连接表单从 schema 生成；常见敏感字段及 schema 的 writeOnly 字段掩码返回，保留环境变量引用和 YAML 注释，错误返回也按 schema 脱敏。
- 插件的机器人应用与群配置接口返回有效配置和字段来源（global、bot、group、default）。`connections` 和 `policies` 实时帧用于失效缓存并重新拉取真实数据，断线重连时统一刷新缓存。
