# AsaBot 开发规则

AsaBot 是协议无关的 TypeScript 聊天机器人框架。核心层（`src/core`）不识别任何具体平台；OneBot 11、飞书、企业微信和微信 ClawBot 通过 `src/adapters` 接入。仓库是 pnpm workspace：根包是 `@asabot/core`，`web/` 是控制台，`packages/` 下有 `create`、`panel-ui`、`plugin-ai` 和 `plugin-render`。

## 开始前

- 先看 `git status` 和当前分支。工作区里有别人未提交的改动时，不要覆盖、reset 或 stash。
- 按任务选择文档：
  - 写插件、插件面板页、测试和发布：`docs/guide/README.md`。
  - 改框架、适配器、控制台、数据结构：`docs/DESIGN.md` 对应章节。
  - 用户 API、配置和命令：`README.md`。
  - PR、标签和发版：`CONTRIBUTING.md`。
- `docs/DESIGN.md` 的第 21–24 节以及文末的追加章节（飞书适配器、机器人作用域与插件配置、独立连接与适配器注册）会覆盖前面章节。
- 先按主题搜索，确认后面有没有修订，再动手；不要照抄早期章节里的旧包名、旧配置或旧测试路径（例如 `asabot`、`src/testing/` 里的 MockOneBot、`adapters` 配置分组）。
- 源码和测试是签名与运行时行为的事实来源。文档里的旧包名、旧路径属于事实性过期，直接修正；设计和实现冲突时，在交付说明里写清楚，不要静默按其中一边实现。

## 仓库地图

| 目录 | 职责 |
| --- | --- |
| `src/core/` | App、分发、命令、权限、插件、存储、配置、调度 |
| `src/adapters/` | 平台适配器；协议转换、平台 API 和平台类型只留在这里 |
| `src/plugins/` | 内置插件，随框架静态注册 |
| `src/server/` | HTTP、面板、对外 API、反向 WS |
| `web/` | React 19 控制台，Vite + Tailwind CSS 4 |
| `packages/create/` | `npm create @asabot` 脚手架 |
| `packages/panel-ui/` | 控制台和插件页共用的组件与主题 |
| `packages/plugin-ai/` | 可选 AI 插件 |
| `packages/plugin-render/` | 可选渲染插件 |
| `plugins/` | 本地文件插件目录，开发时热重载 |
| `test/` | 跨模块集成测试 |

依赖方向：

- `src/core/**` 不得导入 `src/adapters/**`、`src/plugins/**`、`src/server/**`。
- 平台专属的字段、action、CQ 码和“ID 是纯数字”的假设只能出现在对应适配器；core、server、内置插件和 web 不出现这类内容。
- core 层所有平台 ID 都是 `string`，数字与字符串转换由适配器负责。
- 内置插件使用 `src/core` 的内部模块；外部插件包只从 `@asabot/core` 导入框架和 zod，不要引用 `src/` 内部路径。
- 新依赖先找现有实现：`src/core/utils/`、内置插件提供的服务、`@asabot/panel-ui` 的组件。

## 代码约束

- Node ≥ 24，仓库内直接运行 `.ts`。只用可擦除语法：禁止 `enum`、`namespace`、构造函数参数属性和 `import = require`。
- 相对导入带 `.ts` 后缀；纯类型导入用 `import type`。
- 依赖用 `pnpm add` 管理，不手写版本号，不手改 `pnpm-lock.yaml`。
- TypeScript 开启了 `strict` 和 `noUncheckedIndexedAccess`。不要用 `as any`、`@ts-ignore` 或空 catch 掩盖类型和数据流问题，修到根上。
- 只在系统边界做校验：配置加载、HTTP 请求、适配器输入、外部 API、文件读写。内部模块信任类型和调用方前置条件，不堆防御性判空。
- 不静默吞掉意外错误。能恢复就记录日志并降级；不能恢复就向上抛。
- 取消和超时是分发契约的一部分，按现有分发器的取消/超时逻辑处理，不要把它们记成错误。
- 插件和处理函数的异常要带插件名和事件上下文。日志字段用 `{ err: error }`，不要只拼字符串。
- 日志和错误信息里不出现 token、密码、私钥或带 `access_token` 的 URL。
- 行尾统一 LF；格式交给 Biome：`pnpm lint` 检查，`pnpm lint:fix` 写入，不要手工大范围重排。

## 验证

| 改动 | 跑什么 |
| --- | --- |
| 任意 | `pnpm typecheck`、`pnpm lint` |
| core、协议转换、状态流转、存储、插件生命周期 | `pnpm test`；可先跑相关文件，如 `pnpm test test/onebot.integration.test.ts` |
| `web/` 控制台 | `pnpm --filter web build`（含 `tsc --noEmit`） |
| `packages/panel-ui` | `pnpm --filter @asabot/panel-ui build` |
| `packages/plugin-ai` | 先 `pnpm --filter @asabot/panel-ui build`，再 `pnpm --filter @asabot/plugin-ai typecheck` 和 `pnpm --filter @asabot/plugin-ai build` |
| `packages/plugin-render` | `pnpm --filter @asabot/plugin-render build` |
| 发布前 | `pnpm build` |

