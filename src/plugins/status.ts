import type { App } from '../core/app.ts'
import { definePlugin } from '../core/plugin/definition.ts'

function uptime(seconds: number): string {
  const value = Math.floor(seconds)
  const days = Math.floor(value / 86_400)
  const hours = Math.floor((value % 86_400) / 3_600)
  const minutes = Math.floor((value % 3_600) / 60)
  return `${days}天 ${hours}小时 ${minutes}分 ${value % 60}秒`
}

export function createStatusPlugin(app: App) {
  return definePlugin({
    name: 'status',
    description: '查看运行状态',
    setup(ctx) {
      ctx
        .command('ping')
        .description('检查机器人是否响应')
        .action(() => 'pong')
      ctx
        .command('status')
        .description('查看运行状态')
        .action(() => {
          const plugins = app.plugins.list()
          const failed = plugins.filter((plugin) => plugin.state === 'failed')
          const bots = ctx.bots.map((bot) => `${bot.platform}:${bot.selfId} ${bot.status}`)
          return [
            `运行时长：${uptime(process.uptime())}`,
            `Node：${process.version} | RSS：${(process.memoryUsage.rss() / 1024 / 1024).toFixed(1)} MiB`,
            `Bot：${bots.length ? bots.join('、') : '暂无'}`,
            `插件：active ${plugins.filter((plugin) => plugin.state === 'active').length} / failed ${failed.length} / disabled ${plugins.filter((plugin) => plugin.state === 'disabled').length}`,
            ...(failed.length ? [`失败：${failed.map((plugin) => plugin.name).join('、')}`] : []),
          ].join('\n')
        })
    },
  })
}
