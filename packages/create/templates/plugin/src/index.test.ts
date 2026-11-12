import { createTestApp } from '@asabot/core/testing'
import { expect, it } from 'vitest'
import plugin from './index.ts'

it('回复示例命令', async () => {
  const t = await createTestApp({ plugins: [plugin] })
  try {
    expect(await t.say('/{{name}}')).toEqual(['你好，AsaBot！'])
  } finally {
    await t.dispose()
  }
})
