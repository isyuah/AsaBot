# 面板 UI 规范

适用于 `web/` 控制台和插件面板页。目标是让所有页面看起来属于同一个系统，而不是各写各的。组件 API 以 `packages/panel-ui/src/index.ts` 和源码为准；动效另见 [motion.md](motion.md)。

## 原则

1. 能用 `@asabot/panel-ui` 的组件，就不要自己写按钮、输入框、弹窗和卡片。
2. 颜色、圆角、阴影只用语义 token，不写死色值。
3. 每个数据区域都要有加载、空、错误三种状态。
4. 浅色和深色都要实际看一遍；只验收一种视为未完成。
5. 文案面向使用者，写「发生了什么、能做什么」，不写开发提示。

## 技术栈与入口

控制台：React 19 + Tailwind CSS v4 + Radix 原语 + motion + TanStack Query + lucide 图标。`web/src/styles.css` 引入 Tailwind 和 `@asabot/panel-ui/theme.css`，所以控制台里可以直接用 `bg-surface`、`text-fg-2` 这类语义类。

插件页：组件来自 `@asabot/panel-ui`，样式导入编译好的 CSS：

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
- 发布版 `@asabot/panel-ui` 不导出 `theme.css`，不要照抄控制台的 `@import '@asabot/panel-ui/theme.css'`。
- 插件页自定义样式用普通 CSS 加 token，例如 `background: var(--surface)`、`border: 1px solid var(--border)`；不要假设任意 Tailwind 工具类可用。
- 需要与控制台相同的字体时再导入 `@asabot/panel-ui/fonts.css`，它会增加约 4.5 MB 资产，而面板 ZIP 上传上限是 2 MB。通过面板上传的插件不要导入。

## 页面骨架

### 控制台页面

主壳已经提供最大宽度、水平内边距和页面切换动画（`web/src/components/layout/shell.tsx`）：

- 容器：`max-w-[1180px]`，`px-5 lg:px-10`，`py-7 lg:py-9`。
- 页面根节点不要再包一层 padding 或进场动画。

```tsx
export function ExamplePage() {
  return (
    <>
      <PageHeader
        title="消息记录"
        description="history 插件记录的收发消息"
        actions={<Button variant="secondary">导出</Button>}
      />
      <div className="grid gap-3 lg:grid-cols-[300px_1fr]">
        <Card>…</Card>
        <Card>…</Card>
      </div>
    </>
  )
}
```

### 插件页面

`PluginPageLayout` 放在 iframe 内容最外层。`toolbar` 固定在顶部，正文在内部滚动：

```tsx
<PluginPageLayout toolbar={<div className="toolbar">…</div>}>
  <div className="content">…</div>
</PluginPageLayout>
```

示例插件的刻度：工具栏 `padding: 10px 14px`，底部 1px 边框；正文 `display: grid; gap: 12px; padding: 12px`。不要自己再包一层 `h-dvh` 滚动容器，否则会出现双滚动条。

## 布局刻度

| 项 | 约定 |
| --- | --- |
| 控制台页面宽度 | `max-w-[1180px]`，由主壳提供 |
| 页面内边距 | `px-5 lg:px-10`，`py-7 lg:py-9`，由主壳提供 |
| 卡片间距 | `gap-3`（12px）；大区块之间 `space-y-6` |
| 卡片内边距 | 默认由卡片内容控制；头部用 `CardHeader`（`px-5 pt-4 pb-3`），整卡表单可用 `p-5 sm:p-6` |
| 插件页正文 | `grid gap-3 p-3` |
| 页面标题 | 22px / semibold / `tracking-[-0.025em]`（`PageHeader` 内置） |
| 卡片标题 | 13.5px / semibold（`CardHeader` 内置） |
| 正文 | 13–13.5px；辅助文字 12–12.5px，用 `text-fg-3` |
| 圆角 | 卡片 14px；输入框和按钮 10px；小按钮 8px；弹窗和抽屉 18px；Badge 6px |
| 图标 | 按钮内 14px（`size-3.5`）；输入框 16px（`size-4`）；空状态 20px（`size-5`） |

数值本身不是目的；优先直接使用组件，只有自定义布局时才参照这张表。

## 组件选择

| 场景 | 用 | 不要 |
| --- | --- | --- |
| 页面标题与说明 | `PageHeader` | 自己写 `h1` |
| 内容分组 | `Card` + `CardHeader` | 裸 `div` 加边框 |
| 主/次操作 | `Button` 的 `primary` / `secondary` / `ghost` / `soft` / `danger` / `danger-ghost` | 自绘按钮 |
| 状态标签 | `Badge tone` + `dot` / `pulse`，或 `StatusDot` | 彩色圆点加文字自绘 |
| 指标数字 | `NumberTicker` | 纯文本数字（需要滚动效果时） |
| 表单 | `Field` + `Input` / `Textarea` / `Select` / `DatePicker` / `Switch` | 裸 `input` |
| 小确认或短表单 | `Dialog` | `window.confirm` |
| 详情查看 | `Sheet`（右侧抽屉） | 新页面或全屏弹窗 |
| 页面级视图切换 | `PageTabs` | 自定义 tab |
| 同区块视图切换 | `Segmented` | 一组散装按钮 |
| 带面板的 tab | `Tabs` + `TabPanel` | 手写 tab 状态 |
| 行内操作菜单 | `Menu` + `MenuItem` / `MenuSeparator` | 常驻一排小按钮 |
| 提示 | `Tooltip` | `title` 属性作为唯一说明 |
| 快捷键提示 | `Kbd` | 纯文本 |
| 空/错/加载 | `EmptyState` / `ErrorState` / `Skeleton` | 空白页或永久转圈 |
| 头像 | `Avatar` | 直接放 `<img>` |
| 消息内容 | `Segments` | 自己拼消息段 |
| 趋势图 | `MessageChart` | 另引图表库（除非有明确需求） |
| 分发轨迹 | `TraceView` | 自绘时间线 |
| 配置表单 | `SchemaForm` / `ListControl` | 手写 JSON Schema 解析 |
| 类名合并 | `cn` | 字符串拼接 |

