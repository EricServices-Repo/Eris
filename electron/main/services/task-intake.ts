import { isPathInside } from './workspace-fs'
import { createHash, randomUUID } from 'crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'fs'
import { basename, join, relative } from 'path'
import type { IntentResolution, TaskContract } from '../../../src/shared/task-contract'
import { forbidsMutation, interpretRequest } from '../../../src/shared/task-interpretation'
import type { TurnPlan } from '../../../src/shared/settings-schema'
import { namedProjectTarget } from './agent/project-target'

const skip = new Set([
  'node_modules',
  'vendor',
  'dist',
  'out',
  'build',
  'target',
  '__pycache__',
  '.git',
  '.eris'
])
const identity = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
export function projectRegistry(
  root: string
): Array<{ root: string; name: string; aliases: string[] }> {
  const projects: Array<{ root: string; name: string; aliases: string[] }> = []
  let visited = 0
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  function visit(path: string, depth: number) {
    if (visited++ >= 250 || depth > 4) return
    let entries: string[]
    try {
      entries = readdirSync(path)
    } catch {
      return
    }
    const markers = [
      'package.json',
      'composer.json',
      'pyproject.toml',
      'Cargo.toml',
      'go.mod',
      'index.php',
      'index.html'
    ]
    const aliases = [basename(path)]
    for (const manifest of ['package.json', 'composer.json']) {
      try {
        const data = JSON.parse(readFileSync(join(path, manifest), 'utf8'))
        if (typeof data.name === 'string') aliases.push(data.name)
      } catch {
        /* optional identity */
      }
    }
    for (const entry of ['index.html', 'index.php']) {
      try {
        const title = readFileSync(join(path, entry), 'utf8')
          .slice(0, 8000)
          .match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
        if (title) aliases.push(title.trim())
      } catch {
        /* optional title */
      }
    }
    if (depth === 0 || markers.some((marker) => entries.includes(marker))) {
      projects.push({ root: path, name: aliases.at(-1)!, aliases })
    }
    for (const entry of entries) {
      if (visited + queue.length >= 250) break
      if (skip.has(entry) || entry.startsWith('.')) continue
      const child = join(path, entry)
      try {
        const stat = lstatSync(child)
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          // Named folders remain discoverable even when their manifest is deeper.
          if (depth < 3 && !projects.some((project) => project.root === child))
            projects.push({ root: child, name: entry, aliases: [entry] })
          if (depth < 4) queue.push({ path: child, depth: depth + 1 })
        }
      } catch {
        /* unavailable child */
      }
    }
  }
  while (queue.length && visited < 250) {
    const next = queue.shift()!
    visit(next.path, next.depth)
  }
  const merged = new Map<string, { root: string; name: string; aliases: string[] }>()
  for (const project of projects) {
    const prior = merged.get(project.root)
    merged.set(project.root, {
      ...project,
      aliases: [...new Set([...(prior?.aliases ?? []), ...project.aliases])]
    })
  }
  return [...merged.values()]
}

export function createTaskContract(input: {
  taskId?: string
  threadId?: string | null
  workspacePath: string | null
  text: string
  plan: TurnPlan
  skillIds?: string[]
  priorTask?: TaskContract
  history?: Array<{ role: string; content: string }>
  resolution?: IntentResolution
}): TaskContract {
  const root =
    input.workspacePath && existsSync(input.workspacePath)
      ? realpathSync(input.workspacePath)
      : null
  const explicit = namedProjectTarget(input.text)
  // An implementation follow-up stays bound to the project named in the prior request.
  const priorUser = [...(input.history ?? [])].reverse().find((message) => message.role === 'user')
  const target =
    explicit ??
    (/\b(those|these|them|that|continue)\b/i.test(input.text) && priorUser
      ? namedProjectTarget(priorUser.content)
      : null)
  const registry = root && target ? projectRegistry(root) : []
  const matches = target
    ? registry.filter((project) =>
        project.aliases.some((alias) => identity(alias).includes(identity(target)))
      )
    : []
  const matchedRoots = matches.filter(
    (project) =>
      !matches.some(
        (other) => other.root !== project.root && project.root.startsWith(other.root + '/')
      )
  )
  const continuation = /\b(those|these|them|that|continue)\b/i.test(input.text)
  const priorScope = input.priorTask?.scope
  const inheritedRoot =
    continuation &&
    !/\b(?:new|another)\s+(?:app|application|website|project)\b/i.test(input.text) &&
    !explicit &&
    priorScope?.workspaceRoot === root &&
    priorScope.state === 'resolved' &&
    !!root &&
    !!priorScope.projectRoot &&
    isPathInside(root, priorScope.projectRoot) &&
    existsSync(priorScope.projectRoot)
      ? priorScope.projectRoot
      : null
  const selected =
    inheritedRoot ?? (target ? (matchedRoots.length === 1 ? matchedRoots[0]!.root : null) : root)
  const priorAnswer = [...(input.history ?? [])]
    .reverse()
    .find((message) => message.role === 'assistant')
  const recommendations =
    /\b(those|these|them|recommended|suggested)\b/i.test(input.text) && priorAnswer
      ? priorAnswer.content
          .split(/\n(?=\s*\d+[.)]\s)/)
          .filter((line) => /^\s*\d+[.)]\s/.test(line))
          .map((text) => ({
            id: createHash('sha256')
              .update(priorAnswer.content + text)
              .digest('hex')
              .slice(0, 16),
            text,
            source: createHash('sha256').update(priorAnswer.content).digest('hex').slice(0, 16)
          }))
      : []
  // An explicit “do not edit / do not run” is a constraint, whatever the route says.
  const forbids = forbidsMutation(input.text)
  const policy =
    (input.plan.mode === 'ask' || forbids) && input.plan.toolPolicy !== 'none'
      ? 'read'
      : input.plan.toolPolicy
  const canEdit = policy === 'edit' || policy === 'full'
  const deliverable = feasibleDeliverable(
    input.plan.intent === 'edit'
      ? input.plan.mode === 'ask'
        ? 'answer'
        : 'patch'
      : input.plan.intent === 'run' || input.plan.intent === 'verify'
        ? 'execution-report'
        : input.plan.intent === 'review'
          ? 'review'
          : input.plan.intent === 'plan'
            ? 'plan'
            : 'answer',
    canEdit
  )
  const interpretation = {
    ...interpretRequest({
      text: input.text,
      intent: input.plan.intent,
      canEdit,
      revision: 1,
      route: input.plan.routeTrace
    }),
    ...(input.resolution ? { resolution: input.resolution } : {})
  }
  return {
    version: 2,
    taskId: input.taskId ?? randomUUID(),
    revision: 1,
    threadId: input.threadId ?? null,
    originalText: input.text,
    intent: input.plan.intent,
    deliverable,
    scope: {
      workspaceRoot: root,
      projectRoot: selected,
      projectId: selected ? createHash('sha256').update(selected).digest('hex').slice(0, 16) : null,
      state: selected ? 'resolved' : matches.length > 1 ? 'ambiguous' : 'missing',
      candidates: (selected ? [] : registry)
        .map((project) => (root ? relative(root, project.root) || '.' : project.name))
        .slice(0, 30)
    },
    authority: {
      tools: policy,
      edit: canEdit,
      execute:
        policy === 'full'
          ? 'approved'
          : policy !== 'none' &&
              !forbids &&
              ['edit', 'review', 'verify'].includes(input.plan.intent) &&
              input.plan.mode !== 'ask'
            ? 'verification'
            : 'none',
      externalEffects: policy === 'full'
    },
    skillIds: input.skillIds ?? input.priorTask?.skillIds,
    recommendations,
    acceptanceCriteria: acceptanceCriteriaFor(input.plan, deliverable, input.text, interpretation),
    interpretation
  }
}

