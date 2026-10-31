import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const sourceIdentity = () => {
  try {
    return {
      gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
      lockSha256: createHash('sha256').update(readFileSync('package-lock.json')).digest('hex')
    }
  } catch {
    return { gitSha: 'unknown', dirty: true, lockSha256: 'unknown' }
  }
}
export default defineConfig({
  main: {
    define: { __ERIS_SOURCE_IDENTITY__: JSON.stringify(sourceIdentity()) },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/main/index.ts'),
          'llama-worker': resolve('electron/main/llama-worker.ts'),
          'workspace-worker': resolve('electron/main/workspace-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve('electron/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve('src'),
    build: {
      rollupOptions: {
        input: resolve('src/index.html')
      }
    },
    resolve: {
      alias: {
        '@': resolve('src')
      }
    },
    plugins: [react()]
  }
})
