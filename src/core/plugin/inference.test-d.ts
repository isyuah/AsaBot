import { expectTypeOf } from 'vitest'
import { z } from 'zod'
import { definePlugin } from './definition.ts'

definePlugin({
  name: 'typed',
  config: z.object({ amount: z.string().transform(Number) }),
  setup(ctx) {
    expectTypeOf(ctx.config.amount).toEqualTypeOf<number>()
  },
})

definePlugin({
  name: 'no-config',
  setup(ctx) {
    expectTypeOf(ctx.config).toEqualTypeOf<undefined>()
  },
})
