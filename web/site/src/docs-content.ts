import configuration from '../../../asabot.config.example.yaml?raw'
import deploymentSource from '../../../docs/DEPLOY.md?raw'
import readmeSource from '../../../README.md?raw'

const nl = '\n'
const readme = readmeSource.replaceAll('\r\n', nl)
const deployment = deploymentSource.replaceAll('\r\n', nl)

function section(source: string, heading: string, next?: string) {
  const start = source.indexOf(heading + nl)
  const end = next ? source.indexOf(nl + next + nl, start + heading.length) : source.length
  if (start === -1 || end === -1) throw new Error(`Missing documentation section: ${heading}`)
  return source
    .slice(start + heading.length, end)
    .trim()
    .replaceAll(`${nl}### `, `${nl}## `)
}
function fromReadme(heading: string, next: string) {
  return section(readme, heading, next)
}
function md(...parts: string[]) {
  return parts.join(nl + nl)
}

export interface DocPage {
  slug: string
  title: string
  description: string
  group: '开始使用' | '开发插件' | '使用与部署'
  content: string
  appendix?: string
}

export const docPages: DocPage[] = [
  {
    slug: 'introduction',
    title: '认识 AsaBot',
    group: '开始使用',
    description: '从一个轻巧的核心开始，构建自己的聊天机器人。',
    content: md(
      '## 为聊天而写，为插件而生',
      fromReadme('# AsaBot', '## 特性'),
      '用适配器连接聊天平台，用插件扩展机器人的行为。命令、事件、会话与存储有统一的接口，日常管理则交给内置 Web 面板。',
      '## 框架提供什么',
      fromReadme('## 特性', '## 快速开始'),
      '## 选择你的起点',
      '- **第一次使用**：跟随[快速开始](/docs/quickstart)，创建项目并完成初始化。' +
        nl +
        '- **准备编写插件**：从[第一个插件](/docs/first-plugin)开始，再查阅 [Context API](/docs/context)。' +
        nl +
        '- **准备日常使用**：了解[插件管理](/docs/plugin-management)与[部署和备份](/docs/deployment)。',
      '## 几个基本概念',
      '| 概念 | 负责什么 |' +
        nl +
        '| --- | --- |' +
        nl +
        '| Adapter | 连接平台，将平台事件转换为框架事件。 |' +
        nl +
        '| Bot | 一个平台账号，提供发送消息与平台能力。 |' +
        nl +
        '| Plugin | 独立的功能模块，通过 setup 注册行为。 |' +
        nl +
        '| Context | 插件使用命令、事件、配置、存储和服务的入口。 |' +
        nl +
        '| Session | 当前消息的会话信息，以及回复和多轮对话方法。 |',
    ),
  },
  {
    slug: 'quickstart',
    title: '快速开始',
    group: '开始使用',
    description: '创建项目，启动机器人，再写下第一条命令。',
    content: md(
      '## 创建项目',
      '准备 Node.js **24 或更高版本**和 npm，然后在终端运行：',
      ['```sh', 'npm create @asabot@latest', 'cd asabot-bot', 'npm install', 'npm run dev', '```'].join(nl),
      '按提示选择 **bot** 模板和项目目录。默认目录为 `asabot-bot`；如果选择了其他目录，将 `cd` 后的路径替换为你的目录。',
      '## 完成第一次设置',
      '1. 打开终端输出的面板地址，默认是 `http://127.0.0.1:5140`。' +
        nl +
        '2. 输入当前进程的一次性设置码，设置面板密码和超管。' +
        nl +
        '3. 按向导配置聊天平台连接。OneBot 11 的两种接入方式见[连接聊天平台](/docs/connections)。' +
        nl +
        '4. 在机器人的群聊或私聊中发送 `/help` 或 `/ping`，查看回复。',
      '设置码仅在当前进程中有效。向导将配置保存到 `asabot.config.yaml`；之后可以将面板密码改成[环境变量引用](/docs/configuration#环境变量)。',
      '## 项目里有什么',
      '```text' +
        nl +
        'asabot-bot/' +
        nl +
        '  plugins/hello.ts       # 示例插件' +
        nl +
        '  package.json' +
        nl +
        '  tsconfig.json' +
        nl +
        '  asabot.config.yaml     # 首次启动时生成' +
        nl +
        '  data/                  # 默认数据目录' +
        nl +
        '```',
      '## 开发与正式运行',
      '`npm run dev` 开启插件热重载。修改 `plugins/` 下的插件后可以直接试用，不必反复重启。正式运行使用：',
      `\`\`\`sh${nl}npm start${nl}\`\`\``,
      '接下来，试着[编写第一个插件](/docs/first-plugin)，或者先了解[配置文件](/docs/configuration)。',
    ),
  },
  {
    slug: 'configuration',
    title: '配置文件',
    group: '开始使用',
    description: '配置加载、环境变量，以及常用配置项的完整参考。',
    content: md(
      '## 配置加载与常用选项',
      fromReadme('## 配置参考', '## 内置插件'),
      '## 环境变量',
      '启动时会从当前工作目录加载 `.env`。将敏感值写入环境变量，在 YAML 中引用变量名：',
      '```yaml' +
        nl +
        'server:' +
        nl +
        `  panelPassword: \${ASABOT_PANEL_PASSWORD}` +
        nl +
        `  apiToken: \${ASABOT_API_TOKEN:-}` +
        nl +
        '```',
      `\`\${VAR}\` 要求变量存在；\`\${VAR:-默认值}\` 为未设置的变量提供默认值。不要将实际密钥提交到版本库。`,
      '## 完整配置示例',
      '下方示例直接来自项目的配置参考文件，可展开查看每个配置项的说明。',
    ),
    appendix: configuration,
  },
  {
    slug: 'connections',
    title: '连接聊天平台',
    group: '开始使用',
    description: '通过 OneBot 11 接入平台，选择正向或反向 WebSocket。',
    content: md(
      '## 接入方式',
      section(deployment, '# 部署 AsaBot', '## 直接用 Node.js 运行'),
      '连接配置写在 `asabot.config.yaml` 的 `adapters.onebot11` 下。正向连接由 AsaBot 连接平台，反向连接由平台连接 AsaBot；部署在容器中时，还需要留意宿主机和容器的网络地址。',
      section(deployment, '## 连接 OneBot 11 服务', '## HTTPS 反向代理'),
      '## 排查连接问题',
      '- **连接被拒绝**：检查对端服务地址、端口和监听接口；容器中的 `127.0.0.1` 指向容器自身。' +
        nl +
        '- **认证失败**：核对两端的 token 是否一致，使用环境变量传入。' +
        nl +
        '- **连接正常但没有回复**：检查命令前缀、插件状态、群开关和访问控制，再用 `/help` 确认可用命令。',
    ),
  },
  {
    slug: 'first-plugin',
    title: '第一个插件',
    group: '开发插件',
    description: '认识插件定义、文件组织和开发时的热重载。',
    content: md(
      '## 创建插件文件',
      fromReadme('### 最小插件', '### Context 一览'),
      '## 插件的生命周期',
      '`setup(ctx)` 在插件启用时执行。通过 Context 注册的命令、监听器、中间件和定时任务随插件卸载自动回收。自定义资源使用 `ctx.onDispose(fn)` 清理，耗时操作使用 `ctx.signal` 响应取消。',
      '## 范围、群配置与热重载',
      fromReadme('### 按群开关与热重载', '### 测试插件'),
      '## 下一步',
      '- 通过[命令与参数](/docs/commands)增加选项和输入约束。' +
        nl +
        '- 通过[会话与多轮对话](/docs/conversations)继续一次交互。' +
        nl +
        '- 使用[测试与发布](/docs/testing)验证并打包你的插件。',
    ),
  },
  {
    slug: 'commands',
    title: '命令与参数',
    group: '开发插件',
    description: '参数声明、选项、别名、输入校验与返回值。',
    content: md(
      '## 声明一条命令',
      fromReadme('### 命令、参数与选项', '### Session、多轮对话、权限与冷却'),
      '## 权限与冷却',
      '用 `.permission()` 限制角色，`.scope()` 限制群聊或私聊，`.cooldown()` 限制调用频率。具体角色和 Session 用法见[会话与多轮对话](/docs/conversations)。',
    ),
  },
  {
    slug: 'conversations',
    title: '会话与多轮对话',
    group: '开发插件',
    description: '回复消息、等待输入，以及会话权限和调用冷却。',
    content: md('## 使用 Session', fromReadme('### Session、多轮对话、权限与冷却', '### 能力与消息段')),
  },
  {
    slug: 'events',
    title: '事件与通知',
    group: '开发插件',
    description: '订阅分层事件，处理入群、撤回以及好友和群请求。',
    content: md('## 事件订阅', fromReadme('### 通知与请求事件', '### 命令、参数与选项')),
  },
  {
    slug: 'messages',
    title: '消息与主动发送',
    group: '开发插件',
    description: '统一消息段、平台能力降级、目标与批量发送。',
    content: md(
      '## 消息段与平台能力',
      fromReadme('### 能力与消息段', '### 主动发送'),
      '## 向目标主动发送',
      fromReadme('### 主动发送', '### 可选服务'),
      '## 拦截 Bot API',
      fromReadme('### API 拦截', '### 存储与定时任务'),
    ),
  },
  {
    slug: 'context',
    title: 'Context API',
    group: '开发插件',
    description: '插件上下文的常用接口，以及资源和生命周期管理。',
    content: md(
      '## 接口速查',
      fromReadme('### Context 一览', '### 插件面板页面'),
      '## 按任务查找',
      '- 保存状态、执行 SQL 和定时任务：[存储与调度](/docs/storage)。' +
        nl +
        '- 使用框架服务与其他插件的能力：[服务与依赖](/docs/services)。' +
        nl +
        '- 向管理面板添加自己的页面：[扩展管理面板](/docs/panel)。' +
        nl +
        '- 控制插件生效的群和平台：[第一个插件](/docs/first-plugin#范围-群配置与热重载)。',
    ),
  },
  {
    slug: 'storage',
    title: '存储与调度',
    group: '开发插件',
    description: '插件独立 KV、SQLite 迁移、cron 和周期任务。',
    content: md(
      '## 保存状态与安排任务',
      fromReadme('### 存储与定时任务', '### 按群开关与热重载'),
      '## 数据与资源的归属',
      'KV 按插件隔离；迁移记录也按插件管理。使用 `ctx.migrate` 创建带 `p_插件名_` 前缀的表，可以让框架在清除插件数据时正确处理表的归属。文件数据使用 `ctx.dataDir`，不要将插件数据写入程序源码目录。',
    ),
  },
  {
    slug: 'services',
    title: '服务与依赖',
    group: '开发插件',
    description: '使用内置服务，并声明插件之间的必需和可选依赖。',
    content: md(
      '## 内置服务',
      fromReadme('## 内置插件', '## 官方插件'),
      '## 官方渲染插件',
      fromReadme('## 官方插件', '## 管理面板与对外 API'),
      '## 可选服务与重载',
      fromReadme('### 可选服务', '### API 拦截'),
    ),
  },
  {
    slug: 'panel',
    title: '扩展管理面板',
    group: '开发插件',
    description: '为插件添加页面、认证接口和页面 SDK 交互。',
    content: md('## 页面与认证接口', fromReadme('### 插件面板页面', '### 通知与请求事件')),
  },
  {
    slug: 'testing',
    title: '测试与发布',
    group: '开发插件',
    description: '使用虚拟适配器测试插件，再将它发布为 npm 包。',
    content: md(
      '## 在本地测试插件',
      fromReadme('### 测试插件', '## 部署').replace(
        '下面的测试对应上面的 `plugins/hello.ts`',
        '下面的测试对应[第一个插件](/docs/first-plugin)中的 `plugins/hello.ts`',
      ),
      '## 创建和发布插件包',
      fromReadme('### 开发并发布插件包', '## 开发插件'),
    ),
  },
  {
    slug: 'plugin-management',
    title: '插件与权限管理',
    group: '使用与部署',
    description: '安装与升级插件、管理群开关，以及常用管理命令。',
    content: md(
      '## 安装与管理插件',
      fromReadme('## 安装与管理插件', '### 开发并发布插件包'),
      '## 管理命令与访问控制',
      fromReadme('## 内置命令', '## 安装与管理插件'),
    ),
  },
  {
    slug: 'http-api',
    title: '面板与 HTTP API',
    group: '使用与部署',
    description: '面板认证、对外 API 和插件自定义 HTTP 路由。',
    content: md(
      '## 启用面板与 API',
      fromReadme('## 管理面板与对外 API', '## 内置命令'),
      '## 插件面板的数据接口',
      '面向已登录面板用户的接口，请使用 `ctx.panel.route`；它与公开的 `ctx.route` 有不同的认证边界。完整示例见[扩展管理面板](/docs/panel)。',
    ),
  },
  {
    slug: 'deployment',
    title: '部署与备份',
    group: '使用与部署',
    description: 'Node.js、Docker、HTTPS 反向代理，以及数据备份和升级。',
    content: md(
      '## 从源码运行',
      section(deployment, '## 直接用 Node.js 运行', '## Docker 和 Compose'),
      '## Docker 与 Compose',
      section(deployment, '## Docker 和 Compose', '## 连接 OneBot 11 服务'),
      '## HTTPS 反向代理',
      section(deployment, '## HTTPS 反向代理', '## 数据、备份和升级'),
      '## 数据、备份与升级',
      section(deployment, '## 数据、备份和升级'),
    ),
  },
]

export const docGroups = ['开始使用', '开发插件', '使用与部署'] as const
export function docHref(page: DocPage) {
  return `/docs/${page.slug}`
}
export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
}
export function tableOfContents(content: string) {
  return Array.from(content.matchAll(/^## (.+)$/gm), (match) => {
    const title = match[0].slice(3)
    return { title, id: slugify(title) }
  })
}
