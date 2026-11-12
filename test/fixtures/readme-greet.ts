import { definePlugin } from '@asabot/core'

export default definePlugin({
  name: 'greet',
  setup(ctx) {
    ctx.command('greet').action(async ({ session }) => {
      const reply = await session.prompt('你叫什么名字？', { timeout: '30s' })
      if (!reply) return '等待超时'
      ctx.store.set(`name:${session.platform}:${session.userId}`, reply.text)
      return `你好，${reply.text}！`
    })
  },
})
