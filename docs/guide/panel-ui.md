# 插件面板页与 UI 规范

本篇讲插件作者能控制的那部分界面：插件自己的面板页。控制台本身的页面不在这里；插件页使用 `@asabot/panel-ui`，组件和配色会自动与控制台一致。

## 先注册页面

```ts
ctx.panel.page({ title: '统计', icon: 'bar-chart', root: new URL('./page/', import.meta.url) })
ctx.panel.route((app) => app.get('/stats', (c) => c.json({ total: 42 })))
ctx.panel.push('updated', { total: 42 })
```

- 每个插件最多一个面板页，`root` 是静态文件目录，`entry` 默认 `index.html`。
- 页面标题显示在 iframe 上方，由 `title` 决定。
- `icon` 取值：`app-window`、`bar-chart`、`calendar`、`coins`、`gamepad`、`gift`、`image`、`list-checks`、`music`、`sparkles`、`star`、`trophy`、`users`、`wrench`。其他值回退为 `app-window`。
- 静态文件通过 `/plugin-pages/<name>/` 公开访问，**不要放敏感数据**。
- 数据接口挂在 `/api/panel/ext/<name>/`，需要面板登录，写请求遵循面板的 CSRF 规则。
- 页面、路由和推送入口随插件卸载失效。

## 页面是沙箱 iframe

- iframe 没有 `allow-same-origin`，页面读不到面板的 cookie 和 DOM；访问存储会受到沙箱限制。
- 弹窗、菜单、Tooltip 都留在 iframe 内；不要尝试操作父窗口。
- 数据只通过 SDK 的 `asabot.fetch` / `asabot.json` 请求本插件的认证接口。
- 实时消息用 `asabot.on(topic, handler)`，对应 `ctx.panel.push(topic, data)`。
- `asabot.toast(text, level)` 在面板中显示提示，`level` 为 `info`、`success` 或 `error`。
- 页面内按 `Ctrl/⌘ + K` 由 SDK 打开控制台命令面板，不要自己实现。

### SDK 的返回行为

```ts
const response = await asabot.fetch('/stats')
// response: { status: number; data: unknown }；网络失败时 status 为 0
if (response.status === 0) throw new Error('面板连接中断')

const stats = await asabot.json('/stats')
// 2xx 时直接返回解析后的 body；非 2xx 抛出带 status 和 data 的错误
```

`asabot.fetch` 不会因为 HTTP 错误状态自动抛错，需要自己检查 `status`。

## 安装与入口

React 插件安装组件包和 React 19（放进 `dependencies`，它们会打包进 iframe 产物）：

```json
{
  "dependencies": {
    "@asabot/panel-ui": "^0.1.0",
    "react": "^19.3.1",
    "react-dom": "^19.3.1"
  }
}
```

页面必须加载面板 SDK，React 页面也不例外：

```html
<script vite-ignore src="/plugin-pages/_sdk.js"></script>
```

`vite-ignore` 阻止 Vite 尝试打包这个运行时路径。没有 SDK 就没有主题同步、认证请求和面板提示。

入口：

```tsx
import { PanelUIProvider, PluginPageLayout } from '@asabot/panel-ui'
import '@asabot/panel-ui/styles.css'

export function App() {
  return (
    <PanelUIProvider>
      <PluginPageLayout toolbar={<Toolbar />}>
        <Content />
      </PluginPageLayout>
    </PanelUIProvider>
  )
}
```

- `styles.css` 已编译，插件不需要配置 Tailwind。
- 发布版 `@asabot/panel-ui` 不导出 `theme.css`，不要照抄控制台内部的 `@import '@asabot/panel-ui/theme.css'`。
- 插件页自定义样式用普通 CSS 加 token，例如 `background: var(--surface)`、`border: 1px solid var(--border)`；不要假设任意 Tailwind 工具类可用，除非插件自己配置了 Tailwind 并扫描自己的源码。
- 需要与控制台相同的字体时再导入 `@asabot/panel-ui/fonts.css`，它会增加约 4.5 MB 资产，而面板 ZIP 上传上限是 2 MB。通过面板上传的插件不要导入。
- Vite 构建设置 `base: './'`，产物用相对路径。

不用 React 也可以：用普通 HTML 引入 `/plugin-pages/_sdk.js`，自己写 DOM 和样式。简单页面直接用 iframe 内文档滚动即可。

