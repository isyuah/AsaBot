import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin } from '../src/index.ts'
import { createTestApp, type TestApp } from '../src/testing/index.ts'

let app: TestApp | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
})

describe('dialogue helpers', () => {
  it('validates replies, retries, exhausts retries, and preserves plain prompt cancellation', async () => {
    app = await createTestApp({
      plugins: [
        definePlugin({
          name: 'dialogue',
          setup(ctx) {
            ctx.command('validated').action(async ({ session }) => {
              const reply = await session.prompt('输入数字', {
                retries: 1,
                validate: (answer) => /^\d+$/.test(answer.text) || '请输入数字',
              })
              return reply?.text ?? '结束'
            })
            ctx.command('plain').action(async ({ session }) => (await session.prompt('输入'))?.text)
          },
        }),
      ],
    })
    expect(await app.say('/validated')).toEqual(['输入数字'])
    expect(await app.say('bad')).toEqual(['请输入数字'])
    expect(await app.say('42')).toEqual(['42'])
    expect(await app.say('/validated')).toEqual(['输入数字'])
    expect(await app.say('bad')).toEqual(['请输入数字'])
    expect(await app.say('still bad')).toEqual(['结束'])
    expect(await app.say('/validated')).toEqual(['输入数字'])
    expect(await app.say('  取消  ')).toEqual(['结束'])
    expect(await app.say('/plain')).toEqual(['输入'])
    expect(await app.say('取消')).toEqual(['取消'])
  })

  it('confirms and chooses by number or label, with invalid replies and cancellation', async () => {
    app = await createTestApp({
      plugins: [
        definePlugin({
          name: 'choices',
          setup(ctx) {
            ctx.command('confirm').action(async ({ session }) => String(await session.confirm('确定？')))
            ctx.command('choose').action(async ({ session }) =>
              String(
                await session.choose('选择', [
                  { label: '苹果', value: 10 },
                  { label: '梨', value: 20 },
                ]),
              ),
            )
          },
        }),
      ],
    })
    expect(await app.say('/confirm')).toEqual(['确定？'])
    expect(await app.say('也许')).toEqual(['请回复“是”或“否”'])
    expect(await app.say(' YES ')).toEqual(['true'])
    expect(await app.say('/confirm')).toEqual(['确定？'])
    expect(await app.say('否')).toEqual(['false'])
    expect(await app.say('/confirm')).toEqual(['确定？'])
    expect(await app.say('取消')).toEqual(['null'])
    expect(await app.say('/choose')).toEqual(['选择\n1. 苹果\n2. 梨'])
    expect(await app.say('x')).toEqual(['请回复 1-2 的编号'])
    expect(await app.say('2')).toEqual(['20'])
    expect(await app.say('/choose')).toEqual(['选择\n1. 苹果\n2. 梨'])
    expect(await app.say('苹果')).toEqual(['10'])
    expect(await app.say('/choose')).toEqual(['选择\n1. 苹果\n2. 梨'])
    expect(await app.say('cancel')).toEqual(['null'])
  })
})