## 颜色与主题

只使用语义 token（`packages/panel-ui/src/theme.css`）：

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

- 不写 `#hex`、`rgb()`、`bg-white`、`text-black`；用 `bg-surface`、`text-fg-3`、`border-border` 或 `var(--token)`。
- `accent` 只用于主操作、选中、链接和焦点环，不要拿来做大面积装饰。
- 语义色只表达语义：`danger` 用于破坏性操作和错误，不用于普通强调。
- 深色模式由 `.dark` / `[data-theme='dark']` 切换；插件页由 SDK 写入 `--asabot-*` 变量，不要自己判断主题或读 localStorage。
- 新增颜色先加 token，再在组件里引用，不在页面里就地定义。

## 三态

每个依赖异步数据的区域按「错误 → 无数据 → 有数据」渲染：

```tsx
{query.error ? (
  <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
) : query.data === undefined ? (
  <div className="space-y-1.5 p-1.5">
    <Skeleton className="h-12" />
    <Skeleton className="h-12" />
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

- 加载用 `Skeleton`，形状贴近最终内容；按钮内的加载用 `Button loading`。
- 已有数据、后台刷新时不要退回骨架屏；用 `isPlaceholderData` / `dimmed` 表达刷新中。
- 空状态说明「为什么空」和「下一步能做什么」，动作按钮可选。
- 错误状态必须给重试入口，不能只显示一行红字或永远转圈。

## 表单与可访问性

- 用 `Field` 包标签、提示和错误，`htmlFor` 关联控件 `id`。
- `Select` 的 `undefined` 显示占位文本，`''` 是真实选项（例如「全部」）。
- `DatePicker` 用 `YYYY-MM-DD`，清空时回传 `undefined`；按 UTC 筛选时传 `timeZone="UTC"`。
- 只有图标、没有可见标签的按钮（`Switch`、图标按钮）必须给 `aria-label`。
- 装饰性图标加 `aria-hidden`；交互图标不要。
- 不覆盖全局 `:focus-visible` 焦点环；不要为了美观移除 `outline`。
- 破坏性操作使用 `danger`，并在 `Dialog` 内二次确认，说明影响范围。

## 文案

- 简体中文，动词开头，具体说明对象。例如「导出这个会话」，不写「提交」。
- 空状态和错误给下一步；错误文案不暴露堆栈、内部路径或英文异常名。
- 不写开发提示、占位英文、TODO、示例数据说明；示例数据要标注为示例。
- 数字和单位之间保持可读间距；数量使用 `tabular` 或 `NumberTicker`，避免跳动。
- 按钮文案尽量短，同一区域的主次操作不要超过两个。

## 插件页 iframe 与数据

- 插件页是沙箱 iframe，没有 same-origin：读不到面板 cookie、DOM 和 localStorage。
- 静态文件通过 `/plugin-pages/<name>/` 公开访问，不要放敏感数据或密钥。
- 数据只通过 SDK 请求认证接口：

```ts
const stats = await asabot.json('/stats')
asabot.on('updated', (data) => render(data))
asabot.toast('已保存', 'success')
```

- 弹窗、菜单、Tooltip 都留在 iframe 内；不要尝试操作父窗口。
- `Ctrl/⌘ + K` 由 SDK 转发给面板，不要自己实现全局命令面板。
- 页面标题由 `ctx.panel.page({ title })` 决定，显示在 iframe 上方；页面内不要再重复一个大标题。

## 构建与体积

- Vite 构建设置 `base: './'`，产物用相对路径。
- 图标从 `lucide-react` 按需导入，不要整包引入。
- 依赖优先复用 `@asabot/panel-ui` 已有的（Radix、motion、lucide），避免重复打包。
- 通过面板上传的插件 ZIP 不超过 2 MB，解压后不超过 5 MB。
- 用 `dist/` 部署时浏览器依赖应已包含在产物里，运行时不依赖 `node_modules`。

## 验收清单

- [ ] 浅色和深色都检查过，没有写死颜色
- [ ] 加载、空、错误三态齐全，错误可重试
- [ ] 主操作只有一种强调色，语义色没有混用
- [ ] 键盘可以到达所有操作，图标按钮有 `aria-label`
- [ ] 窄屏下没有横向溢出，列表和工具栏可滚动
- [ ] 插件页工具栏固定、正文单层滚动，弹窗没有跑出 iframe
- [ ] 文案没有开发提示、占位英文和示例数据说明
- [ ] 上传场景的 ZIP 小于 2 MB，没有导入 `fonts.css`