## 页面骨架

`PluginPageLayout` 放在 iframe 内容最外层。`toolbar` 固定在顶部，正文在内部滚动：

```tsx
<PluginPageLayout
  toolbar={
    <div className="toolbar">
      <Field label="筛选" htmlFor="filter">
        <Input id="filter" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </Field>
      <Button variant="secondary" onClick={() => void refetch()}>
        刷新
      </Button>
    </div>
  }
>
  <div className="content">
    <Card>
      <CardHeader title="消息统计" />
      <MessageChart points={points} range="1h" />
    </Card>
  </div>
</PluginPageLayout>
```

配套的简单 CSS：

```css
.toolbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.content {
  display: grid;
  gap: 12px;
  padding: 12px;
}
```

页面标题已经由宿主显示，页面内不要再放 `PageHeader` 或重复的大标题。不要自己再包一层 `h-dvh` 滚动容器，否则会出现双滚动条。

## 组件选择

| 场景 | 用 | 不要 |
| --- | --- | --- |
| 内容分组 | `Card` + `CardHeader` | 裸 `div` 加边框 |
| 主/次操作 | `Button` 的 `primary` / `secondary` / `ghost` / `soft` / `danger` / `danger-ghost` | 自绘按钮 |
| 状态标签 | `Badge tone` + `dot` / `pulse`，或 `StatusDot` | 彩色圆点加文字自绘 |
| 指标数字 | `NumberTicker` | 需要滚动效果时的纯文本数字 |
| 表单 | `Field` + `Input` / `Textarea` / `Select` / `DatePicker` / `Switch` | 裸 `input` |
| 小确认或短表单 | `Dialog` | `window.confirm` |
| 详情查看 | `Sheet`（右侧抽屉） | 新页面或全屏弹窗 |
| 页面内多视图 | `PageTabs` 或 `Segmented` | 一组散装按钮 |
| 带面板的 tab | `Tabs` + `TabPanel` | 手写 tab 状态 |
| 行内操作菜单 | `Menu` + `MenuItem` / `MenuSeparator` | 常驻一排小按钮 |
| 提示 | `Tooltip` | 只用 `title` 属性 |
| 快捷键提示 | `Kbd` | 纯文本 |
| 空/错/加载 | `EmptyState` / `ErrorState` / `Skeleton` | 空白页或永久转圈 |
| 头像 | `Avatar` | 直接放 `<img>` |
| 消息内容 | `Segments` | 自己拼消息段 |
| 趋势图 | `MessageChart` | 另引图表库（除非有明确需求） |
| 分发轨迹 | `TraceView` | 自绘时间线 |
| 配置表单 | `SchemaForm` / `ListControl` | 手写 JSON Schema 解析 |
| 类名合并 | `cn` | 字符串拼接 |

动效规则见 [motion.md](motion.md)；`motion` 和 `lucide-react` 已经是 `@asabot/panel-ui` 的依赖，但插件直接 import 时应在自己的 `package.json` 里声明。

## 颜色与主题

只使用语义 token。它们由 SDK 写入插件页的 `--asabot-*` 变量，并映射到面板的配色：

| Token | 用途 |
| --- | --- |
| `bg` / `bg-glow` | 页面背景与顶部光晕 |
| `surface` / `surface-2` / `surface-3` | 卡片、次级背景、控件底色 |
| `overlay` | 弹窗遮罩 |
| `border` / `border-strong` | 分隔线、悬停边框 |
| `fg` / `fg-2` / `fg-3` | 主文字、正文、辅助文字 |
| `accent` / `accent-hover` / `accent-fg` / `accent-soft` / `accent-soft-fg` | 主操作、选中态、焦点 |
| `success` / `warning` / `danger` / `info` 及各自的 `-soft` | 语义状态 |
| `series-in` / `series-out` | 图表系列色 |
| `ring` | 焦点环 |
| `shadow-card` / `shadow-pop` | 卡片阴影、浮层阴影 |

规则：

- 不写 `#hex`、`rgb()`、`white`、`black`；用 `var(--token)` 或组件。
- `accent` 只用于主操作、选中、链接和焦点环，不要拿来做大面积装饰。
- 语义色只表达语义：`danger` 用于破坏性操作和错误，不用于普通强调。
- 主题由 SDK 同步，页面直接消费变量；不要自己判断深浅色或读 localStorage。
- 新增颜色先加 token 再引用，不在页面里就地定义。

