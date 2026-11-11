# AsaBot

TypeScript QQ 机器人框架。核心层与平台无关，首个适配器为 OneBot 11（对接 NapCat）。

**权威设计文档：[docs/DESIGN.md](docs/DESIGN.md)**。实现前先读对应章节。发现设计缺陷时，先在 STATUS.md 的「待决问题」中记录，不要静默偏离设计。

## 运行与检查

```sh
pnpm install
pnpm dev          # node --watch src/main.ts（开发）
pnpm start        # node src/main.ts
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome check
pnpm test         # vitest run
```

## 硬性约束

- Node ≥ 24，直接运行 `.ts`（原生类型剥离），**没有构建步骤**。
  - 禁止 `enum`、`namespace`、构造函数参数属性、`import = require`。
  - 相对导入必须带 `.ts` 后缀；纯类型导入用 `import type`。
- 插件通过 `import ... from 'asabot'` 导入框架（包自引用）。zod 从 `asabot` 再导出。
- `src/core/**` 不得导入 `src/adapters/**`、`src/plugins/**`、`src/server/**`。
- core 层的平台 ID 一律用 `string`；数字与字符串的转换由适配器负责。
- 依赖只能通过 `pnpm add` 管理，不要手改 lockfile。
- 日志和错误信息中不得出现 token、密码或带 `access_token` 的 URL。
- 不要吞掉异常。插件和处理函数的异常必须带上插件名和事件上下文记录日志。
- 行尾统一为 LF（见 `.gitattributes`）。

## 测试原则

- 测试稳定契约：协议边界、状态转换、错误与取消、资源回收、解析器、权限。不要测试平凡的或语言本身保证的行为。
- 优先用 `src/testing/` 中的 MockOneBot / createTestApp 做行为级测试，避免断言内部调用顺序。
- 不要为了覆盖率写测试。

## 进度记录协议

- `STATUS.md`：当前状态的快照，包括里程碑表、证据等级、待决问题、已知问题。每个里程碑完成、集成、验证、提交或交接时更新。
- 证据等级依次为：**implemented**（代码存在）→ **verified**（typecheck、lint、test 通过）→ **integrated**（接入 App 并在端到端中被走到）→ **runnable**（`node src/main.ts` 能实际运行）→ **accepted**（只能由用户确认）。
- 只记录结论和证据（运行了哪些命令、结果如何），不记录操作流水账。
- 每个里程碑一个本地提交，提交信息格式为 `M<n>: <摘要>`。不推送到远端。
