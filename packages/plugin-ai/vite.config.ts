import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  root: fileURLToPath(new URL('./panel/', import.meta.url)),
  plugins: [
    react(),
    {
      name: 'ai-panel-licenses',
      generateBundle() {
        for (const family of ['geist', 'geist-mono', 'noto-sans-sc']) {
          const fileName = `licenses/${family}.txt`
          this.emitFile({
            type: 'asset',
            fileName,
            source: readFileSync(new URL(`../panel-ui/dist/${fileName}`, import.meta.url)),
          })
        }
        const chartPackage = new URL(import.meta.resolve('echarts/package.json'))
        const chartDependencies = createRequire(chartPackage)
        for (const [name, source] of [
          ['echarts', new URL('LICENSE', chartPackage)],
          ['echarts-notice', new URL('NOTICE', chartPackage)],
          ['echarts-d3', new URL('licenses/LICENSE-d3', chartPackage)],
          ['zrender', chartDependencies.resolve('zrender/LICENSE')],
        ] as const) {
          this.emitFile({ type: 'asset', fileName: `licenses/${name}.txt`, source: readFileSync(source) })
        }
      },
    },
  ],
  build: {
    outDir: fileURLToPath(new URL('./dist/panel/', import.meta.url)),
    emptyOutDir: true,
  },
})
