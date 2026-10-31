import { atomicEvidenceJson, readEvidence } from '../main/services/evidence-records'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type {
  DevQuestion,
  DevRunHeader,
  IntentReplyMode,
  DevLiveConfig
} from '../../src/shared/eris-dev'

/**
 * Durable run state so a long capture can resume. The manifest is written once
 * (header, questions, configuration); progress is small and rewritten per case.
 * A run that was still "running" when the app started was interrupted.
 */
export interface RunManifest {
  runId: string
  header: DevRunHeader
  questions: DevQuestion[]
  config: {
    memoryMode?: import('../../src/shared/dev-memory-replay').DevMemoryMode
    memoryAlternateModel?: string
    memoryEpisodeSize?: number
    memoryShareRemote?: boolean
    live?: DevLiveConfig
    context: number
    mode: 'ask' | 'agent'
    intentReplyMode: IntentReplyMode
    projectKind: 'sample' | 'none' | 'project'
    project: string | null
  }
}

export interface RunProgress {
  state: 'running' | 'completed' | 'stopped' | 'interrupted'
  completed: number
  updatedAt: string
  /** Result files found unreadable or invalid on resume; those cases were run again. */
  rewritten: number[]
  /** Why each rewritten case was rejected. */
  invalid?: Array<{ index: number; reason: string }>
  /** Attempts stopped mid-question, kept as `<index>.attempt-<n>.json`. */
  interruptedAttempts?: string[]
  resumedAt: string[]
}

export interface RunListing {
  runId: string
  created: string
  corpus: string
  total: number
  completed: number
  state: RunProgress['state']
  /** Source revision and configuration, so a run can be chosen without opening it. */
  gitSha?: string
  mode?: 'ask' | 'agent'
  context?: number
  fixture?: string
  bytes?: number
}

const write = (path: string, value: unknown) => atomicEvidenceJson(path, value)
const read = <T>(path: string): T | null =>
  readEvidence(
    path,
    (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid evidence object')
      return value as T
    },
    32_000_000
  )

export const writeManifest = (dir: string, manifest: RunManifest) =>
  write(join(dir, 'run.json'), manifest)
const ManifestSchema = z
  .object({
    runId: z.string().uuid(),
    header: z
      .object({ created: z.string(), corpus: z.object({ name: z.string() }).passthrough() })
      .passthrough(),
    questions: z.array(z.object({ id: z.string(), text: z.string() }).passthrough()).max(10000),
    config: z
      .object({
        memoryMode: z.enum(['independent', 'stateful', 'pressure']).optional(),
        memoryAlternateModel: z.string().min(1).max(2048).optional(),
        memoryEpisodeSize: z.number().int().min(2).max(10000).optional(),
        memoryShareRemote: z.boolean().optional(),
        context: z.number().positive(),
        mode: z.enum(['ask', 'agent']),
        intentReplyMode: z.enum(['fallback', 'malformed', 'timeout']),
        projectKind: z.enum(['sample', 'none', 'project']),
        project: z.string().nullable()
      })
      .passthrough()
  })
  .passthrough()
export const readManifest = (dir: string) =>
  readEvidence(
    join(dir, 'run.json'),
    (value) => ManifestSchema.parse(value) as unknown as RunManifest,
    32_000_000
  )
export const writeProgress = (dir: string, progress: RunProgress) =>
  write(join(dir, 'progress.json'), progress)
export const readProgress = (dir: string) =>
  readEvidence(
    join(dir, 'progress.json'),
    (value) =>
      z
        .object({
          state: z.enum(['running', 'completed', 'stopped', 'interrupted']),
          completed: z.number().int().nonnegative(),
          updatedAt: z.string(),
          rewritten: z.array(z.number().int().nonnegative()),
          resumedAt: z.array(z.string())
        })
        .passthrough()
        .parse(value) as unknown as RunProgress
  )

/** Terminal capture outcomes. A cancelled case was interrupted, not finished. */
const TERMINAL_STATUSES = new Set(['captured', 'blocked', 'error'])

/**
 * Why a persisted case record cannot count as completed evidence for this run, or
 * null when it can. Valid JSON is not enough: `{}` or another run's record is a gap.
 */
export function caseRecordProblem(
  value: unknown,
  index: number,
  question?: Pick<DevQuestion, 'id'>
): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not a record'
  const record = value as Record<string, unknown>
  if (record.index !== index) return `index ${String(record.index)} does not match case ${index}`
  if (typeof record.questionId !== 'string') return 'missing questionId'
  if (question && record.questionId !== question.id)
    return `question ${record.questionId} does not match ${question.id}`
  if (record.status === 'cancelled') return 'interrupted (cancelled) attempt'
  if (typeof record.status !== 'string' || !TERMINAL_STATUSES.has(record.status))
    return `unknown status ${String(record.status)}`
  for (const key of ['requests', 'findingsDetail', 'findingIds', 'events'] as const)
    if (!Array.isArray(record[key])) return `missing ${key}`
  for (const key of ['stages', 'findings', 'phases'] as const)
    if (!record[key] || typeof record[key] !== 'object') return `missing ${key}`
  if (typeof record.question !== 'string') return 'missing question text'
  return null
}

