# 工程与代码规范

## 运行与验证

```sh
pnpm dev          # node src/cli.ts dev，强制开启插件热重载
pnpm start        # node src/cli.ts start
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome check
pnpm test         # vitest run
pnpm build        # 面板 + 发布用 dist，只在发布前需要
```

改动后按范围验证：所有改动至少跑 `pnpm typecheck` 和 `pnpm lint`；改了核心契约（分发、命令、存储、插件生命周期、协议转换）再跑 `pnpm test`；改了面板或插件页，构建对应包并实际打开页面检查，不能只靠类型检查。在交付说明里写明跑了哪些命令。

## 语言与模块

仓库直接运行 `.ts`，依赖 Node 24 的原生类型剥离。因此只能使用可擦除语法：

```ts
// 正确
export interface Options {
  retries?: number
}

export function retry(options: Options = {}) {
  return options.retries ?? 2
}

// 禁止：enum、namespace、构造函数参数属性、import = require
enum Mode { On, Off }
class Client { constructor(private readonly token: string) {} }
```

导入规则：

```ts
import { definePlugin, seg, z } from '@asabot/core'      // 插件唯一入口
import type { Context } from '@asabot/core'              // 类型必须 import type
import { helper } from './helper.ts'                     // 相对导入带 .ts
import type { Config } from '../config/schema.ts'
```

- 不写无扩展名的相对导入，不写 `.js` 指向 `.ts`。
- 框架包名是 `@asabot/core`，通过包自引用解析。插件一律用包名导入框架，不要用相对路径引用框架的内部模块。
- zod 只从 `@asabot/core` 导入，保证单实例。
- 平台专属能力从子路径导入：`@asabot/core/onebot11`、`/feishu`、`/wecom`、`/weixin-clawbot`，并用类型守卫判断。

## 分层与依赖方向

```mermaid
flowchart BT
  core[src/core]
  adapters[src/adapters/*]
  plugins[src/plugins/* 内置插件]
  server[src/server]
  web[web/ 控制台]
  userPlugins[插件]
  adapters --> core
  plugins --> core
  server --> core
  web -. HTTP .-> server
  userPlugins -->|@asabot/core| core
```

- `src/core/**` 不得导入 `src/adapters/**`、`src/plugins/**`、`src/server/**`。
- 核心层不出现任何平台专属字段、action 名、CQ 码或「ID 是纯数字」的假设。
- 协议转换、平台 API 封装留在适配器目录。
- 内置插件使用公共 API，不要把业务逻辑塞回 core。
- 新增依赖前先找现有实现：`src/core/utils/`、内置插件的服务（`http`、`history`、`long-message`）、`@asabot/panel-ui` 的组件。

## 类型与状态

- 只在系统边界做校验：配置加载、HTTP 请求、适配器输入、外部 API 和模型输出、文件读写。
- 内部模块完全信任类型和调用方前置条件。不写多余的判空、防御性拷贝或掩盖错误的默认值。
- 状态用判别联合或明确的状态字段表达，不要用多个互相牵制的布尔值：

```ts
type PluginState = 'loading' | 'active' | 'failed' | 'disabled'
```

- 平台 ID 在 core 层一律是 `string`；数字与字符串的转换只由适配器负责。
- 不为简单值过度设计包装类型。需要表达「缺失」时优先用 `undefined`，不要发明哨兵值。

## 错误处理与日志

- 不吞异常。能恢复的地方记录日志并降级；不能恢复就向上抛，让调用方处理。
- 边界处把外部错误转换成框架错误：`DeliveryError`、`ApiTimeoutError`、`ConfigError`、`PluginConfigError` 等。
- 插件和处理函数的异常由框架记录插件名和事件上下文；插件内部的异步任务要自己 catch，并用 `ctx.logger` 补上下文：

```ts
try {
  await syncRemote(signal)
} catch (error) {
  ctx.logger.error({ err: error, channel: channelId }, '同步失败')
  throw error
}
```

- 日志字段用 `{ err: error }`，不要只拼字符串。
- 不打印 token、密码、私钥或带 `access_token` 的 URL。配置和错误信息同样遵守。
- 面向用户的错误文案说明原因和下一步，不暴露堆栈或内部路径。

## 测试

只写高价值测试，不为每次改动自动补测试。值得测的：

- 协议边界：CQ 码、消息段转换、事件映射。
- 状态转换：插件生命周期、连接状态、任务状态、投递结果。
- 错误与取消：超时、abort、重试、部分送达。
- 资源回收：卸载后监听器、定时器、路由失效。
- 解析器、权限、容易复发的缺陷。

不值得测：平凡的 getter/setter、内部调用顺序、样式类名、普通展示文案、语言自带的保证。

插件行为测试用 `createTestApp`：

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

- OneBot 协议层用 `MockOneBot`（`@asabot/core/onebot11/testing`）。
- 热重载的集成测试必须在子进程里跑 `node`，vitest 的模块运行器不经过 Node loader 钩子。
- 测试只断言稳定的业务结果和外部契约。界面测试优先用基于语义选择器的端到端流程，不测组件内部结构。

## 提交与工作区

- 一个独立闭环的功能切片完成后提交一次，提交前工作区里不混入无关改动。
- 只 `git add` 本切片实际修改的文件，不执行 `git add -A`。
- 提交信息沿用 CONTRIBUTING 的格式：`type(scope): description`，例如 `feat(plugin): add cooldown scope`。
- 不推送、不部署，除非用户明确要求。
- 未经许可不贮藏、重置或覆盖用户自己的改动。

## 文档同步

- 行为或设计变化同步 `docs/DESIGN.md`；已知限制写进「已知限制」。
- 面向使用者的 API、配置、命令变化同步 `README.md`。
- 插件 API、面板 UI、动效约定变化同步 `docs/guide/` 对应文件。
- 文档里的代码示例要与可运行代码一致；README 的示例由 `test/readme-examples.test.ts` 验证。
- 不建进度文档。未完成项用 `TODO:` / `FIXME:` 标注在代码现场。
