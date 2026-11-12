import { definePlugin, plainText, seg, z } from 'asabot'

export default definePlugin({
  name: 'echo',
  description: '复读消息并可选欢迎新成员',
  config: z.object({
    maxLen: z.number().int().positive().default(200),
    welcome: z.boolean().default(false),
  }),
  setup(ctx) {
    ctx
      .command('echo <text:rest>')
      .alias('复读')
      .description('复读消息')
      .option('times', '-n, --times <n:integer>', { default: 1, description: '重复次数，最多 5 次' })
      .cooldown('2s', { scope: 'user' })
      .example('/echo -n 2 你好')
      .action(({ args, options }) => {
        if (options.times < 1 || options.times > 5) return '重复次数必须在 1 到 5 之间'
        if (plainText(args.text).length > ctx.config.maxLen) return `文本不能超过 ${ctx.config.maxLen} 字`
        // rest 保留消息段，图片、@ 等内容也可以原样复读。
        return Array.from({ length: options.times }, () => args.text).flat()
      })

    ctx.on('notice.member.join', async (event) => {
      if (ctx.config.welcome)
        await event.bot.sendGroup(event.groupId, [seg.text('欢迎 '), seg.at(event.userId)])
    })
  },
})
