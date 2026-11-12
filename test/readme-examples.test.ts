import { createTestApp } from '@asabot/core/testing'
import { expect, it } from 'vitest'
import greet from './fixtures/readme-greet.ts'
import hello from './fixtures/readme-hello.ts'

it('runs the README hello example', async () => {
  const t = await createTestApp({ plugins: [hello] })
  try {
    expect(await t.say('/hello 小明')).toEqual(['你好，小明！'])
    expect(await t.say('/hello')).toEqual(['你好，朋友！'])
  } finally {
    await t.dispose()
  }
})

it('runs the README prompt and storage example', async () => {
  const t = await createTestApp({ plugins: [greet] })
  try {
    expect(await t.say('/greet')).toEqual(['你叫什么名字？'])
    expect(await t.say('小明')).toEqual(['你好，小明！'])
    expect(t.app.storage.store('greet').get('name:virtual:20')).toBe('小明')
  } finally {
    await t.dispose()
  }
})
