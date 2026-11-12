import { definePlugin } from 'asabot'
import { answer } from '#shared'
import { suffix } from './relative.js'

export default definePlugin({
  name: 'm8-npm',
  setup(ctx) {
    ctx.command('package-answer').action(() => answer + suffix)
  },
})
