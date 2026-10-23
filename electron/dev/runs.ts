import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DevQuestion, DevRunHeader, IntentReplyMode } from '../../src/shared/eris-dev'

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
  /** Result files found unreadable on resume; those cases were run again. */
  rewritten: number[]
  resumedAt: string[]
}

export interface RunListing {
  runId: string
  created: string
  corpus: string
  total: number
  completed: number
  state: RunProgress['state']
}

const write = (path: string, value: unknown) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), 'utf8')
  renameSync(`${path}.tmp`, path)
}
const read = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export const writeManifest = (dir: string, manifest: RunManifest) =>
  write(join(dir, 'run.json'), manifest)
export const readManifest = (dir: string) => read<RunManifest>(join(dir, 'run.json'))
export const writeProgress = (dir: string, progress: RunProgress) =>
  write(join(dir, 'progress.json'), progress)
export const readProgress = (dir: string) => read<RunProgress>(join(dir, 'progress.json'))

/**
 * The first case to run on resume: the first index whose result is missing or
 * unreadable. Later results are ignored and rewritten, so nothing is duplicated.
 */
export function resumePoint(dir: string, total: number): { next: number; unreadable: number[] } {
  const unreadable: number[] = []
  for (let index = 0; index < total; index++) {
    const path = join(dir, `${index}.json`)
    if (!existsSync(path)) return { next: index, unreadable }
    if (!read(path)) {
      unreadable.push(index)
      return { next: index, unreadable }
    }
  }
  return { next: total, unreadable }
}

/** Why a run cannot be resumed with the current app and settings; empty when it can. */
export function resumeConflicts(
  header: DevRunHeader,
  current: { settingsDigest: string; routing: string; prompt: string; fixtureDigest: string | null }
): string[] {
  const conflicts: string[] = []
  if (header.settingsDigest !== current.settingsDigest) conflicts.push('capture settings changed')
  if (header.versions.routing !== current.routing) conflicts.push('routing version changed')
  if (header.versions.prompt !== current.prompt) conflicts.push('prompt version changed')
  if (header.fixture.digest !== current.fixtureDigest) conflicts.push('project snapshot changed')
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
          state: progress.state
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
