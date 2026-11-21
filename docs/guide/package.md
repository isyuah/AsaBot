# 插件工程、测试与发布

本篇讲把插件做成可维护、可分发的包：目录结构、TypeScript 构建、依赖、测试和发布。插件功能本身见 [plugin.md](plugin.md)。需要 Node.js 24 或更高版本。

## 文件插件与 npm 包的区别

| | 文件插件 | npm 包 |
| --- | --- | --- |
| 加载方式 | 宿主直接 `import` `.ts` / `.js` 文件 | 加载编译后的 JS |
| 语法限制 | TypeScript 必须使用 Node 类型剥离支持的语法 | 不受限制，但建议与框架保持一致 |
| 构建 | 不需要 | 发布前编译 JS 和 `.d.ts` |
| 测试 | 直接 import `.ts` | 直接 import `.ts`，构建另跑 |

文件插件由宿主直接运行源码，因此禁止 `enum`、`namespace`、构造函数参数属性和 `import = require`；相对导入必须带 `.ts` 后缀，纯类型导入用 `import type`。

npm 包虽然编译后运行，官方脚手架仍开启 `erasableSyntaxOnly`，让源码能被 vitest 直接加载。没有特殊理由就沿用这个配置。

## 用脚手架起步

```sh
npm create @asabot@latest -- --template plugin
```

按提示输入名称。生成的包名是 `asabot-plugin-<名称>`，默认名称是 `example`，插件命令也是这个名称。

生成的模板包含：

```
asabot-plugin-example/
  package.json
  tsconfig.json          # 开发和测试用，noEmit
  tsconfig.build.json    # 发布构建，输出 dist
  src/index.ts
  src/index.test.ts
  README.md
```

## package.json

模板的 `package.json`（脚手架会把 `{{coreVersion}}` 换成当前版本）：

```json
{
  "name": "asabot-plugin-example",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["asabot-plugin"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "prepublishOnly": "npm run build"
  },
  "peerDependencies": {
    "@asabot/core": "^0.2.0"
  },
  "devDependencies": {
    "@asabot/core": "^0.2.0",
    "typescript": "^7.0.2",
    "vitest": "^5.1.0"
  }
}
```

要点：

- `"type": "module"`，插件包是 ESM。
- `exports` 同时给出 `types` 和 `default`，缺少类型会让使用方没有提示。
- `peerDependencies` 声明 `@asabot/core`，不要把它打进产物；`devDependencies` 里再放一份用于本地类型和测试，两处版本保持一致。
- `files` 只发布 `dist`，不要把源码、测试和临时文件发出去。
- 需要 `@asabot/panel-ui` 时放进 `dependencies`；React 和 React DOM 也放进 `dependencies`，它们会打包进 iframe 产物。
- 直接使用 `motion` 或 `lucide-react` 时，在插件自己的依赖里声明，不要依赖提升。

## TypeScript 配置

模板的 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

`tsconfig.build.json` 继承它并打开输出：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "rewriteRelativeImportExtensions": true
  },
  "exclude": ["src/**/*.test.ts"]
}
```

`rewriteRelativeImportExtensions` 会把源码里的 `./helper.ts` 改写成 `./helper.js`，所以测试和构建可以共用同一套 `.ts` 导入。

## 错误与日志

先分清谁来处理异常：

- `ctx.cron`、`ctx.interval`、`ctx.timeout` 的异常由框架捕获并记录，不需要插件自己 catch，但捕获后不会重试。
- `ctx.task` 的异常会写入执行历史，并按任务配置重试。处理器应该让异常抛出，不要吞掉。
- 命令和事件处理器里抛出的异常由框架记录插件名和事件。
- 自己管理的异步流程（例如没经过框架的队列、第三方回调）要自己 catch：

```ts
try {
  await syncRemote(signal)
} catch (error) {
  ctx.logger.error({ err: error, channel: channelId }, '同步失败')
  throw error
}
```

日志和错误信息的要求：

- 日志字段用 `{ err: error }`，不要只拼字符串。
- 不打印 token、密码、私钥或带 `access_token` 的 URL。
- 面向用户的错误说明原因和下一步，不暴露堆栈或内部路径。

## 测试

用 vitest 加虚拟适配器，不连接网络：

```ts
import { createTestApp } from '@asabot/core/testing'
import { expect, it } from 'vitest'
import plugin from './index.ts'

it('回复示例命令', async () => {
  const t = await createTestApp({ plugins: [plugin] })
  try {
    expect(await t.say('/hello')).toEqual(['你好，AsaBot！'])
  } finally {
    await t.dispose()
  }
})
```

上面的 `/hello` 对应命令名为 `hello` 的插件。脚手架生成的命令名是创建时输入的名称（默认 `example`），照抄时把它换成实际命令。

`say` 默认模拟群 `10`、用户 `20`，可传 `{ group, user, role, superuser }`，`{ group: null }` 模拟私聊。`createTestApp` 也可以传 `pluginDirs` 和 `config` 覆盖。

值得测的：

- 命令输出、参数校验、权限和冷却。
- 事件的副作用和过滤条件。
- 存储读写、TTL、迁移。
- 卸载后资源是否回收、定时任务是否停止。
- 容易复发的缺陷。

不需要测的：内部调用顺序、私有函数、组件类名、普通展示文案。面板页用浏览器实际打开检查，不为布局写单元测试。

需要 OneBot 协议细节时用 `MockOneBot`：

```ts
import { MockOneBot } from '@asabot/core/onebot11/testing'
```

## 发布

1. 确认包名可用。包名和插件 `name` 可以不同：安装、更新使用 npm 包名，卸载和聊天命令使用插件的 `name`。
2. 更新版本号并运行 `npm test`、`npm run build`。
3. 需要图标时在 `keywords` 里加一条：

```json
{
  "keywords": ["asabot-plugin", "asabot-icon:https://assets.example.com/my-plugin.svg"]
}
```

图标必须是可公开访问的 HTTPS 图片；没有声明或加载失败时面板显示默认图标。

4. `npm publish`。`prepublishOnly` 会自动构建。
5. 在干净的 AsaBot 环境里用面板或 `/plugin install <包名>` 安装，确认加载状态为 `active`，命令和面板页都能用。

## 兼容与升级

- `peerDependencies` 的范围决定插件能安装到哪些框架版本；升级框架大版本时同步检查。
- 依赖其他插件用 `depends`；使用服务用 `inject.required` / `inject.optional`。
- 声明平台能力需求用 `capabilities`，它用于面板提示，不阻止启用。
- 配置 schema 新增字段要带默认值；删除或重命名字段时保留可选旧字段或给出兼容处理，避免旧配置校验失败。配置本身没有迁移机制，真正的数据迁移走 `ctx.migrate`。
- 插件状态 `failed` 时先看面板里的错误和日志；常见原因是命令冲突、配置校验失败和缺失的依赖服务。
