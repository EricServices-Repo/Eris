import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import { runWorkspaceCommand } from '../electron/main/services/shell-run'
import { setWorkspaceTrusted } from '../electron/main/services/workspace-trust'
import { buildAgentProcessEnv } from '../electron/main/services/workspace-env'
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn: () => boolean) {
  const end = Date.now() + 15000
  while (!fn()) {
    if (Date.now() > end) throw new Error('Process cleanup deadline exceeded')
    await pause(25)
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
describe('owned host execution', () => {
  it('blocks untrusted and unavailable isolated execution before effects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eris-untrusted-'))
    try {
      const command = `"${process.execPath}" -e "require('fs').writeFileSync('effect','unsafe')"`
      expect((await runWorkspaceCommand(root, command)).executionBoundary).toBe('blocked')
      setWorkspaceTrusted(root, true)
      expect(
        (await runWorkspaceCommand(root, command, { isolation: 'isolated' })).executionBoundary
      ).toBe('blocked')
      expect(existsSync(join(root, 'effect'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
  it.each(['cancel', 'timeout'] as const)(
    'terminates descendants after %s without killing another command',
    async (reason) => {
      const root = mkdtempSync(join(tmpdir(), 'eris-owned-'))
      const controller = new AbortController()
      let pids: number[] = []
      setWorkspaceTrusted(root, true)
      writeFileSync(
        join(root, 'parent.cjs'),
        `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`
      )
      const other = runWorkspaceCommand(
        root,
        `"${process.execPath}" -e "setTimeout(()=>{console.log('independent')},500)"`
      )
      try {
        const running = runWorkspaceCommand(root, `"${process.execPath}" parent.cjs`, {
          signal: controller.signal,
          timeoutMs: reason === 'timeout' ? 8000 : 20000
        })
        await until(() => existsSync(join(root, 'pids.json')))
        pids = JSON.parse(readFileSync(join(root, 'pids.json'), 'utf8'))
        if (reason === 'cancel') controller.abort()
        const result = await running
        expect(result.ok).toBe(false)
        expect(result.timedOut).toBe(reason === 'timeout')
        await until(() => pids.every((pid) => !alive(pid)))
        expect((await other).stdout).toContain('independent')
      } finally {
        controller.abort()
        for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
        await other
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
    30000
  )
  it('does not inherit credentials or runtime injection into agent commands', () => {
    process.env.ERIS_TEST_SECRET_TOKEN = 'private'
    process.env.NODE_OPTIONS = '--trace-warnings'
    const root = mkdtempSync(join(tmpdir(), 'eris-env-'))
    try {
      const env = buildAgentProcessEnv(root)
      expect(env.ERIS_TEST_SECRET_TOKEN).toBeUndefined()
      expect(env.NODE_OPTIONS).toBeUndefined()
      expect(env.PATH || env.Path).toBeTruthy()
    } finally {
      delete process.env.ERIS_TEST_SECRET_TOKEN
      delete process.env.NODE_OPTIONS
      rmSync(root, { recursive: true, force: true })
    }
  })
})
