import { definePlugin } from '@asabot/core'

export default definePlugin({
  name: 'panel-ui-demo',
  description: '演示共享控件、图表和插件页布局',
  setup(ctx) {
    ctx.panel.page({ title: '消息统计示例', icon: 'bar-chart', root: new URL('./dist/', import.meta.url) })
  },
})
