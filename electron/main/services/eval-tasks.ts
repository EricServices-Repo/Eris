import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { EvalTaskSchema, type EvalTask, type EvalTaskInfo } from '../../../src/shared/evals'
import { appResourcePath, workspaceConfigDir } from './paths'

export function builtinEvalTasks(): EvalTask[] {
  try {
    const raw = JSON.parse(readFileSync(appResourcePath('evals/builtin.json'), 'utf8')) as unknown
    return parseTaskList(raw, 'builtin')
  } catch {
    return []
  }
}

export function workspaceEvalTasks(workspacePath: string | null): EvalTask[] {
  if (!workspacePath) return []
  const dir = join(workspaceConfigDir(workspacePath), 'evals')
  const file = join(workspaceConfigDir(workspacePath), 'evals.json')
  const out: EvalTask[] = []
  if (existsSync(file)) {
    try {
      out.push(...parseTaskList(JSON.parse(readFileSync(file, 'utf8')), 'workspace'))
    } catch {
      // skip
    }
  }
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        out.push(...parseTaskList(JSON.parse(readFileSync(join(dir, name), 'utf8')), 'workspace'))
      } catch {
        // skip
      }
    }
  }
  return out
}

export function listEvalTaskInfo(workspacePath: string | null): EvalTaskInfo[] {
  return [
    ...builtinEvalTasks().map((t) => toInfo(t, 'builtin')),
    ...workspaceEvalTasks(workspacePath).map((t) => toInfo(t, 'workspace'))
  ]
}

export function findEvalTask(workspacePath: string | null, id: string): EvalTask | null {
  return (
    workspaceEvalTasks(workspacePath).find((t) => t.id === id) ||
    builtinEvalTasks().find((t) => t.id === id) ||
    null
  )
}

export function saveWorkspaceEvalTasks(workspacePath: string, tasks: EvalTask[]): void {
  const dir = workspaceConfigDir(workspacePath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'evals.json'), JSON.stringify(tasks, null, 2), 'utf8')
}

function parseTaskList(raw: unknown, _source: 'builtin' | 'workspace'): EvalTask[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && 'tasks' in raw
    ? (raw as { tasks: unknown }).tasks
    : []
  if (!Array.isArray(list)) return []
  const out: EvalTask[] = []
  for (const item of list) {
    const parsed = EvalTaskSchema.safeParse({
      mode: 'agent',
      timeoutMs: 300_000,
      files: {},
      ...(item as object)
    })
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

function toInfo(task: EvalTask, source: 'builtin' | 'workspace'): EvalTaskInfo {
  return {
    id: task.id,
    title: task.title,
    intent: task.intent,
    source,
    checks: task.checks.length
  }
}

export function taskSourceLabel(id: string, workspacePath: string | null): 'builtin' | 'workspace' {
  if (workspaceEvalTasks(workspacePath).some((t) => t.id === id)) return 'workspace'
  return 'builtin'
}
