import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
export default defineConfig({
  root: resolve('checks'),
  base: './',
  plugins: [react()],
  resolve: { alias: { '@': resolve('src') } },
  build: { outDir: resolve('.eris/cache/client-check'), emptyOutDir: true }
})
