import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { homedir, platform, release, arch, cpus, totalmem } from 'os'
import { redactBugReportText } from '../../../src/shared/bug-report-sanitize'
import { createGithubIssue } from './github'
import { getLogsInfo, logInfo, logWarn, readLogFile } from './logger'
import { getResolvedSettings } from './settings'
import { getSecret } from '../ipc/shared'
import { appState } from '../app-state'
import { normalizeApiBase } from './ericservices'
import { userDataRoot } from './paths'

/** Public issues inbox (created via API — never opens a browser). */
export const ERIS_FEEDBACK_OWNER = 'EricServices-Repo'
export const ERIS_FEEDBACK_REPO = 'Eris'

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
  /** Always true — submission uses the EricServic.es relay and/or a built-in token. */
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
      .filter((x): x is FeedbackHistoryItem => Boolean(x && typeof x === 'object' && (x as FeedbackHistoryItem).title))
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
    totalMemGb: Math.round(totalmem() / 1024 ** 3 * 10) / 10,
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
  return (
    body.slice(0, MAX_ISSUE_BODY) +
    '\n\n---\n_(Issue body truncated to fit GitHub limits.)_\n'
  )
}

/**
 * Built-in feedback credential (Issues on EricServices-Repo/Eris).
 * Sources: env, packaged resources/eris-feedback-token, or repo resources/ for local builds.
 * End users never configure this.
 */
export function resolveBuiltinFeedbackToken(): string | null {
  const fromEnv = (process.env.ERIS_FEEDBACK_GITHUB_TOKEN || '').trim()
  if (fromEnv) return fromEnv

  const candidates = [
    join(process.resourcesPath || '', 'eris-feedback-token'),
    join(process.resourcesPath || '', 'resources', 'eris-feedback-token'),
    join(app.getAppPath(), 'resources', 'eris-feedback-token'),
    join(__dirname, '../../../resources/eris-feedback-token')
  ]
  for (const path of candidates) {
    try {
      if (!path || !existsSync(path)) continue
      const value = readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'))
        ?.trim()
      if (
        value &&
        !/REPLACE_ME|github_pat_or_ghp/i.test(value) &&
        value.length >= 20
      ) {
        return value
      }
    } catch {
      // try next
    }
  }
  return null
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

  parts.push(
    '---',
    `_Submitted from Eris ${diagnostics.appVersion} via **Report a Bug**._`
  )

  return {
    title: title.slice(0, 200),
    body: trimBody(parts.join('\n')),
    diagnostics,
    logIncluded: includeLogs,
    logTruncated,
    logPath,
    hasGithubToken: true,
    targetRepo: `${ERIS_FEEDBACK_OWNER}/${ERIS_FEEDBACK_REPO}`
  }
}

async function submitViaEricServices(
  preview: BugReportPreview
): Promise<BugReportResult | null> {
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
      // 503 = relay not configured yet — fall through to builtin
      if (res.status === 404 || res.status === 503) return null
      return {
        ok: false,
        error: typeof data.error === 'string' ? data.error : `Feedback relay failed (${res.status})`,
        via: 'ericservices'
      }
    }
    return {
      ok: true,
      number: typeof data.number === 'number' ? data.number : undefined,
      htmlUrl: typeof data.htmlUrl === 'string' ? data.htmlUrl : undefined,
      via: 'ericservices'
    }
  } catch (err) {
    logWarn('EricServic.es feedback relay unreachable', {
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

async function submitViaBuiltinToken(preview: BugReportPreview): Promise<BugReportResult> {
  const token = resolveBuiltinFeedbackToken()
  if (!token) {
    return {
      ok: false,
      error:
        'Bug reporting is not configured in this build (missing feedback credential). Update Eris or contact support.'
    }
  }
  const created = await createGithubIssue({
    host: 'github.com',
    token,
    owner: ERIS_FEEDBACK_OWNER,
    repo: ERIS_FEEDBACK_REPO,
    title: preview.title,
    body: preview.body,
    labels: ['bug', 'from-client', 'needs-triage']
  })
  if (!created.ok) {
    return { ok: false, error: created.error || 'Could not create GitHub issue', via: 'builtin' }
  }
  return {
    ok: true,
    number: created.number,
    htmlUrl: created.htmlUrl,
    via: 'builtin'
  }
}

export async function submitBugReport(input: BugReportInput): Promise<BugReportResult> {
  const preview = buildBugReportPreview(input)
  logInfo('Bug report submit started', {
    includeLogs: preview.logIncluded,
    titleLen: preview.title.length,
    bodyLen: preview.body.length,
    hasBuiltin: Boolean(resolveBuiltinFeedbackToken())
  })

  // 1) Prefer EricServic.es relay (token stays on the server)
  const relay = await submitViaEricServices(preview)
  if (relay?.ok) {
    logInfo('Bug report created via EricServic.es', {
      number: relay.number,
      url: relay.htmlUrl
    })
    recordFeedbackHistory({
      id: `es-${relay.number ?? Date.now()}`,
      title: preview.title,
      number: relay.number,
      htmlUrl: relay.htmlUrl,
      via: 'ericservices',
      submittedAt: new Date().toISOString()
    })
    return relay
  }
  if (relay && !relay.ok && relay.error && !/not configured|404/i.test(relay.error)) {
    // Real relay error (rate limit, GitHub down) — still try builtin before failing
    logWarn('EricServic.es feedback relay error', { error: relay.error })
  }

  // 2) Built-in client credential → GitHub Issues API (no user Settings token)
  const direct = await submitViaBuiltinToken(preview)
  if (direct.ok) {
    logInfo('Bug report created via builtin token', {
      number: direct.number,
      url: direct.htmlUrl
    })
    recordFeedbackHistory({
      id: `gh-${direct.number ?? Date.now()}`,
      title: preview.title,
      number: direct.number,
      htmlUrl: direct.htmlUrl,
      via: 'builtin',
      submittedAt: new Date().toISOString()
    })
  } else {
    logWarn('Bug report failed', { error: direct.error })
  }
  return direct
}
