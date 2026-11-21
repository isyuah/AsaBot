import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  root: fileURLToPath(new URL('./panel/', import.meta.url)),
  plugins: [
    react(),
    {
      name: 'ai-panel-font-licenses',
      generateBundle() {
        for (const family of ['geist', 'geist-mono', 'noto-sans-sc']) {
          const fileName = `licenses/${family}.txt`
          this.emitFile({
            type: 'asset',
            fileName,
            source: readFileSync(new URL(`../panel-ui/dist/${fileName}`, import.meta.url)),
          })
        }
      },
    },
  ],
  build: {
    outDir: fileURLToPath(new URL('./dist/panel/', import.meta.url)),
    emptyOutDir: true,
  },
})
