import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out-dev/main',
      rollupOptions: { input: { index: resolve('electron/dev/main.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out-dev/preload', lib: { entry: resolve('electron/dev/preload.ts') } }
  },
  renderer: {
    root: resolve('src/eris-dev'),
    plugins: [react()],
    build: {
      outDir: resolve('out-dev/renderer'),
      rollupOptions: { input: resolve('src/eris-dev/index.html') }
    }
  }
})
