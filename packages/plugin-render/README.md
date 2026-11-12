# @asabot/plugin-render

AsaBot 官方出图插件：使用 satori 和 resvg 将文本、Markdown 与 HTML 转为 PNG，可选用本机或远程 Chrome 截图。

## 安装与配置

在面板的插件市场安装 `@asabot/plugin-render`，或由超管发送 `/plugin install @asabot/plugin-render`。插件名为 `render`，可在 `asabot.config.yaml` 中配置：

```yaml
plugins:
  render:
    enabled: true
    config:
      # 默认使用包内 fonts/ 中的 Noto Sans SC；也可以指定其他子集目录
      # fontDir: /path/to/fonts
      fonts: [] # 附加的 ttf、otf、woff 字体文件，优先于内置字体
      emoji: twemoji # 或 none
      emojiBaseUrl: https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg
      browser:
        concurrency: 2
        # executablePath: /path/to/chrome
        # wsEndpoint: ws://127.0.0.1:9222/devtools/browser/...
```

emoji 下载使用可选的 `http` 服务，未提供时使用全局 `fetch`；结果缓存在插件数据目录和内存中。浏览器按需启动，空闲 5 分钟后关闭；使用 `page()` 前须配置 `executablePath` 或 `wsEndpoint`。

## 服务 API

`RenderService` 提供以下方法，均返回 PNG `Buffer`：

- `element(node, options?)`：渲染 satori `{ type, props }` 节点。
- `html(html, options?)`：使用 satori-html 解析 HTML，支持 satori 的 flex 布局和 CSS 子集。
- `markdown(markdown, options?)`：渲染 Markdown，支持 `theme: 'light' | 'dark'`。
- `text(text, options?)`：保留换行渲染纯文本，支持 `theme`。
- `page({ html } | { url }, options?)`：使用浏览器截图；URL 须为 HTTP 或 HTTPS。

前四个方法支持 `width`、`height`、`scale`；`page` 支持 `width`、`selector`、`timeout`（毫秒或时长字符串）。

```ts
import { definePlugin, seg } from '@asabot/core'
import type { RenderService } from '@asabot/plugin-render'

export default definePlugin({
  name: 'report',
  inject: ['render'],
  setup(ctx) {
    const render: RenderService = ctx.inject('render')
    ctx.command('report').action(async () => {
      const png = await render.markdown('# 今日报告\n\n- 中文和 English\n- 成功', { width: 640 })
      return seg.image(png)
    })
  },
})
```
