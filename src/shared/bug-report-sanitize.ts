/** Redact tokens / secrets and shorten home paths for bug-report bodies. */
export function redactBugReportText(text: string, homeDir?: string): string {
  let out = text
  out = out.replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '[redacted-github-token]')
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-github-pat]')
  out = out.replace(/\b(sk|rk)-[A-Za-z0-9]{16,}\b/g, '[redacted-api-key]')
  out = out.replace(/\beseris_[A-Za-z0-9_]{12,}\b/gi, '[redacted-eris-token]')
  out = out.replace(
    /(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"'\\]+/gi,
    '$1=[redacted]'
  )
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]')
  const home = (homeDir || '').trim()
  if (home.length > 2) {
    out = out.split(home).join('~')
  }
  return out
}
