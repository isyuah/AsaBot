import { definePlugin, seg, z } from '@asabot/core'

export default definePlugin({
  name: 'hello',
  defaultOnNewBots: true,
  config: z.object({ greeting: z.string().default('你好') }),
  setup(ctx) {
    ctx
      .command('hello [name=朋友]')
      .description('打个招呼')
      .action(({ args, session }) => {
        return seg.text(`${ctx.configFor(session).greeting}，${args.name}！`)
      })
  },
})
