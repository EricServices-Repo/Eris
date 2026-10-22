import { homedir } from 'os'
import { redactBugReportText } from '../../../../src/shared/bug-report-sanitize'

/** Redact credentials, sandbox and home paths, then bound the length. */
export function redactDiagnostic(text: string, sandbox?: string | null, limit = 600): string {
  let out = text
  if (sandbox) out = out.split(sandbox).join('<sandbox>')
  out = redactBugReportText(out, homedir())
  return out.length > limit ? `${out.slice(0, limit)}… (+${out.length - limit} chars)` : out
}
