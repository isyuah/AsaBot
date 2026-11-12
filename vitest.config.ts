import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'packages/plugin-render/src/**/*.test.ts'],
    pool: 'threads',
  },
})