- 根 `pnpm typecheck` 只覆盖 `src/`、`plugins/`、`test/` 和 `packages/plugin-render/src/`；`web`、`panel-ui`、`plugin-ai` 要单独跑上面的命令。
- `pnpm build` 构建 panel-ui、web 和框架 `dist`，不构建 `plugin-ai`。
- CI 的 Verify 跑 `lint`、`typecheck`、`plugin-ai typecheck`、`test`、`build`、`plugin-ai build`。本地按改动范围跑，不要只依赖 CI。
- 改控制台或插件页要实际打开页面检查浅色和深色；只过类型检查不算完成。
- 需要后端时用 `pnpm dev --config <临时配置>` 启动，不要用仓库根目录的 `asabot.config.yaml` 连接真实平台；前端用 `pnpm --filter web dev`。
- 测试只覆盖稳定契约：协议边界、状态转换、错误与取消、资源回收、解析器、权限和容易复发的缺陷。不要因为改了代码就顺手补测试，不测内部调用顺序、私有函数和普通展示文案。
- 行为级测试用 `@asabot/core/testing` 的 `createTestApp`；它使用虚拟适配器和临时数据库，不连网络。OneBot 协议测试用 `@asabot/core/onebot11/testing` 的 `MockOneBot`。

## 数据与运行安全

- `data/` 存放 SQLite、WAL、插件数据和 AI 凭据；不要删除、清空、覆盖或提交。需要重置时先备份并确认目标。
- `asabot.config.yaml` 和 `.env*` 是本地配置，可能包含密钥。不要把内容贴到日志、回复或提交里；需要看结构时用 `asabot.config.example.yaml`。
- `pnpm dev`、`pnpm start` 会加载配置、连接真实平台并写入 `data/`。不要为了“看看效果”直接启动；UI 预览用临时配置，行为验证用 `createTestApp`。
- npm 插件与框架同进程运行，拥有完整权限；只安装可信来源的包。

## 分支、提交与 GitHub

- 开始改动前确认分支。不要在 `main` 上直接提交；从最新 `main` 切描述性分支，例如 `fix/panel-cache`、`docs/agent-rules`。
- 一个独立闭环的功能切片提交一次。只暂存本切片实际修改的文件，不用 `git add -A`。
- 提交信息用 `type(scope): description`，例如 `fix(panel): show installed plugin READMEs`；PR 标题沿用同一格式。
- 未经明确授权不 `git push`、不创建或修改 PR、不打 tag、不发版、不部署。
- 禁止 force push `main`，禁止直接 push `main`，禁止改写已发布的 tag。
- 仓库目前只有 `origin`。如果以后配置 `upstream`，只从上游 fetch 或 rebase，不向 `upstream` push。
- 需要开 PR 时，正文写清变更和验证方式；等 CI 的 Verify 通过，按 Squash merge 合并。PR 模板和发版流程见 `CONTRIBUTING.md`。
- 交付说明写清楚：改了哪些文件、实际跑了哪些命令、有没有设计偏差或已知限制。UI 改动说明检查过的页面和主题。

## 文档同步

- 行为或设计变化同步 `docs/DESIGN.md`；已知限制写进「已知限制」。
- 面向使用者的 API、配置、命令变化同步 `README.md`。
- 插件、面板页、动效约定变化同步 `docs/guide/` 对应文件。
- README 里的代码示例由 `test/readme-examples.test.ts` 验证；改示例后跑这个测试。
- 不创建 `STATUS.md`、`DEVLOG.md` 之类的进度文档。未完成项用 `TODO:` / `FIXME:` 标在代码现场。

## 插件与界面

- 写插件前读 `docs/guide/README.md`，按阅读路线进入 `plugin.md`、`package.md`、`panel-ui.md`、`motion.md`。
- 外部插件的入口默认导出 `definePlugin(...)`，`@asabot/core` 放 `peerDependencies`，不要打进产物。
- 控制台和插件页优先用 `@asabot/panel-ui` 的组件和语义 token，不写 `#hex`、`rgb()` 或 `white`/`black`。
- 图标用 `lucide-react`，不要用 emoji 或字符代替图标。
- 每个异步数据区域都要有加载、空、错误三种状态；错误状态给重试入口。浅色和深色都要实际检查。
- 动效复用 `packages/panel-ui/src/motion.ts` 的预设，不自造 spring 参数或 cubic-bezier；尊重 `prefers-reduced-motion`。
- 插件页是沙箱 iframe，读不到面板 cookie 和 DOM；数据只走需要登录的 `ctx.panel.route`，静态文件公开，不要放敏感数据。
