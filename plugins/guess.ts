import { definePlugin } from '@asabot/core'

// 每个用户的最好成绩，同时记下显示名，排行榜就不用展示内部 ID。
interface Best {
  score: number
  name: string
}

export default definePlugin({
  name: 'guess',
  description: '猜数游戏',
  setup(ctx) {
    ctx
      .command('猜数')
      .description('开始一局猜数')
      .action(async ({ session }) => {
        const answer = Math.floor(Math.random() * 100) + 1
        const key = `best:${session.platform}:${session.userId}`
        let count = 0
        let tip = '猜一个 1 到 100 的整数，输入“退出”结束。'
        while (true) {
          // 默认超时来自 dispatch.promptTimeout；同一用户的回复会被 prompt 消费。
          const reply = await session.prompt(tip)
          if (!reply) return '猜数超时，游戏结束'
          const text = reply.text.trim()
          if (text === '退出' || text.toLowerCase() === 'quit') return '已退出猜数游戏'
          if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 100) {
            tip = '请输入 1 到 100 的整数，或输入“退出”。'
            continue
          }
          const guess = Number(text)
          count += 1
          if (guess === answer) {
            const previous = ctx.store.get<Best>(key)
            const best = Math.min(previous?.score ?? count, count)
            const name = session.sender.card || session.sender.nickname || session.userId
            ctx.store.set(key, { score: best, name } satisfies Best)
            return `猜对了！共猜 ${count} 次，最佳成绩 ${best} 次。`
          }
          tip = `${guess < answer ? '太小了' : '太大了'}，继续猜，或输入“退出”。`
        }
      })

    ctx
      .command('猜数 清除')
      .description('清除自己的猜数最佳成绩')
      .action(async ({ session }) => {
        const confirmed = await session.confirm('确定清除你的猜数最佳成绩吗？')
        if (confirmed === null) return
        if (!confirmed) return '已保留猜数成绩'
        ctx.store.delete(`best:${session.platform}:${session.userId}`)
        return '已清除猜数成绩'
      })

    ctx
      .command('猜数 排行')
      .description('查看猜数最佳成绩排行')
      .action(() => {
        // keys() 与 get() 之间记录可能恰好过期或被删除，跳过即可。
        const scores = ctx.store
          .keys('best:')
          .map((key) => ctx.store.get<Best>(key))
          .filter((entry): entry is Best => entry !== undefined)
        scores.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
        if (scores.length === 0) return '还没有猜数成绩'
        return [
          '猜数排行：',
          ...scores.slice(0, 10).map((entry, index) => `${index + 1}. ${entry.name}：${entry.score} 次`),
        ].join('\n')
      })
  },
})
