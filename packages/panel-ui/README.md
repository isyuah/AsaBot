# @asabot/panel-ui

AsaBot 控制台与插件页面共用的 React 19 组件。组件按传入的数据和回调工作，插件通过 `ctx.panel.route` 和面板 SDK 读写自己的数据。

```tsx
import { Button, Card, PanelUIProvider, PluginPageLayout } from '@asabot/panel-ui'
import '@asabot/panel-ui/styles.css'

export function App() {
  return (
    <PanelUIProvider>
      <PluginPageLayout toolbar={<Button>刷新</Button>}>
        <Card>插件内容</Card>
      </PluginPageLayout>
    </PanelUIProvider>
  )
}
```

`styles.css` 已经编译，插件不需要配置 Tailwind。需要与控制台相同的 Geist 和 Noto Sans SC 字体时，再导入 `@asabot/panel-ui/fonts.css`；该入口会增加约 4.5 MB 的字体资产，面板 ZIP 上传的上限为 2 MB。

- `PanelUIProvider` 提供 Tooltip 上下文，并遵循用户的减少动效偏好。
- `PluginPageLayout` 适合放在 iframe 内容的最外层。`toolbar` 固定在顶部，正文超出时在内部滚动。简单 HTML 插件也可以直接使用 iframe 内的文档滚动。
- `@asabot/panel-ui` 提供按钮、表单、卡片、弹窗、侧滑面板、Tab、头像、消息片段、趋势图、处理轨迹等组件。`Markdown` 从 `@asabot/panel-ui/markdown` 导入，也可单独懒加载。
- `Select` 可通过 `id` 关联 `Field` 的 `htmlFor`。`undefined` 显示占位文本，`''` 可以作为真实选项，例如「全部」或「不设默认」。
- `DatePicker` 同样可关联 `Field`，`value`、`min` 和 `max` 使用 `YYYY-MM-DD`，清空时回传 `undefined`。默认按本地日期显示「今天」，UTC 筛选可使用 `timeZone="UTC"`。
- 在插件的 `index.html` 中用 `<script src="/plugin-pages/_sdk.js"></script>` 加载面板 SDK，接收主题更新、调用插件接口和显示面板通知。在插件内按 `Ctrl/⌘ + K` 也可以打开控制台命令面板。插件自己的弹窗和菜单在 iframe 内显示。
- 前端构建产物使用相对路径（Vite 设置 `base: './'`），再用 `ctx.panel.page({ title, root })` 将入口目录指向构建产物。

## 运行示例插件

从 AsaBot 仓库根目录构建并打包共享组件，把示例目录复制到 `plugins/panel-ui-demo`：

```powershell
pnpm --filter @asabot/panel-ui build
Copy-Item -Recurse packages/panel-ui/example plugins/panel-ui-demo
pnpm --dir packages/panel-ui pack --out ../../plugins/panel-ui-demo/panel-ui.tgz
pnpm --dir plugins/panel-ui-demo --ignore-workspace install --lockfile=false
pnpm --dir plugins/panel-ui-demo --ignore-workspace build
```

启动或刷新控制台后，在「插件页面」打开「消息统计示例」。可以切换短列表与长列表、筛选消息和打开详情弹窗。部署示例插件时只需要它的 `index.ts` 和 `dist/`，浏览器依赖已包含在 `dist/` 里。
