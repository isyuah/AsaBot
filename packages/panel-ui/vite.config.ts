import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [
    tailwindcss(),
    {
      name: 'panel-font-licenses',
      generateBundle() {
        for (const family of ['geist', 'geist-mono', 'noto-sans-sc']) {
          this.emitFile({
            type: 'asset',
            fileName: `licenses/${family}.txt`,
            source: readFileSync(
              new URL(import.meta.resolve(`@fontsource-variable/${family}/LICENSE`)),
              'utf8',
            ),
          })
        }
      },
    },
  ],
  build: {
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: ['src/styles.css', 'src/fonts.css'],
      output: {
        assetFileNames: ({ names }) =>
          names.some((name) => name.endsWith('.css')) ? '[name][extname]' : 'assets/[name]-[hash][extname]',
      },
    },
  },
})
