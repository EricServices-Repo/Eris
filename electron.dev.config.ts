import { execFileSync } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Source revision stamped into the packaged Eris-Dev app, so an installed build can
 * name its revision without Git. Unknown stays explicit for builds outside a checkout.
 */
function buildStamp() {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 << 20 }).trim()
  try {
    const status = git('status', '--porcelain')
    return {
      gitSha: git('rev-parse', 'HEAD'),
      dirty: status.length > 0,
      dirtyDigest: status
        ? createHash('sha256').update(status).update(git('diff', 'HEAD')).digest('hex').slice(0, 16)
        : null,
      buildId: `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`
    }
  } catch {
    return {
      gitSha: 'unknown',
      dirty: null,
      dirtyDigest: null,
      buildId: `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`
    }
  }
}

export default defineConfig(({ command }) => ({
  main: {
    plugins: [externalizeDepsPlugin()],
    // `electron-vite dev` reads the live checkout instead; only builds are stamped.
    define: command === 'build' ? { __ERIS_DEV_BUILD__: JSON.stringify(buildStamp()) } : undefined,
    build: {
      outDir: 'out-dev/main',
      rollupOptions: {
        input: {
          index: resolve('electron/dev/main.ts'),
          'llama-worker': resolve('electron/main/llama-worker.ts'),
          'workspace-worker': resolve('electron/main/workspace-worker.ts')
        }
      }
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
}))
