# AsaBot

TypeScript QQ 机器人框架。核心层与平台无关，首个适配器为 OneBot 11（对接 NapCat）。

**权威设计文档：[docs/DESIGN.md](docs/DESIGN.md)**。实现前先读对应章节。发现设计缺陷时，在交付说明中提出，不要静默偏离设计。

## 运行与检查

```sh
pnpm install
pnpm dev          # node src/cli.ts dev（强制开启插件热重载）
pnpm start        # node src/cli.ts start
pnpm build        # 构建面板和发布用的 dist（JS + d.ts）
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome check
pnpm test         # vitest run
```

## 硬性约束

- Node ≥ 24，仓库内直接运行 `.ts`（原生类型剥离）。构建只用于发布 npm 包（`pnpm build`，产物在 dist/，见 DESIGN 24.12）。
  - 禁止 `enum`、`namespace`、构造函数参数属性、`import = require`。
  - 相对导入必须带 `.ts` 后缀；纯类型导入用 `import type`。
- 框架包名是 `@asabot/core`，插件通过 `import ... from '@asabot/core'` 导入（包自引用）。zod 从 `@asabot/core` 再导出。
- `src/core/**` 不得导入 `src/adapters/**`、`src/plugins/**`、`src/server/**`。
- core 层的平台 ID 一律用 `string`；数字与字符串的转换由适配器负责。
- 依赖只能通过 `pnpm add` 管理，不要手改 lockfile。
- 日志和错误信息中不得出现 token、密码或带 `access_token` 的 URL。
- 不要吞掉异常。插件和处理函数的异常必须带上插件名和事件上下文记录日志。
- 行尾统一为 LF（见 `.gitattributes`）。

## 测试原则

- 只为核心契约写测试：协议边界、状态转换、错误与取消、资源回收、解析器、权限，以及容易复发的缺陷。不要因为改了代码就顺手补测试，不测平凡行为、内部调用顺序和界面细节。
- 优先用 `src/testing/` 中的 MockOneBot / createTestApp 做行为级测试。

## 进度与提交

- 不维护 STATUS.md、DEVLOG.md 之类的进度文档。进度看提交历史，未完成项用代码里的 `TODO:` / `FIXME:` 标注，设计层面的已知限制写在 DESIGN.md 的「已知限制」一节。
- 每个功能切片验证通过后提交一次，只暂存本切片的文件。不推送到远端。
