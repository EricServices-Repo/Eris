import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolveInWorkspace, toWorkspaceRelative } from '../workspace-fs'

/**
 * A requirement the agent showed is already met, so no edit was needed. It is a separate
 * result type from a change: it never counts as a mutation, and it is accepted only with
 * source the agent fully read, that is unchanged since, and that contains the quoted proof.
 */
export interface VerifiedNoop {
  requirement: string
  path: string
  /** sha256 of the file when it was confirmed; a later change invalidates the claim. */
  fileDigest: string
  excerptDigest: string
}

const MIN_EXCERPT_CHARS = 8
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * Check a `confirm_unchanged` call. `fullReadRevision` returns the revision recorded for a
 * complete read of the path in this task, or undefined if it was never fully read.
 */
export function confirmUnchanged(
  workspacePath: string,
  args: Record<string, unknown>,
  fullReadRevision: (path: string) => string | undefined
): { ok: boolean; detail: string; path?: string; noop?: VerifiedNoop } {
  const requirement = typeof args.requirement === 'string' ? args.requirement.trim() : ''
  const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
  const excerpt = typeof args.evidence === 'string' ? args.evidence : ''
  if (!requirement || !rawPath || !excerpt)
    return { ok: false, detail: 'requirement, path and evidence are required.' }
  let absolute: string
  try {
    absolute = resolveInWorkspace(workspacePath, rawPath)
  } catch {
    return { ok: false, detail: `Invalid workspace path: ${rawPath}` }
  }
  if (!existsSync(absolute) || statSync(absolute).isDirectory())
    return { ok: false, detail: `Not a file: ${rawPath}` }
  const path = toWorkspaceRelative(workspacePath, absolute)
  const bytes = readFileSync(absolute)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const revision = fullReadRevision(path)
  if (!revision)
    return {
      ok: false,
      path,
      detail: `Read the whole of ${path} with read_file before confirming it already satisfies the request.`
    }
  if (revision !== digest)
    return {
      ok: false,
      path,
      detail: `${path} changed after it was read. Read it again before confirming it is unchanged.`
    }
  const quoted = normalize(excerpt)
  if (quoted.replace(/\s/g, '').length < MIN_EXCERPT_CHARS)
    return {
      ok: false,
      path,
      detail: 'Quote the specific source lines that satisfy the requirement as evidence.'
    }
  if (!normalize(bytes.toString('utf8')).includes(quoted))
    return {
      ok: false,
      path,
      detail: `The evidence is not present verbatim in ${path}. Quote the exact existing lines, or make the change.`
    }
  return {
    ok: true,
    path,
    detail: `Confirmed: ${path} already satisfies "${requirement.slice(0, 200)}". No change was made.`,
    noop: {
      requirement: requirement.slice(0, 500),
      path,
      fileDigest: digest,
      excerptDigest: createHash('sha256').update(quoted).digest('hex')
    }
  }
}
