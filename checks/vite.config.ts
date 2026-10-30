import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
export default defineConfig({
  root: resolve('checks'),
  base: './',
  plugins: [react()],
  resolve: { alias: { '@': resolve('src') } },
  build: {
    outDir: resolve('.eris/cache/client-check'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        ux: resolve('checks/ux.html'),
        capabilities: resolve('checks/capabilities.html'),
        index: resolve('checks/index.html'),
        performance: resolve('checks/performance.html'),
        accessibility: resolve('checks/accessibility.html')
      }
    }
  }
})