/** A patch the authority cannot write becomes a described change in chat. */
function feasibleDeliverable(
  deliverable: TaskContract['deliverable'],
  canEdit: boolean
): TaskContract['deliverable'] {
  return deliverable === 'patch' && !canEdit ? 'answer' : deliverable
}

/**
 * Acceptance follows the deliverable the authority can produce. A mutation plan's
 * completion rule never applies to an answer that cannot edit or run anything.
 */
function acceptanceCriteriaFor(
  plan: TurnPlan,
  deliverable: TaskContract['deliverable'],
  fallback: string,
  interpretation: NonNullable<TaskContract['interpretation']>
): string[] {
  const base =
    deliverable === 'answer' && (plan.intent === 'edit' || plan.intent === 'run')
      ? 'The requested change is described or shown in chat without claiming it was applied or verified.'
      : (plan.executionPlan?.doneWhen ?? fallback)
  // Each obligation is checked on its own; one satisfied part never completes the task.
  return [...new Set([base, ...interpretation.obligations.map((obligation) => obligation.text)])]
}

export function childTaskContract(
  parent: TaskContract,
  plan: TurnPlan,
  goal: string,
  workspacePath: string,
  taskId: string
): TaskContract {
  const levels = ['none', 'read', 'edit', 'full'] as const
  const tools =
    levels[Math.min(levels.indexOf(parent.authority.tools), levels.indexOf(plan.toolPolicy))]!
  const edit = parent.authority.edit && ['edit', 'full'].includes(tools)
  const deliverable = feasibleDeliverable(
    plan.intent === 'edit'
      ? 'patch'
      : plan.intent === 'review'
        ? 'review'
        : plan.intent === 'plan'
          ? 'plan'
          : plan.intent === 'run' || plan.intent === 'verify'
            ? 'execution-report'
            : 'answer',
    edit
  )
  const interpretation = interpretRequest({
    text: goal,
    intent: plan.intent,
    canEdit: edit,
    revision: parent.revision,
    route: plan.routeTrace
  })
  const root = realpathSync(workspacePath)
  const relativeProject =
    parent.scope.workspaceRoot && parent.scope.projectRoot
      ? relative(parent.scope.workspaceRoot, parent.scope.projectRoot)
      : ''
  const projectRoot = relativeProject ? join(root, relativeProject) : root
  if (!isPathInside(root, projectRoot))
    throw new Error('The inherited project scope escapes its workspace.')
  return {
    ...parent,
    taskId,
    parentTaskId: parent.taskId,
    originalText: goal,
    intent: plan.intent,
    deliverable,
    scope: { ...parent.scope, workspaceRoot: root, projectRoot },
    authority: {
      tools,
      edit,
      execute:
        parent.authority.execute === 'none' || tools === 'none'
          ? 'none'
          : tools === 'full'
            ? parent.authority.execute
            : ['review', 'verify', 'edit'].includes(plan.intent)
              ? 'verification'
              : 'none',
      externalEffects: parent.authority.externalEffects && tools === 'full'
    },
    acceptanceCriteria: acceptanceCriteriaFor(plan, deliverable, goal, interpretation),
    interpretation
  }
}
