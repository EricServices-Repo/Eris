import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  EvalTaskSchema,
  type EvalTask,
  type EvalTaskInfo,
  type RejectedEvalTask
} from '../../../src/shared/evals'
import { appResourcePath, workspaceConfigDir } from './paths'

export function builtinEvalTasks(): EvalTask[] {
  try {
    const raw = JSON.parse(readFileSync(appResourcePath('evals/builtin.json'), 'utf8')) as unknown
    return parseTaskList(raw, 'builtin').tasks
  } catch {
    return []
  }
}

/** Workspace eval tasks plus every definition kept out of the run list and why. */
export function loadWorkspaceEvalTasks(workspacePath: string | null): {
  tasks: EvalTask[]
  rejected: RejectedEvalTask[]
} {
  if (!workspacePath) return { tasks: [], rejected: [] }
  const dir = join(workspaceConfigDir(workspacePath), 'evals')
  const file = join(workspaceConfigDir(workspacePath), 'evals.json')
  const tasks: EvalTask[] = []
  const rejected: RejectedEvalTask[] = []
  const load = (path: string, label: string) => {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      rejected.push({ file: label, error: err instanceof Error ? err.message : String(err) })
      return
    }
    const parsed = parseTaskList(raw, 'workspace')
    tasks.push(...parsed.tasks)
    rejected.push(...parsed.rejected.map((item) => ({ ...item, file: label })))
  }
  if (existsSync(file)) load(file, '.eris/evals.json')
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      load(join(dir, name), `.eris/evals/${name}`)
    }
  }
  return { tasks, rejected }
}

export function workspaceEvalTasks(workspacePath: string | null): EvalTask[] {
  return loadWorkspaceEvalTasks(workspacePath).tasks
}

export function listRejectedEvalTasks(workspacePath: string | null): RejectedEvalTask[] {
  return loadWorkspaceEvalTasks(workspacePath).rejected
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

function parseTaskList(
  raw: unknown,
  _source: 'builtin' | 'workspace'
): { tasks: EvalTask[]; rejected: Array<Omit<RejectedEvalTask, 'file'>> } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && 'tasks' in raw
    ? (raw as { tasks: unknown }).tasks
    : []
  if (!Array.isArray(list)) return { tasks: [], rejected: [] }
  const tasks: EvalTask[] = []
  const rejected: Array<Omit<RejectedEvalTask, 'file'>> = []
  for (const item of list) {
    const parsed = EvalTaskSchema.safeParse({
      mode: 'agent',
      timeoutMs: 300_000,
      files: {},
      ...(item as object)
    })
    if (parsed.success) tasks.push(parsed.data)
    else {
      const id = item && typeof item === 'object' && 'id' in item ? String(item.id) : undefined
      rejected.push({
        ...(id ? { id } : {}),
        error: parsed.error.issues
          .slice(0, 3)
          .map((issue) => {
            // Zod 4 wraps record-key validation failures; keep the sandbox reason visible.
            const details = issue.code === 'invalid_key'
              ? issue.issues.slice(0, 3).map((nested) => nested.message).join('; ')
              : ''
            return `${issue.path.join('.') || 'task'}: ${issue.message}${details ? `: ${details}` : ''}`
          })
          .join('; ')
      })
    }
  }
  return { tasks, rejected }
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
