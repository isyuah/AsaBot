import { expectTypeOf } from 'vitest'
import { dispatchFixture } from '../../testing/dispatch-fixture.ts'
import type { Message, Segment } from '../message/index.ts'

const { app } = dispatchFixture()
app.dispatcher
  .command({ owner: 'typecheck' }, 'echo [n:integer=1] [extra] <text:rest>')
  .option('times', '-n, --times <n:integer>', { default: 1 })
  .option('silent', '-s, --silent')
  .option('image', '-i, --image <image:image>')
  .action(({ args, options, signal }) => {
    expectTypeOf(args.text).toEqualTypeOf<Message>()
    expectTypeOf(args.n).toEqualTypeOf<number>()
    expectTypeOf(args.extra).toEqualTypeOf<string | undefined>()
    expectTypeOf(options.times).toEqualTypeOf<number>()
    expectTypeOf(options.silent).toEqualTypeOf<boolean>()
    expectTypeOf(options.image).toEqualTypeOf<Extract<Segment, { type: 'image' }> | undefined>()
    expectTypeOf(signal).toEqualTypeOf<AbortSignal>()
  })
