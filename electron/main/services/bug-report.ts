import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { homedir, platform, release, arch, cpus, totalmem } from 'os'
import { redactBugReportText } from '../../../src/shared/bug-report-sanitize'
import { getLogsInfo, logInfo, logWarn, readLogFile } from './logger'
import { getResolvedSettings } from './settings'
import { getSecret } from '../ipc/shared'
import { appState } from '../app-state'
import { normalizeApiBase } from './ericservices'
import { userDataRoot } from './paths'

/** Public issues inbox (created via API — never opens a browser). */
export const ERIS_FEEDBACK_OWNER = 'EricServices-Repo'
export const ERIS_FEEDBACK_REPO = 'Eris'
/** The deployed relay still files in the dedicated feedback inbox. */
const ERIS_FEEDBACK_INBOXES = new Set(['eris', 'eris-feedback'])

const MAX_LOG_CHARS = 48_000
const MAX_ISSUE_BODY = 55_000

export interface BugReportInput {
  title: string
  description: string
  includeLogs?: boolean
  includeDiagnostics?: boolean
}

export interface BugReportDiagnostics {
  appName: string
  appVersion: string
  packaged: boolean
  electron: string
  chrome: string
  node: string
  platform: string
  release: string
  arch: string
  locale: string
  cpuCount: number
  totalMemGb: number
  workspaceLinked: boolean
  workspaceName: string | null
  defaultModel: string | null
  ericServicesLinked: boolean
  ericServicesPlan: string | null
  githubHost: string | null
  githubLinked: boolean
  loggingEnabled: boolean
  loggingLevel: string
  logDirectory: string
  currentLogFile: string
  logFileCount: number
}

export interface BugReportPreview {
  title: string
  body: string
  diagnostics: BugReportDiagnostics
  logIncluded: boolean
  logTruncated: boolean
  logPath: string | null
  /** Legacy field: the relay does not expose a GitHub credential to the client. */
  hasGithubToken: boolean
  targetRepo: string
}

export interface BugReportResult {
  ok: boolean
  error?: string
  number?: number
  htmlUrl?: string
  via?: 'ericservices' | 'builtin'
}

export interface FeedbackHistoryItem {
  id: string
  title: string
  number?: number
  htmlUrl?: string
  via?: 'ericservices' | 'builtin'
  submittedAt: string
}

const FEEDBACK_HISTORY_MAX = 40

function feedbackHistoryPath(): string {
  return join(userDataRoot(), 'feedback-history.json')
}

export function listFeedbackHistory(): FeedbackHistoryItem[] {
  try {
    const path = feedbackHistoryPath()
    if (!existsSync(path)) return []
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .filter((x): x is FeedbackHistoryItem =>
        Boolean(x && typeof x === 'object' && (x as FeedbackHistoryItem).title)
      )
      .slice(0, FEEDBACK_HISTORY_MAX)
  } catch {
    return []
  }
}

