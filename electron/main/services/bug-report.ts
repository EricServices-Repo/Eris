import { app, clipboard, shell } from 'electron'
import { homedir, platform, release, arch, cpus, totalmem } from 'os'
import { redactBugReportText } from '../../../src/shared/bug-report-sanitize'
import { createGithubIssue, normalizeHost } from './github'
import { getLogsInfo, logInfo, logWarn, readLogFile } from './logger'
import { getResolvedSettings } from './settings'
import { getSecret } from '../ipc/shared'
import { appState } from '../app-state'

/** Public issues inbox — any authenticated GitHub user can file here. */
export const ERIS_FEEDBACK_OWNER = 'EricServices-Repo'
export const ERIS_FEEDBACK_REPO = 'Eris-feedback'
export const ERIS_FEEDBACK_ISSUES_URL = `https://github.com/${ERIS_FEEDBACK_OWNER}/${ERIS_FEEDBACK_REPO}/issues`

const MAX_LOG_CHARS = 48_000
const MAX_ISSUE_BODY = 55_000

export interface BugReportInput {
  title: string
  description: string
  includeLogs?: boolean
  includeDiagnostics?: boolean
  /** When true and API fails / no token, open browser + copy body */
  openBrowserFallback?: boolean
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
  hasGithubToken: boolean
  targetRepo: string
}

export interface BugReportResult {
  ok: boolean
  error?: string
  number?: number
  htmlUrl?: string
  openedBrowser?: boolean
  copiedToClipboard?: boolean
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
    totalMemGb: Math.round((totalmem() / (1024 ** 3)) * 10) / 10,
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
    '\n\n---\n_(Issue body truncated to fit GitHub limits. Full logs are on the reporter’s machine.)_\n'
  )
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

  const settings = getResolvedSettings(appState.currentWorkspace)
  const hasGithubToken = Boolean(
    settings.github?.tokenRef && getSecret(settings.github.tokenRef)
  )

  return {
    title: title.slice(0, 200),
    body: trimBody(parts.join('\n')),
    diagnostics,
    logIncluded: includeLogs,
    logTruncated,
    logPath,
    hasGithubToken,
    targetRepo: `${ERIS_FEEDBACK_OWNER}/${ERIS_FEEDBACK_REPO}`
  }
}

export async function submitBugReport(input: BugReportInput): Promise<BugReportResult> {
  const preview = buildBugReportPreview(input)
  const settings = getResolvedSettings(appState.currentWorkspace)
  const tokenRef = settings.github?.tokenRef || ''
  const token = tokenRef ? getSecret(tokenRef) : null
  const host = normalizeHost(settings.github?.host || 'github.com')
  const openBrowserFallback = input.openBrowserFallback !== false

  logInfo('Bug report submit started', {
    hasToken: Boolean(token),
    includeLogs: preview.logIncluded,
    titleLen: preview.title.length,
    bodyLen: preview.body.length
  })

  if (token) {
    const created = await createGithubIssue({
      host,
      token,
      owner: ERIS_FEEDBACK_OWNER,
      repo: ERIS_FEEDBACK_REPO,
      title: preview.title,
      body: preview.body,
      labels: ['bug', 'from-client', 'needs-triage']
    })
    if (created.ok && created.htmlUrl) {
      logInfo('Bug report created', { number: created.number, url: created.htmlUrl })
      try {
        await shell.openExternal(created.htmlUrl)
      } catch {
        // ignore
      }
      return {
        ok: true,
        number: created.number,
        htmlUrl: created.htmlUrl
      }
    }
    logWarn('Bug report API failed', { error: created.error })
    if (!openBrowserFallback) {
      return { ok: false, error: created.error || 'Could not create GitHub issue' }
    }
    // fall through to browser + clipboard
    const fallback = await openBugReportFallback(preview, created.error)
    return {
      ok: false,
      error: created.error || 'Could not create GitHub issue',
      ...fallback
    }
  }

  if (!openBrowserFallback) {
    return {
      ok: false,
      error:
        'Add a GitHub personal access token under Settings → GitHub (needs permission to create issues on EricServices-Repo/Eris-feedback).'
    }
  }

  const fallback = await openBugReportFallback(
    preview,
    'No GitHub token configured in Settings → GitHub.'
  )
  return {
    ok: false,
    error:
      'No GitHub token in Settings → GitHub. Opened a draft in the browser and copied the full report to your clipboard.',
    ...fallback
  }
}

async function openBugReportFallback(
  preview: BugReportPreview,
  reason?: string
): Promise<{ openedBrowser: boolean; copiedToClipboard: boolean }> {
  let copiedToClipboard = false
  try {
    clipboard.writeText(preview.body)
    copiedToClipboard = true
  } catch {
    // ignore
  }

  const shortBody = [
    preview.body.slice(0, 2800),
    '',
    '---',
    '_(Full report with logs was copied to your clipboard — paste below if truncated.)_',
    reason ? `_Client note: ${reason}_` : ''
  ]
    .filter(Boolean)
    .join('\n')

  const url =
    `${ERIS_FEEDBACK_ISSUES_URL}/new?` +
    `title=${encodeURIComponent(preview.title)}&` +
    `body=${encodeURIComponent(shortBody)}&` +
    `labels=${encodeURIComponent('bug,from-client,needs-triage')}`

  let openedBrowser = false
  try {
    await shell.openExternal(url)
    openedBrowser = true
  } catch (err) {
    logWarn('Bug report browser open failed', {
      error: err instanceof Error ? err.message : String(err)
    })
  }

  return { openedBrowser, copiedToClipboard }
}
