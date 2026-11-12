# STATUS

最后更新：2026-11-12

## 里程碑

| # | 内容 | 状态 | 证据 |
|---|---|---|---|
| M0 | 脚手架、配置、日志、main 骨架 | runnable | `pnpm typecheck`、`pnpm lint`、`pnpm test` 通过（17 tests）；示例配置下 `node src/main.ts` 能启动；`process.emit('SIGINT')` 模拟信号可优雅退出（exit 0）；错误配置输出路径化信息（`dispatch.handlerTimeout: Invalid duration`、`onebot11.connections[0].url: Invalid URL`），exit 1。主控审查后修正：退出时显式 `process.exit`；ConfigError 改为打印可读信息、不输出堆栈；vitest 增加 `test/**`。Windows 上的真实 Ctrl+C 未验证 |
| M1 | 消息/事件模型、OneBot 正向 WS、MockOneBot | 未开始 | — |
| M2 | 分发管线、命令、prompt、权限、冷却 | 未开始 | — |
| M3 | 插件系统、热重载、存储、定时任务、内置插件、端到端测试 | 未开始 | — |
| M4–M7 | 第二期：反向 WS、发送队列、HTTP、面板、Docker、沙盒 | 待第一期验收后开始 | — |

## 已验证的技术前提

- Node v26.5：可直接运行 `.ts`；`node:sqlite` 可用。
- `module.registerHooks` + 带版本号的 URL 实现热重载：插件内的相对导入能一起更新；新版本有语法错误时旧实例保持不变。

## 环境说明

- 用户的 NapCat 运行在远程 Docker 中，没有对外暴露端口，开发机无法联调。所有验证只能通过 MockOneBot 进行，真实联调由用户自己完成。

## 待决问题

- （无）

## 已知问题

- （无）
