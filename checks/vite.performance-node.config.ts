import { defineConfig } from 'vite'
import { externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'
export default defineConfig({
  plugins: [externalizeDepsPlugin()],
  build: {
    ssr: true,
    outDir: resolve('.eris/cache/performance'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'workspace-performance': resolve('checks/workspace-performance.ts'),
        'workspace-worker': resolve('electron/main/workspace-worker.ts')
      },
      output: {
        format: 'cjs',
        entryFileNames: (chunk) =>
          chunk.name === 'workspace-worker' ? 'workspace-worker.js' : '[name].cjs'
      }
    }
  }
})
