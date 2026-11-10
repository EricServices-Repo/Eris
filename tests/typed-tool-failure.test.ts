import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { executeTool } from '../electron/main/services/agent/execute-tool'
import { toolFailureRecovery } from '../electron/main/services/agent/recovery'
import { toolFailureMetadata } from '../electron/main/services/agent/loop'
import { classifyToolError } from '../electron/main/services/agent/tool-failure'
import { MutationAppliedError, MutationConflict } from '../electron/main/services/file-mutations'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })))
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'eris-typed-failure-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
  return root
}
const errno = (code: string, message: string) => Object.assign(new Error(message), { code })

describe('typed tool failures drive recovery (#448)', () => {
  it('Windows and macOS renderings of the same errno choose the same action', () => {
    const mac = classifyToolError(
      errno('ENOENT', "ENOENT: no such file or directory, open '/Users/me/p/x.ts'"),
      'read_file'
    )
    const win = classifyToolError(
      errno('ENOENT', 'Das System kann die angegebene Datei nicht finden.'),
      'read_file'
    )
    expect(mac?.code).toBe('not_found')
    expect(win).toEqual(mac)
    expect(toolFailureRecovery('read_file', 'Das System kann…', win)).toBe(
      toolFailureRecovery('read_file', 'ENOENT: no such file', mac)
    )
    const deniedMac = classifyToolError(errno('EACCES', 'permission denied'), 'write_file')
    const deniedWin = classifyToolError(errno('EPERM', 'Zugriff verweigert'), 'write_file')
    expect(deniedMac?.code).toBe('permission_denied')
    expect(deniedWin?.code).toBe('permission_denied')
    expect(toolFailureRecovery('write_file', '', deniedWin)).toBe(
      toolFailureRecovery('write_file', '', deniedMac)
    )
  })

  it('never marks an applied-but-unacknowledged write as retryable', () => {
    const failure = classifyToolError(new MutationAppliedError('receipt lost'), 'write_file', 'a')
    expect(failure).toMatchObject({ effectApplied: true, retryable: false })
    expect(toolFailureRecovery('write_file', 'timed out', failure)).toMatch(/Do not retry/)
    expect(toolFailureMetadata('timed out', 'workspace', failure)).toMatchObject({
      retryable: false,
      cause: 'effect-applied'
    })
  })

  it('keeps permission denial non-retryable regardless of message wording', () => {
    const failure = classifyToolError(errno('EACCES', 'network timed out'), 'read_file')
    expect(failure?.retryable).toBe(false)
    const meta = toolFailureMetadata('network timed out', 'read', failure)
    expect(meta).toMatchObject({ code: 'permission_denied', retryable: false })
    expect(toolFailureRecovery('read_file', 'network timed out', failure)).toMatch(
      /different model/
    )
  })

  it('classifies stale-edit conflicts by error class', () => {
    expect(classifyToolError(new MutationConflict('whatever text'), 'search_replace')?.code).toBe(
      'conflict'
    )
  })

  it('attaches typed failures to real workspace tool errors', () => {
    const root = workspace()
    const missing = executeTool(root, { name: 'read_file', args: { path: 'src/nope.ts' }, raw: '' })
    expect(missing.failure).toMatchObject({ code: 'not_found', operation: 'read_file' })
    // Previously "Not found: src/nope.ts" matched no recovery rule and got generic advice.
    expect(toolFailureRecovery('read_file', missing.detail, missing.failure)).toMatch(/tree, glob/)
    const absent = executeTool(root, {
      name: 'search_replace',
      args: { path: 'src/a.ts', old_string: 'nothing here', new_string: 'x' },
      raw: ''
    })
    // Previously mapped to 'unavailable' because the text contained "not found".
    expect(absent.failure?.code).toBe('precondition_failed')
    expect(toolFailureMetadata(absent.detail, 'workspace', absent.failure).code).toBe(
      'precondition_failed'
    )
    const escape = executeTool(root, { name: 'read_file', args: { path: '../../etc/x' }, raw: '' })
    expect(escape.failure?.code).toBe('permission_denied')
    const malformed = executeTool(root, { name: 'write_file', args: { path: 'src/b.ts' }, raw: '' })
    expect(malformed.failure?.code).toBe('invalid_arguments')
  })

  it('falls back to text only for errors without a stable identity', () => {
    expect(classifyToolError(new Error('something odd'), 'run')).toBeUndefined()
    expect(toolFailureRecovery('grep', 'fetch failed: ECONNRESET')).toMatch(/different source/)
    expect(toolFailureMetadata('User denied the command', 'command')).toMatchObject({
      code: 'permission_denied',
      cause: 'approval-denied'
    })
  })
})
