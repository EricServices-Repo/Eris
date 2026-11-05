const SECRET_KEY = String.raw`authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|password|passwd`

/**
 * key=value, `key: value` and JSON `"key": "value"`. The quote before the colon must be
 * allowed or JSON fields slip through, and an auth scheme word is consumed with its
 * credential so `Authorization: Bearer x` cannot redact only "Bearer".
 */
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b(${SECRET_KEY})(["']?)(\s*[:=]\s*)(["']?)(?:(?:Bearer|Basic|Digest|token)\s+)?[^\s"'\\,;&}]+["']?`,
  'gi'
)

/** Redact tokens / secrets and shorten home paths for bug-report bodies. */
export function redactBugReportText(text: string, homeDir?: string): string {
  let out = text
  out = out.replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '[redacted-github-token]')
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-github-pat]')
  // Provider keys carry dashed prefixes: sk-proj-…, sk-ant-api03-…, sk-or-v1-…
  out = out.replace(/\b(sk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted-api-key]')
  out = out.replace(/\bhf_[A-Za-z0-9]{20,}\b/g, '[redacted-huggingface-token]')
  out = out.replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted-api-key]')
  out = out.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted-aws-key]')
  out = out.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted-slack-token]')
  out = out.replace(/\beseris_[A-Za-z0-9_]{12,}\b/gi, '[redacted-eris-token]')
  out = out.replace(
    SECRET_ASSIGNMENT,
    (_match, key: string, keyQuote: string, sep: string, valueQuote: string) =>
      // Keep JSON valid when the field was quoted; plain text keeps the key=[redacted] form.
      keyQuote ? `${key}${keyQuote}${sep}${valueQuote}[redacted]${valueQuote}` : `${key}=[redacted]`
  )
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]')
  const home = (homeDir || '').trim()
  if (home.length > 2) {
    out = out.split(home).join('~')
  }
  return out
}