function recordFeedbackHistory(item: FeedbackHistoryItem): void {
  try {
    const dir = userDataRoot()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const prev = listFeedbackHistory()
    const next = [item, ...prev.filter((x) => x.id !== item.id)].slice(0, FEEDBACK_HISTORY_MAX)
    writeFileSync(feedbackHistoryPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    logWarn('Could not persist feedback history', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

function workspaceDisplayName(): string | null {
  const path = appState.currentWorkspace
  if (!path) return null
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || null
}

export function collectBugDiagnostics(): BugReportDiagnostics {
  const settings = getResolvedSettings(appState.currentWorkspace)
  const logs = getLogsInfo()
  return {
    appName: app.getName(),
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
    node: process.versions.node || '',
    platform: `${platform()} ${release()}`,
    release: release(),
    arch: arch(),
    locale: app.getLocale(),
    cpuCount: cpus()?.length || 0,
    totalMemGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    workspaceLinked: Boolean(appState.currentWorkspace),
    workspaceName: workspaceDisplayName(),
    defaultModel: settings.models?.defaultModel || null,
    ericServicesLinked: Boolean(settings.ericServices?.linked),
    ericServicesPlan: settings.ericServices?.plan || null,
    githubHost: settings.github?.host || null,
    githubLinked: Boolean(settings.github?.linked),
    loggingEnabled: logs.enabled,
    loggingLevel: logs.level,
    logDirectory: logs.directory,
    currentLogFile: logs.currentFile.split(/[/\\]/).pop() || logs.currentFile,
    logFileCount: logs.files.length
  }
}

function formatDiagnosticsMarkdown(d: BugReportDiagnostics): string {
  return [
    '## Environment',
    '',
    `| | |`,
    `|---|---|`,
    `| App | ${d.appName} ${d.appVersion}${d.packaged ? '' : ' (unpackaged)'} |`,
    `| Electron / Chrome / Node | ${d.electron} / ${d.chrome} / ${d.node} |`,
    `| OS | ${d.platform} (${d.arch}) |`,
    `| Locale | ${d.locale} |`,
    `| CPU / RAM | ${d.cpuCount} cores / ${d.totalMemGb} GB |`,
    `| Workspace | ${d.workspaceLinked ? d.workspaceName || '(linked)' : '(none)'} |`,
    `| Default model | ${d.defaultModel || '—'} |`,
    `| EricServic.es | ${d.ericServicesLinked ? d.ericServicesPlan || 'linked' : 'not linked'} |`,
    `| GitHub settings | host=${d.githubHost || '—'}; linked=${d.githubLinked} |`,
    `| Logging | ${d.loggingEnabled ? d.loggingLevel : 'off'}; files=${d.logFileCount}; current=\`${d.currentLogFile}\` |`,
    ''
  ].join('\n')
}

function trimBody(body: string): string {
  if (body.length <= MAX_ISSUE_BODY) return body
  return body.slice(0, MAX_ISSUE_BODY) + '\n\n---\n_(Issue body truncated to fit GitHub limits.)_\n'
}

export function buildBugReportPreview(input: BugReportInput): BugReportPreview {
  const title = input.title.trim() || 'Bug report'
  const description = input.description.trim() || '_No description provided._'
  const includeLogs = input.includeLogs !== false
  const includeDiagnostics = input.includeDiagnostics !== false
  const diagnostics = collectBugDiagnostics()

  let logContent = ''
  let logTruncated = false
  let logPath: string | null = null
  if (includeLogs) {
    const file = readLogFile({ maxBytes: MAX_LOG_CHARS })
    logPath = file.path
    logTruncated = file.truncated
    logContent = redactBugReportText(file.content || '(empty log file)', homedir())
  }

  const parts = [
    '## What happened',
    '',
    description,
    '',
    '## Steps to reproduce',
    '',
    '_Please fill in if not covered above._',
    '',
    '## Expected vs actual',
    '',
    '_Expected:_',
    '',
    '_Actual:_',
    ''
  ]

  if (includeDiagnostics) {
    parts.push(formatDiagnosticsMarkdown(diagnostics))
  }

  if (includeLogs) {
    parts.push(
      '## Recent logs',
      '',
      logTruncated
        ? `_Last ~${Math.round(MAX_LOG_CHARS / 1024)} KB of \`${diagnostics.currentLogFile}\` (truncated)._`
        : `_From \`${diagnostics.currentLogFile}\`._`,
      '',
      '```text',
      logContent || '(no log content)',
      '```',
      ''
    )
  }

  parts.push('---', `_Submitted from Eris ${diagnostics.appVersion} via **Report a Bug**._`)

  return {
    title: title.slice(0, 200),
    body: trimBody(parts.join('\n')),
    diagnostics,
    logIncluded: includeLogs,
    logTruncated,
    logPath,
    hasGithubToken: false,
    targetRepo: `${ERIS_FEEDBACK_OWNER}/${ERIS_FEEDBACK_REPO}`
  }
}

async function submitViaEricServices(preview: BugReportPreview): Promise<BugReportResult | null> {
  const settings = getResolvedSettings(appState.currentWorkspace)
  const apiBase = normalizeApiBase(settings.ericServices?.apiBase || 'https://www.ericservic.es')
  const url = `${apiBase}/api/eris/v1/feedback.php`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
  const tokenRef = settings.ericServices?.tokenRef || ''
  const eseris = tokenRef ? getSecret(tokenRef) : null
  if (eseris) headers.Authorization = `Bearer ${eseris}`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        title: preview.title,
        body: preview.body,
        owner: ERIS_FEEDBACK_OWNER,
        repo: ERIS_FEEDBACK_REPO
      })
    })
    const text = await res.text()
    let data: Record<string, unknown> = {}
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      if (res.status === 404) return null
      return null
    }
    if (!res.ok || data.ok === false) {
      // Unconfigured relay is reported as unavailable; no client-side credential fallback.
      if (res.status === 404 || res.status === 503) return null
      return {
        ok: false,
        error:
          typeof data.error === 'string' ? data.error : `Feedback relay failed (${res.status})`,
        via: 'ericservices'
      }
    }
    return {
      ok: true,
      number: typeof data.number === 'number' ? data.number : undefined,
      htmlUrl:
        typeof data.htmlUrl === 'string'
          ? data.htmlUrl
          : typeof data.html_url === 'string'
            ? data.html_url
            : undefined,
      via: 'ericservices'
    }
  } catch (err) {
    logWarn('EricServic.es feedback relay unreachable', {
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

/** Only the product repository and its deployed feedback inbox are trusted. */
function erisIssue(url: string | undefined): { htmlUrl: string; number: number } | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'github.com' ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return null
    const match = /^\/EricServices-Repo\/([^/]+)\/issues\/([1-9]\d*)\/?$/i.exec(parsed.pathname)
    if (!match || !ERIS_FEEDBACK_INBOXES.has(match[1]!.toLowerCase())) return null
    const number = Number(match[2])
    if (!Number.isSafeInteger(number)) return null
    const repo = match[1]!.toLowerCase() === 'eris' ? 'Eris' : 'Eris-feedback'
    return { htmlUrl: `https://github.com/${ERIS_FEEDBACK_OWNER}/${repo}/issues/${number}`, number }
  } catch {
    return null
  }
}

export async function submitBugReport(input: BugReportInput): Promise<BugReportResult> {
  const preview = buildBugReportPreview(input)
  const relay = await submitViaEricServices(preview)
  if (!relay)
    return {
      ok: false,
      error:
        'The feedback service could not confirm submission. Your report may already exist; check the Eris feedback inbox before retrying, or contact support.',
      via: 'ericservices'
    }
  if (!relay.ok) return relay
  const issue = erisIssue(relay.htmlUrl)
  if (!issue || (relay.number !== undefined && relay.number !== issue.number))
    return {
      ok: false,
      error:
        'The feedback service did not return a valid Eris issue link. Your report may already exist; contact support before submitting it again.',
      via: 'ericservices'
    }
  const result = { ...relay, ...issue }
  recordFeedbackHistory({
    id: `ericservices-${issue.htmlUrl}`,
    title: preview.title,
    number: issue.number,
    htmlUrl: issue.htmlUrl,
    via: 'ericservices',
    submittedAt: new Date().toISOString()
  })
  logInfo('Bug report created via feedback service', { number: issue.number })
  return result
}
