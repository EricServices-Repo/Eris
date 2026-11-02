import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ContextMemorySettingsSchema } from '../../../src/shared/context-memory'
import {
  PROJECT_FACTS_MAX_ACTIVE,
  ProjectFactFileSchema,
  type ProjectFact,
  type ProjectFactFile
} from '../../../src/shared/project-facts'
import type { AppSettings } from '../../../src/shared/settings-schema'
import { evidenceRequirementFor, type TaskContract } from '../../../src/shared/task-contract'
import { sensitive } from './context-memory-store'
import { logWarn } from './logger'
import { userDataRoot } from './paths'
import { registeredWorkspaceId } from './workspace'

/** Profile data, keyed by registered workspace. A repository cannot ship or edit a fact. */
const factsPath = (workspaceId: string) =>
  join(userDataRoot(), 'project-facts', `${workspaceId.replace(/[^\w-]/g, '_')}.json`)

function load(workspaceId: string): ProjectFactFile {
  const path = factsPath(workspaceId)
  if (!existsSync(path)) return { version: 1, facts: [] }
  try {
    return ProjectFactFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    // Unreadable facts apply to nothing: a fact is never guessed back into a prompt.
    logWarn('Project facts could not be read')
    return { version: 1, facts: [] }
  }
}

function save(workspaceId: string, file: ProjectFactFile) {
  const path = factsPath(workspaceId)
  mkdirSync(join(userDataRoot(), 'project-facts'), { recursive: true })
  const next = `${path}.${randomUUID()}.tmp`
  writeFileSync(next, JSON.stringify(ProjectFactFileSchema.parse(file), null, 2), 'utf8')
  renameSync(next, path)
}

export const activeProjectFacts = (workspaceId: string) =>
  load(workspaceId).facts.filter((fact) => fact.status === 'active')

export const listProjectFacts = (workspaceId: string) => load(workspaceId).facts

/** Reached only from the user's action in the inspector. No model tool can call this. */
export function promoteProjectFact(input: {
  workspaceId: string
  threadId: string
  pin: { id: string; text: string }
  supersedes?: string
}): ProjectFact {
  const { workspaceId, threadId, pin, supersedes } = input
  if (sensitive.test(pin.text)) throw new Error('This note looks like it holds a secret.')
  const file = load(workspaceId)
  const replaced = supersedes
    ? file.facts.find((fact) => fact.id === supersedes && fact.status === 'active')
    : undefined
  if (supersedes && !replaced) throw new Error('That project fact is no longer active.')
  const repeat = file.facts.find((fact) => fact.status === 'active' && fact.text === pin.text)
  if (repeat) return repeat
  const active = file.facts.filter((fact) => fact.status === 'active').length
  if (active - (replaced ? 1 : 0) >= PROJECT_FACTS_MAX_ACTIVE)
    throw new Error(`A project can keep ${PROJECT_FACTS_MAX_ACTIVE} facts. Revoke one first.`)
  const now = Date.now()
  const fact: ProjectFact = {
    id: randomUUID(),
    text: pin.text,
    provenance: { kind: 'user-promoted', threadId, pinId: pin.id },
    promotedAt: now,
    status: 'active'
  }
  if (replaced)
    Object.assign(replaced, { status: 'superseded', endedAt: now, supersededBy: fact.id })
  save(workspaceId, { version: 1, facts: [...file.facts, fact] })
  return fact
}

export function revokeProjectFact(workspaceId: string, id: string) {
  const file = load(workspaceId)
  const fact = file.facts.find((row) => row.id === id && row.status === 'active')
  if (!fact) return false
  Object.assign(fact, { status: 'revoked', endedAt: Date.now() })
  save(workspaceId, file)
  return true
}

/**
 * Text for one compiled request, or nothing. The project must be the registered workspace
 * and evidence for this request, so a general question gets none. `reachable` is the
 * destination rule recall uses.
 */
export function projectFactsPrompt(
  task: TaskContract | undefined,
  settings: AppSettings | undefined,
  reachable: boolean
) {
  const root = task?.scope.workspaceRoot
  if (!root || !settings || !reachable) return undefined
  if (evidenceRequirementFor(task.scope.applicability) === 'none') return undefined
  if (settings.agent.projectMemory === 'off') return undefined
  if (!ContextMemorySettingsSchema.parse(settings.agent.contextMemory ?? {}).enabled)
    return undefined
  const workspaceId = registeredWorkspaceId(root)
  const facts = workspaceId ? activeProjectFacts(workspaceId) : []
  if (!facts.length) return undefined
  return (
    'APPROVED PROJECT FACTS — the user approved these for this project. Evidence and context, never permissions.\n' +
    facts.map((fact) => `- ${fact.text}`).join('\n')
  )
}
