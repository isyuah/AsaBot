import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'test/**/*.test.ts',
      'packages/plugin-ai/src/**/*.test.ts',
      'packages/plugin-render/src/**/*.test.ts',
      'packages/create/test/**/*.test.js',
    ],
    pool: 'threads',
  },
})