/**
 * The first case to run on resume: the first index whose result is missing,
 * unreadable, invalid for this run, or an interrupted attempt. Later results are
 * ignored and rewritten, so nothing is duplicated. Each gap is reported with its reason.
 */
export function resumePoint(
  dir: string,
  questions: Array<Pick<DevQuestion, 'id'>> | number
): { next: number; unreadable: number[]; invalid: Array<{ index: number; reason: string }> } {
  const total = typeof questions === 'number' ? questions : questions.length
  const unreadable: number[] = []
  const invalid: Array<{ index: number; reason: string }> = []
  for (let index = 0; index < total; index++) {
    const path = join(dir, `${index}.json`)
    if (!existsSync(path)) return { next: index, unreadable, invalid }
    const record = read<unknown>(path)
    if (!record) {
      unreadable.push(index)
      return { next: index, unreadable, invalid }
    }
    const problem = caseRecordProblem(
      record,
      index,
      typeof questions === 'number' ? undefined : questions[index]
    )
    if (problem) {
      invalid.push({ index, reason: problem })
      return { next: index, unreadable, invalid }
    }
  }
  return { next: total, unreadable, invalid }
}

/** Write one case atomically, so a crash never leaves a torn record that reads as complete. */
export function writeCaseRecord(dir: string, index: number, record: unknown): void {
  write(join(dir, `${index}.json`), record)
}

/** Keep an interrupted attempt beside the case, so a retry does not erase what happened. */
export function preserveAttempt(dir: string, index: number, record: unknown): string {
  let attempt = 1
  while (existsSync(join(dir, `${index}.attempt-${attempt}.json`))) attempt++
  const name = `${index}.attempt-${attempt}.json`
  write(join(dir, name), record)
  return name
}

/** Why a run cannot be resumed with the current app and settings; empty when it can. */
export function resumeConflicts(
  header: DevRunHeader,
  current: {
    settingsDigest: string
    routing: string
    prompt: string
    fixtureDigest: string | null
    /** Harness fingerprint (versions, schema and source revision); optional for older callers. */
    harness?: string
  }
): string[] {
  const conflicts: string[] = []
  if (header.settingsDigest !== current.settingsDigest) conflicts.push('capture settings changed')
  if (header.versions.routing !== current.routing) conflicts.push('routing version changed')
  if (header.versions.prompt !== current.prompt) conflicts.push('prompt version changed')
  if (header.fixture.digest !== current.fixtureDigest) conflicts.push('project snapshot changed')
  // A forgotten version bump cannot hide a changed harness: the fingerprint includes
  // the source revision. Runs recorded before fingerprints existed cannot prove a match.
  if (current.harness !== undefined) {
    if (!header.versions.harness) conflicts.push('run predates harness fingerprints')
    else if (header.versions.harness !== current.harness)
      conflicts.push('harness or source revision changed')
  }
  return conflicts
}

/** Mark runs left "running" by a previous process as interrupted. */
export function markInterruptedRuns(capturesDir: string): number {
  let marked = 0
  for (const runId of safeList(capturesDir)) {
    const dir = join(capturesDir, runId)
    const progress = readProgress(dir)
    if (progress?.state === 'running') {
      writeProgress(dir, { ...progress, state: 'interrupted', updatedAt: new Date().toISOString() })
      marked++
    }
  }
  return marked
}

export function listRuns(capturesDir: string): RunListing[] {
  return safeList(capturesDir)
    .flatMap((runId) => {
      const dir = join(capturesDir, runId)
      const manifest = readManifest(dir)
      const progress = readProgress(dir)
      if (!manifest || !progress) return []
      return [
        {
          runId,
          created: manifest.header.created,
          corpus: manifest.header.corpus.name,
          total: manifest.questions.length,
          completed: progress.completed,
          state: progress.state,
          gitSha: manifest.header.app?.gitSha,
          mode: manifest.config.mode,
          context: manifest.config.context,
          fixture: manifest.header.fixture?.kind,
          bytes: directoryBytes(dir)
        }
      ]
    })
    .sort((a, b) => b.created.localeCompare(a.created))
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => /^[0-9a-f-]{36}$/.test(name))
  } catch {
    return []
  }
}

/** Bytes on disk for a run's files; storage accounting shown in the run browser. */
export function directoryBytes(dir: string): number {
  let total = 0
  try {
    for (const name of readdirSync(dir)) {
      try {
        total += statSync(join(dir, name)).size
      } catch {
        /* removed while listing */
      }
    }
  } catch {
    return 0
  }
  return total
}
