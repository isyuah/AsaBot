import { definePlugin } from 'asabot'

export default definePlugin({
  name: 'hello',
  setup(ctx) {
    ctx
      .command('hello [name=朋友]')
      .description('打个招呼')
      .action(({ args }) => `你好，${args.name}！`)
  },
})
