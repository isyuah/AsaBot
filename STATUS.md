# STATUS

最后更新：2026-11-12

## 里程碑

| # | 内容 | 状态 | 证据 |
|---|---|---|---|
| M0 | 脚手架、配置、日志、main 骨架 | runnable | `pnpm typecheck`、`pnpm lint`、`pnpm test` 通过（17 tests）；示例配置下 `node src/main.ts` 能启动；`process.emit('SIGINT')` 模拟信号可优雅退出（exit 0）；错误配置输出路径化信息（`dispatch.handlerTimeout: Invalid duration`、`onebot11.connections[0].url: Invalid URL`），exit 1。主控审查后修正：退出时显式 `process.exit`；ConfigError 改为打印可读信息、不输出堆栈；vitest 增加 `test/**`。Windows 上的真实 Ctrl+C 未验证 |
| M1 | 消息/事件模型、OneBot 正向 WS、MockOneBot | integrated | `pnpm typecheck`、`pnpm lint`、`pnpm test` 连续两轮通过（35 tests）；临时 smoke 脚本经 MockOneBot 和 `createApp` 收到 `hello`，发出带 reply 段的 `send_group_msg`，stop 后进程正常退出；集成测试覆盖 API 超时与错误、断线时挂起请求被 reject、同账号重连后 Bot 实例不变、换号、鉴权失败退避、ping 和 heartbeat 超时重连。主控审查后修正并补了回归测试：出站媒体只内联 `file://`，收到的图片原样转发时透传；`forward` 段 id 不再强制转成数字；登录完成前到达的事件改为缓冲，最多 200 条，不再丢弃；连接错误日志保留 message 和 code（例如 ECONNREFUSED），token 已脱敏。未与真实 NapCat 联调 |
| M2 | 分发管线、命令、prompt、权限、冷却 | integrated | `pnpm typecheck`、`pnpm lint`、`pnpm test` 连续两轮通过（71 tests）；临时脚本经 MockOneBot 和 `createApp` 走通 `/echo hi`、`/ask`、`Alice`、`/nope`，依次发出 `hi`、`你的名字？`、`你好，Alice`，未知命令不回复。`rest` 的结果类型为 `Message`，保留非文本段；类型推断由 `inference.test-d.ts` 加 typecheck 验证。黑白名单和按群开关目前是默认放行的钩子（M3 接入存储）。主控审查后修正：别名按完整路径解析；冷却改为参数解析成功后才计入；用户作用域的 prompt 优先；`handlerTimeout` 默认值从 10m 改为 1h（原值小于 `maxPromptTimeout`，多轮交互会被误中止） |
| M3a | 插件系统、热重载、存储、定时任务、YAML 写回、createTestApp | 未开始 | — |
| M3b | 内置插件、示例插件、README、端到端测试 | 未开始 | — |
| M4–M7 | 第二期：反向 WS、发送队列、HTTP、面板、Docker、沙盒 | 待第一期验收后开始 | — |

## 已验证的技术前提

- Node v26.5：可直接运行 `.ts`；`node:sqlite` 可用。
- `module.registerHooks` + 带版本号的 URL 实现热重载：插件内的相对导入能一起更新；新版本有语法错误时旧实例保持不变。

## 环境说明

- 用户的 NapCat 运行在远程 Docker 中，没有对外暴露端口，开发机无法联调。所有验证只能通过 MockOneBot 进行，真实联调由用户自己完成。

## 待决问题

（无。M2 提出的三项已经处理：别名按完整路径解析；类型推断测试改用合法的声明；用户作用域的 prompt 优先于 channel 作用域。三项结论都已写入 DESIGN，并配有测试。）

## 已知问题

- OneBot JSON 数字使用 JavaScript `Number` 解析；超过安全整数范围的数字 ID 会失去精度，出站时的安全整数检查会拒绝这类 ID。QQ 号、群号和 NapCat 的 message_id（int32）都远小于 2^53，实际风险很低，暂不处理。
- 处理器取消是协作式的：忽略 signal 的插件代码仍可能继续执行，框架会停止等待且不会自动发送其返回值。
