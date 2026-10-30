import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { openSync, closeSync, readSync, fstatSync, realpathSync, statSync } from 'fs'
import { relative, resolve } from 'path'
import { isPathInside } from './workspace-boundary'
import { ContextEvidenceSchema, type ContextEvidence } from '../../../src/shared/context-evidence'
const repository = (root: string) => {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'], {
      encoding: 'utf8',
      timeout: 500,
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch (error) {
    const message = String((error as { stderr?: unknown }).stderr ?? '')
    return /not a git repository/i.test(message) ? 'none' : 'unavailable'
  }
}
/** Worker-only, maximum 32 files, 1 MiB/file, 8 MiB total. No repository-wide scan. */
export function captureContextEvidence(
  root: string,
  paths: readonly string[],
  budget = { bytes: 8 * 1024 ** 2, deadline: Infinity },
  repositoryOverride?: string
): ContextEvidence {
  const canonical = realpathSync(root),
    repo = repositoryOverride ?? repository(canonical),
    files: ContextEvidence['files'] = []
  if (!Number.isFinite(budget.deadline)) budget.deadline = Date.now() + 100
  let complete = paths.length <= 32 && repo !== 'unavailable'
  for (const path of [...new Set(paths)].slice(0, 32)) {
    try {
      if (Date.now() > budget.deadline) throw new Error('source budget expired')
      const abs = realpathSync(resolve(canonical, path))
      if (!isPathInside(canonical, abs)) throw new Error('outside root')
      const before = statSync(abs)
      if (!before.isFile() || before.size > 1024 ** 2 || before.size > budget.bytes)
        throw new Error('bounded source unavailable')
      budget.bytes -= before.size
      const fd = openSync(abs, 'r')
      let bytes: Buffer, after: ReturnType<typeof statSync>
      try {
        const buffer = Buffer.alloc(before.size + 1)
        const count = readSync(fd, buffer, 0, buffer.length, 0)
        bytes = buffer.subarray(0, count)
        after = fstatSync(fd)
      } finally {
        closeSync(fd)
      }
      if (
        bytes.length !== before.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino
      )
        throw new Error('source changed')
      files.push({
        path: relative(canonical, abs).split('\\').join('/'),
        bytes: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex')
      })
    } catch {
      complete = false
    }
  }
  if (repositoryOverride === undefined) complete &&= repository(canonical) === repo
  return { version: 1, root: canonical, repository: repo, complete, files }
}
export function validateContextEvidence(root: string, snapshots: readonly ContextEvidence[]) {
  const canonical = realpathSync(root),
    repo = repository(canonical),
    budget = { bytes: 8 * 1024 ** 2, deadline: Date.now() + 100 }
  const results = snapshots.slice(0, 24).map((input) => {
    const parsed = ContextEvidenceSchema.safeParse(input)
    if (!parsed.success || !input.complete || input.root !== canonical) return false
    const now = captureContextEvidence(
      canonical,
      input.files.map((f) => f.path),
      budget,
      repo
    )
    return (
      now.complete &&
      now.repository === input.repository &&
      now.files.length === input.files.length &&
      now.files.every(
        (file, i) =>
          file.path === input.files[i]?.path &&
          file.digest === input.files[i]?.digest &&
          file.bytes === input.files[i]?.bytes
      )
    )
  })
  return repository(canonical) === repo ? results : results.map(() => false)
}
