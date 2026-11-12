import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development the panel talks to a locally running AsaBot (server.port defaults to 5140).
const backend = process.env.ASABOT_PANEL_BACKEND ?? 'http://127.0.0.1:5140'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: false, ws: true },
      // Plugin page files come from the backend; `_`-prefixed paths (the page SDK) are the panel's own public files.
      '^/plugin-pages/[^_]': { target: backend, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
})
