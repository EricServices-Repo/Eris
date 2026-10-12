/**
 * Lightweight command policy for the `run` tool.
 * Deny high-risk patterns; allow common build/test/git workflows.
 */

const DENY = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\//i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b:\(\)\s*\{\s*:\|:&\s*\}\s*;/i, // fork bomb
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/i,
  /\bwget\b[^|]*\|\s*(ba)?sh\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bchown\s+-R\b/i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /\bnc\s+-l\b|\bncat\s+-l\b/i,
  /\bdocker\b|\bpodman\b|\bkubectl\b/i,
  /\bsudo\b|\bdoas\b/i,
  /\bscp\b|\brsync\b.*\s\/\s/i,
  />\s*\/etc\//i,
  /\bpython[^|]*-c\s+['"][^'"]*os\.system/i
]

const ALLOW_HINT =
  'Allowed examples: npm test, npm run build, node …, git status, ls, cat, tsc, pytest, go test'

export function assertShellAllowed(command: string): { ok: true } | { ok: false; error: string } {
  const trimmed = command.trim()
  if (!trimmed) return { ok: false, error: 'command is required' }
  if (trimmed.length > 4_000) return { ok: false, error: 'command too long' }
  for (const re of DENY) {
    if (re.test(trimmed)) {
      return {
        ok: false,
        error: `Command blocked by Cloud Agent sandbox. ${ALLOW_HINT}`
      }
    }
  }
  // Block absolute destructive redirects outside workspace (best-effort)
  if (/(^|[;&|])\s*rm\s+-[^\n]*\.\./i.test(trimmed)) {
    return { ok: false, error: `Command blocked (path traversal). ${ALLOW_HINT}` }
  }
  return { ok: true }
}
