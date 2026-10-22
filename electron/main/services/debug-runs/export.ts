import {
  DEBUG_RUN_ARTIFACT_VERSION,
  type DebugCaseResult,
  type DebugExportPreview,
  type DebugRecordedResponse,
  type DebugRunDetail,
  type DebugRunSummary
} from '../../../../src/shared/debug-runs'
import { redactDiagnostic } from './redact'

export interface DebugRunExport {
  artifactVersion: typeof DEBUG_RUN_ARTIFACT_VERSION
  exportedAt: string
  label: string
  includes: { responses: boolean }
  summary: DebugRunSummary
  cases: DebugCaseResult[]
  responses?: DebugRecordedResponse[]
}

function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactDiagnostic(value, null, Number.MAX_SAFE_INTEGER) as T
  if (Array.isArray(value)) return value.map(redactDeep) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDeep(item)])
    ) as T
  return value
}

/**
 * Redacted bundle for sharing. Model replies and final answers are included
 * only on explicit request; file contents are never part of case results.
 */
export function buildDebugRunExport(
  detail: DebugRunDetail,
  includeResponses: boolean
): DebugRunExport {
  return redactDeep({
    artifactVersion: DEBUG_RUN_ARTIFACT_VERSION,
    exportedAt: new Date().toISOString(),
    label: detail.summary.label,
    includes: { responses: includeResponses },
    summary: detail.summary,
    cases: detail.cases,
    ...(includeResponses ? { responses: detail.responses } : {})
  })
}

export function previewDebugRunExport(
  detail: DebugRunDetail,
  includeResponses: boolean
): DebugExportPreview {
  const bundle = buildDebugRunExport(detail, includeResponses)
  return {
    label: detail.summary.label,
    cases: detail.cases.length,
    responses: includeResponses ? detail.responses.length : 0,
    includesResponses: includeResponses,
    bytes: Buffer.byteLength(JSON.stringify(bundle)),
    contents: [
      'Run summary: mode label, model ref, counts, failure categories, app version, limitations',
      'Per-case route, task contract, oracle checks, changed paths, prompt/reply hashes, timeline',
      'Credentials and home-directory paths redacted; file contents are not stored',
      includeResponses
        ? 'Model replies and final answers (raw text, redacted)'
        : 'Model replies and final answers: not included'
    ]
  }
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Human-readable report; the mode label is always first so results are never misread. */
export function renderDebugRunMarkdown(detail: DebugRunDetail): string {
  const { summary, cases } = detail
  const lines = [
    `# Eris diagnostics run — ${summary.label}`,
    '',
    `- Verdict: **${summary.verdict ?? 'RUNNING'}** (${summary.status})`,
    `- Run: \`${summary.runId}\`${summary.replayOf ? ` · replay of \`${summary.replayOf}\`` : ''}`,
    `- Model: \`${summary.model.ref}\` · adapter ${summary.model.adapter} · provider ${summary.model.provider}`,
    `- Cases: ${summary.passed} passed · ${summary.failed} failed · ${summary.timedOut} timed out · ${summary.cancelled} cancelled · ${summary.errored} errors · ${summary.completed}/${summary.planned} run`,
    `- Pipeline: ${summary.pipeline}`,
    `- App ${summary.app.version} · ${summary.app.platform}/${summary.app.arch} · started ${summary.startedAt}${summary.durationMs !== undefined ? ` · ${summary.durationMs} ms` : ''}`,
    ...(summary.error ? [`- Error: ${summary.error}`] : []),
    '',
    '## What this run can and cannot establish',
    '',
    ...summary.limitations.map((item) => `- ${item}`),
    '',
    '## Cases',
    '',
    '| # | Scenario | Status | Expected intent | Routed | Failure | Changed | ms |',
    '| ---: | --- | --- | --- | --- | --- | --- | ---: |',
    ...cases.map(
      (item) =>
        `| ${item.index + 1} | ${cell(item.scenarioId)} | ${item.status} | ${cell(item.route?.expectedIntents.join(' / ') || '—')} | ${cell(item.route ? `${item.route.intent} · ${item.route.agentId}` : '—')} | ${cell(item.failure ? `${item.failure.stage} / ${item.failure.category}` : '—')} | ${cell(item.changedPaths.join(', ') || '—')} | ${item.durationMs} |`
    ),
    ''
  ]
  const failures = cases.filter((item) => item.status !== 'passed')
  if (failures.length) lines.push('## Failures', '')
  for (const item of failures) {
    lines.push(
      `### ${item.caseId} — ${item.scenarioTitle}`,
      '',
      `- Status: ${item.status}${item.failure ? ` · ${item.failure.stage} / ${item.failure.category}` : ''}`,
      ...(item.failure ? [`- Detail: ${item.failure.detail}`] : []),
      `- Terminal: ${item.terminal ?? 'none'} · steps ${item.steps} · tools ${item.toolCalls} (${item.toolErrors} errors)`,
      ...item.checks
        .filter((check) => !check.ok)
        .map(
          (check) =>
            `- Failed check [${check.stage}] ${check.name}: expected ${check.expected}; actual ${check.actual}`
        ),
      ...item.warnings.map((warning) => `- Warning: ${warning}`),
      '',
      '```text',
      ...item.timeline.map(
        (event) => `${String(event.atMs).padStart(6)}ms ${event.kind.padEnd(14)} ${event.summary}`
      ),
      ...(item.timelineTruncated ? ['… timeline truncated'] : []),
      '```',
      ''
    )
  }
  return lines.join('\n')
}