## 三态

每个依赖异步数据的区域按「错误 → 无数据 → 有数据」渲染。下面的 `query` 以 TanStack Query 的字段名为例，换成你使用的数据层即可：

```tsx
{query.error ? (
  <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
) : query.data === undefined ? (
  <div className="skeleton-stack">
    <Skeleton className="skeleton-row" />
    <Skeleton className="skeleton-row" />
  </div>
) : query.data.length === 0 ? (
  <EmptyState
    icon={<Inbox className="size-5" />}
    title="还没有消息"
    description="机器人收到消息后会显示在这里。"
  />
) : (
  <List data={query.data} />
)}
```

```css
.skeleton-stack {
  display: grid;
  gap: 6px;
  padding: 6px;
}

.skeleton-row {
  height: 48px;
}
```

- 加载用 `Skeleton`，形状贴近最终内容；按钮内的加载用 `Button loading`。
- 已有数据、后台刷新时不要退回骨架屏，用透明度或局部状态表达刷新中。
- 空状态说明「为什么空」和「下一步能做什么」，动作按钮可选。
- 错误状态必须给重试入口，不能只显示一行红字或永远转圈。

## 表单与可访问性

- 配置 schema 的字符串字段可以用 `x-asabot-options: { source: 'plugins', consumes?: string }` 让面板渲染插件选择框；写法见 [plugin.md](plugin.md#配置)，插件端不用自己写选择组件。
- 用 `Field` 包标签、提示和错误，`htmlFor` 关联控件 `id`。
- `Select` 的 `undefined` 显示占位文本，`''` 是真实选项（例如「全部」）。
- `DatePicker` 用 `YYYY-MM-DD`，清空时回传 `undefined`；按 UTC 筛选时传 `timeZone="UTC"`。
- 只有图标、没有可见标签的按钮（`Switch`、图标按钮）必须给 `aria-label`。
- 装饰性图标加 `aria-hidden`；交互图标不要。
- 不覆盖全局 `:focus-visible` 焦点环；不要为了美观移除 `outline`。
- 破坏性操作使用 `danger`，并在 `Dialog` 内二次确认，说明影响范围。

## 图标

- 使用 `lucide-react`。
- 尺寸：按钮内 `size-3.5`，输入框 `size-4`，空状态 `size-5`。
- 同一行图标保持同一尺寸和线宽（默认 2，强调可用 2.5）。
- 不用 emoji 代替图标。

## 文案

以下为建议，按实际场景取舍：

- 简体中文，动词开头，具体说明对象。例如「导出这个会话」，不写「提交」。
- 空状态和错误给下一步；错误文案不暴露堆栈、内部路径或英文异常名。
- 不写开发提示、占位英文、TODO；示例数据要标注为示例。
- 数量使用 `tabular` 或 `NumberTicker`，避免跳动。
- 按钮文案尽量短，同一区域的主次操作控制在两个以内。

## 构建与体积

- 图标按需导入，不要整包引入。
- 依赖优先复用 `@asabot/panel-ui` 已有的（Radix、motion、lucide），避免重复打包。
- 通过面板上传的插件 ZIP 不超过 2 MB，解压后不超过 5 MB。
- 用 `dist/` 部署时浏览器依赖应已包含在产物里，运行时不依赖 `node_modules`。

## 验收清单

- [ ] 页面通过 `ctx.panel.page` 注册，标题只在宿主显示
- [ ] `index.html` 加载了 `/plugin-pages/_sdk.js`
- [ ] 浅色和深色都检查过，没有写死颜色
- [ ] 加载、空、错误三态齐全，错误可重试
- [ ] 主操作只有一种强调色，语义色没有混用
- [ ] 键盘可以到达所有操作，图标按钮有 `aria-label`
- [ ] 窄屏下没有横向溢出，工具栏和正文各自正确滚动
- [ ] 弹窗、菜单、Tooltip 没有跑出 iframe
- [ ] 静态文件里没有敏感数据
- [ ] 上传场景的 ZIP 小于 2 MB，没有导入 `fonts.css`
