/**
 * Typed tool failures. Recovery decisions read these fields, never the error text, so the
 * same failure on Windows and macOS (or from another provider or locale) selects the same
 * action. Message text is kept only for presentation and the unknown-failure fallback.
 */
export type ToolFailureCode =
  | 'permission_denied'
  | 'precondition_failed'
  | 'invalid_arguments'
  | 'ambiguous_match'
  | 'not_found'
  | 'conflict'
  | 'timeout'
  | 'network'
  | 'unavailable'
  | 'execution_failed'

export interface TypedToolFailure {
  code: ToolFailureCode
  /** A changed retry may succeed. Never true when the effect may already have applied. */
  retryable: boolean
  /** The operation may have changed state before failing; it must not be blindly retried. */
  effectApplied: boolean
  operation: string
  path?: string
}

const ERRNO: Record<string, ToolFailureCode> = {
  ENOENT: 'not_found',
  ENOTDIR: 'not_found',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  EROFS: 'permission_denied',
  EISDIR: 'precondition_failed',
  EEXIST: 'precondition_failed',
  ENOTEMPTY: 'precondition_failed',
  EBUSY: 'unavailable',
  ETIMEDOUT: 'timeout',
  ECONNREFUSED: 'network',
  ECONNRESET: 'network',
  ENOTFOUND: 'network',
  EAI_AGAIN: 'network',
  ENETUNREACH: 'network',
  EHOSTUNREACH: 'network'
}

const RETRYABLE = new Set<ToolFailureCode>([
  'precondition_failed',
  'ambiguous_match',
  'not_found',
  'conflict',
  'timeout',
  'network',
  'unavailable'
])

const CODES = new Set<string>([
  'permission_denied',
  'precondition_failed',
  'ambiguous_match',
  'invalid_arguments',
  'not_found',
  'conflict',
  'timeout',
  'network',
  'unavailable',
  'execution_failed'
])

function codeOf(error: unknown): ToolFailureCode | undefined {
  if (!error || typeof error !== 'object') return undefined
  const name = (error as { name?: unknown }).name
  if ((error as object).constructor?.name === 'MutationConflict') return 'conflict'
  if (name === 'TimeoutError') return 'timeout'
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return undefined
  if (Object.hasOwn(ERRNO, code)) return ERRNO[code]
  if (code === 'ABORT_ERR') return 'timeout'
  return CODES.has(code) ? (code as ToolFailureCode) : undefined
}

/**
 * Classify a thrown error by its structured identity (error class, errno code), not its
 * message. Returns undefined when the error carries no stable identity.
 */
export function classifyToolError(
  error: unknown,
  operation: string,
  path?: string
): TypedToolFailure | undefined {
  const code = codeOf(error)
  const effectApplied = Boolean(
    error &&
    typeof error === 'object' &&
    'mutationApplied' in error &&
    (error as { mutationApplied?: unknown }).mutationApplied
  )
  if (!code && !effectApplied) return undefined
  const resolved = code ?? 'execution_failed'
  return {
    code: resolved,
    retryable: !effectApplied && RETRYABLE.has(resolved),
    effectApplied,
    operation,
    ...(path ? { path } : {})
  }
}

/** Stable recovery guidance for a typed failure; undefined when only text can decide. */
export function typedFailureRecovery(failure: TypedToolFailure): string | undefined {
  if (failure.effectApplied)
    return 'Do not retry this operation: its change may already be applied. Re-read the affected file to confirm its current state before any further edit.'
  switch (failure.code) {
    case 'permission_denied':
      return 'Do not repeat the same access or retry it with a different model. Use an allowed alternative inside the workspace, or report the boundary that blocked it.'
    case 'conflict':
      return 'The file changed outside this task. Read it again, then make a new edit against the current contents; do not overwrite the external change.'
    case 'not_found':
      return 'Verify the path with tree, glob, or grep before retrying. Use a workspace-relative path. If the user asked to build or create something new, switch to write_file for the intended project file instead of retrying search_replace on the missing path.'
    case 'precondition_failed':
      return 'Read the target again and adjust the call to its current contents (for search_replace, copy old_string exactly from the file); do not resend the same call.'
    case 'ambiguous_match':
      return 'Choose the intended match using a listed one-based start_line, keeping old_string exact. If unsure, read a narrow range around the listed lines; if several matches share a line, include unique surrounding text. Set replace_all only when the requested edit applies to every occurrence.'
    case 'invalid_arguments':
      return 'Correct the argument shape from the tool description and make one call with valid fields; do not resend the same malformed arguments.'
    case 'timeout':
      return 'Reduce the scope or use a narrower read. Retry at most once after changing the request; if it still fails, continue with available evidence and report the limit.'
    case 'network':
      return 'Try one different source or a smaller request. If connectivity still fails, answer from verified workspace evidence or state that current external facts could not be checked.'
    default:
      return undefined
  }
}
