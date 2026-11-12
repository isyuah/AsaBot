import { describe, expect, it } from 'vitest'
import { createTestApp } from '../src/testing/index.ts'

describe('command pipeline', () => {
  it('executes commands and a prompt, delivering unknown commands to matchers', async () => {
    const t = await createTestApp()
    try {
      t.app.dispatcher.command({ owner: 'echo' }, 'echo <text:rest>').action(({ args }) => args.text)
      t.app.dispatcher.command({ owner: 'ask' }, 'ask').action(async ({ session }) => {
        const answer = await session.prompt('你的名字？')
        return answer === null ? undefined : `你好，${answer.text}`
      })
      let matched = false
      t.app.dispatcher.match({ owner: 'test' }, '/nope', () => {
        matched = true
      })
      expect(await t.say('/echo hi', { group: 'room-a', user: 'user-a' })).toEqual(['hi'])
      expect(await t.say('/ask', { group: 'room-a', user: 'user-a' })).toEqual(['你的名字？'])
      expect(await t.say('Alice', { group: 'room-a', user: 'user-a' })).toEqual(['你好，Alice'])
      await t.say('/nope', { group: 'room-a', user: 'user-a' })
      expect(matched).toBe(true)
    } finally {
      await t.dispose()
    }
  })
})
