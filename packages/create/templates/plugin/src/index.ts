import { definePlugin } from '@asabot/core'

export default definePlugin({
  name: '{{name}}',
  setup(ctx) {
    ctx
      .command('{{name}}')
      .description('示例命令')
      .action(() => '你好，AsaBot！')
  },
})
