import type { ResolvedReference } from './reference-binding'
import { isPathInside } from './workspace-fs'
import { createHash, randomUUID } from 'crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'fs'
import { basename, join, relative } from 'path'
import {
  extractRecommendations,
  pathsIn,
  selectRecommendations
} from '../../../src/shared/recommendations'
import {
  interpretationOf,
  type InheritedRequirements,
  type IntentResolution,
  type ProjectStack,
  type TaskRecommendation,
  type ScopeApplicability,
  type TaskContract,
  type TaskInterpretation
} from '../../../src/shared/task-contract'
import {
  effectConstraints,
  interpretRequest,
  namedLanguages,
  requestConstraints,
  requestTextForIntent,
  stackFit
} from '../../../src/shared/task-interpretation'
import {
  asksToLocateCode,
  asksWorkspaceQuestion,
  mentionsSourcePath
} from '../../../src/shared/agent-contract'
import type { TurnPlan } from '../../../src/shared/settings-schema'
import { namedProjectTarget } from './agent/project-target'
import { executionPlanFor } from './execution-plan'

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

/** Languages and frameworks named by the project's own manifests. Unknown is not a match. */
export function detectProjectStack(root: string | null): ProjectStack | null {
  if (!root) return null
  const languages = new Set<string>()
  const frameworks = new Set<string>()
  const read = (name: string) => {
    try {
      return readFileSync(join(root, name), 'utf8').slice(0, 200_000)
    } catch {
      return ''
    }
  }
  const pkg = read('package.json')
  if (pkg) {
    languages.add(
      existsSync(join(root, 'tsconfig.json')) || /"typescript"/.test(pkg)
        ? 'TypeScript'
        : 'JavaScript'
    )
    for (const [name, pattern] of [
      ['Next.js', /"next"\s*:/],
      ['React', /"react"\s*:/],
      ['Vue', /"vue"\s*:/],
      ['Express', /"express"\s*:/]
    ] as const)
      if (pattern.test(pkg)) frameworks.add(name)
  }
  const python = read('pyproject.toml') + read('requirements.txt')
  if (python || existsSync(join(root, 'manage.py'))) {
    languages.add('Python')
    if (/django/i.test(python) || existsSync(join(root, 'manage.py'))) frameworks.add('Django')
    if (/\bflask\b/i.test(python)) frameworks.add('Flask')
    if (/fastapi/i.test(python)) frameworks.add('FastAPI')
  }
  if (existsSync(join(root, 'Cargo.toml'))) languages.add('Rust')
  if (existsSync(join(root, 'go.mod'))) languages.add('Go')
  const composer = read('composer.json')
  if (composer) {
    languages.add('PHP')
    if (/laravel/i.test(composer)) frameworks.add('Laravel')
  }
  const jvm = read('pom.xml') + read('build.gradle') + read('build.gradle.kts')
  if (jvm) {
    languages.add(/kotlin/i.test(jvm) ? 'Kotlin' : 'Java')
    if (/spring/i.test(jvm)) frameworks.add('Spring')
  }
  const gemfile = read('Gemfile')
  if (gemfile) {
    languages.add('Ruby')
    if (/\brails\b/.test(gemfile)) frameworks.add('Rails')
  }
  return languages.size || frameworks.size
    ? { languages: [...languages], frameworks: [...frameworks] }
    : null
}

/**
 * A positive reference to the open project: a source path, “this project”, “our
 * codebase”, “which file”. “How should I structure the code for X” names no project.
 */
function referencesOpenProject(text: string): boolean {
  return (
    mentionsSourcePath(text) ||
    /\b(?:our|my)\s+(?:current|existing)\b|\b(?:this|my|our|the)\s+(?:project|repo|repository|workspace|codebase)\b|\b(?:this|my|our)\s+(?:app|application|code|component|function|service|api|file|folder|module|tests?)\b|\b(?:where is|which file|what file|in the (?:repo|project|workspace))\b/i.test(
      text
    )
  )
}

/**
 * Resolution says the folder exists; applicability says whether it is evidence for
 * this request. It is decided from references (named files, the open project, a
 * named sibling, a follow-up), the destination and the kind of work — never from the
 * folder existing, and never differently for equivalent design and plan phrasing.
 */
export function scopeApplicability(
  text: string,
  interpretation: Pick<TaskInterpretation, 'artifact' | 'destination'>,
  namedTarget: boolean,
  hasProject: boolean,
  intent?: TurnPlan['intent'],
  continuation = false
): { applicability: ScopeApplicability; rule: string } {
  if (namedTarget) return { applicability: 'named-target', rule: 'named-target' }
  if (interpretation.destination !== 'chat')
    return { applicability: 'selected-project', rule: 'workspace-destination' }
  if (!hasProject) return { applicability: 'generic', rule: 'no-project' }
  const t = requestTextForIntent(text)
  if (referencesOpenProject(t))
    return { applicability: 'selected-project', rule: 'workspace-reference' }
  if (continuation) return { applicability: 'unverified', rule: 'continuation' }
  // “The code”, “a bug”, “fails” may or may not mean this project. A tool-free answer
  // cannot inspect it either way, so only a worker that can read keeps the ambiguity.
  if (asksWorkspaceQuestion(t) && intent !== 'answer' && !structuresNewCode(t))
    return { applicability: 'unverified', rule: 'possible-reference' }
  // “How are feature flags usually done in Next.js?” asks about practice, not this
  // folder. A framework name is not a reference, whatever worker the classifier chose.
  if (asksGeneralPractice(t)) return { applicability: 'generic', rule: 'general-practice' }
  // Reviews, checks and commands act on existing code by definition.
  if (['review', 'execution-report'].includes(interpretation.artifact))
    return { applicability: 'unverified', rule: 'operates-on-existing-code' }
  // “In an existing Next.js project” describes a hypothetical, not the open folder.
  if (
    /\b(?:an?|some|any)\s+(?:existing\s+|typical\s+|large\s+|small\s+)?(?:[\w.-]+\s+){0,2}(?:project|app|application|codebase|repo|service)\b|\bin\s+general\b|\bgenerally\b/i.test(
      t
    )
  )
    return { applicability: 'generic', rule: 'hypothetical-project' }
  // A lookup (“where is the limiter”), a check or a command may concern the open
  // project; keep that ambiguity instead of binding or discarding it. “Explain how JWT
  // works” is explore wording too, but names nothing to look up.
  if (asksToLocateCode(t) || /\b(?:find|locate|grep|search\s+for)\b/i.test(t))
    return { applicability: 'unverified', rule: 'lookup' }
  // A plan or sketch that names no project is design advice: “sketch graceful shutdown
  // for an admin dashboard” must not search an unrelated folder for a shutdown log.
  if (intent === 'run' || intent === 'verify')
    return { applicability: 'unverified', rule: `intent-${intent}` }
  return { applicability: 'generic', rule: 'no-project-reference' }
}

/**
 * Questions about usual or recommended practice, which no folder can answer. Checked
 * after explicit project references and ambiguous existing-code wording.
 */
export function asksGeneralPractice(text: string): boolean {
  return (
    /\b(?:usually|typically|commonly|normally|conventionally|idiomatic(?:ally)?|in\s+practice|best\s+practices?|common\s+(?:patterns?|approach(?:es)?|ways?))\b/i.test(
      text
    ) ||
    /^(?:so\s+)?how\s+(?:do|would|should|could|might)\s+(?:you|people|teams|one)\s+(?:usually\s+|typically\s+|normally\s+)?(?:implement|handle|structure|design|approach|build|do)\b/i.test(
      text
    ) ||
    /\b(?:looking\s+for|what(?:'s|\s+is))\s+(?:a|the)\s+(?:clean|good|simple|solid|sensible|common|standard|best|right|recommended|safest)\s+(?:way|approach|pattern)\b/i.test(
      text
    ) ||
    structuresNewCode(text)
  )
}

/** “How should I structure the code for X” describes code still to be written. */
function structuresNewCode(text: string): boolean {
  return /\bhow\s+(?:should|would|do|can)\s+(?:i|we|you)\s+(?:structure|organi[sz]e|lay\s+out)\s+(?:the\s+)?code\s+for\b/i.test(
    text
  )
}

export function createTaskContract(input: {
  referenceBinding?: ResolvedReference
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
  const boundProject =
    input.referenceBinding?.binding.status === 'bound'
      ? input.referenceBinding.binding.sources[0]?.projectRoot
      : undefined
  const selected =
    !target && boundProject && root && isPathInside(root, boundProject) && existsSync(boundProject)
      ? boundProject
      : (inheritedRoot ??
        (target ? (matchedRoots.length === 1 ? matchedRoots[0]!.root : null) : root))
  const priorAnswer = [...(input.history ?? [])]
    .reverse()
    .find((message) => message.role === 'assistant')
  // Follow-ups resolve against the recommendation objects the prior turn recorded;
  // older threads fall back to reading the prior answer's prose.
  const refersToPrior =
    /\b(those|these|them|recommended|suggested|recommendations?|confirm\s+(?:the\s+|all\s+)?(?:\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:improvements?|enhancements?|changes|fixes|ideas)|all of (?:it|them)|items?\s*#?\d|#\d|(?:first|second|third|fourth|fifth|last)\s+(?:one|item|recommendation|suggestion|fix|two|three)|the\s+[\w-]+(?:\s+[\w-]+){0,3}\s+(?:one|recommendation|suggestion))\b/i.test(
      input.text
    )
  const referenceConflict =
    input.referenceBinding?.binding.status === 'bound' && boundProject !== selected
  const referenceBlocked = Boolean(
    input.referenceBinding &&
    (input.referenceBinding.binding.status !== 'bound' || referenceConflict)
  )
  const referenceReason = referenceConflict
    ? 'The referenced recommendations belong to a different project; clarify the intended scope.'
    : input.referenceBinding?.binding.reason
  const offered = input.priorTask?.result?.offeredRecommendations ?? []
  const available: TaskRecommendation[] = !refersToPrior
    ? []
    : offered.length
      ? offered
      : priorAnswer
        ? extractRecommendations(priorAnswer.content)
        : []
  // “Only 2 and 4”, “all except caching”: the selection is resolved to stable IDs
  // before any edit, and an unresolvable one is asked about instead of widened.
  const selection = input.referenceBinding
    ? referenceBlocked
      ? {
          mode: 'named' as const,
          selected: [],
          excluded: [],
          unresolved: referenceReason || 'Clarify historical references before editing.'
        }
      : { mode: 'named' as const, selected: input.referenceBinding.recommendations, excluded: [] }
    : available.length
      ? selectRecommendations(input.text, available)
      : null
  const recommendations: TaskRecommendation[] = selection?.unresolved
    ? []
    : (selection?.selected ?? [])
  const recommendationSource =
    input.referenceBinding && recommendations.length
      ? 'historical-artifact'
      : !recommendations.length
        ? 'none'
        : offered.length
          ? 'prior-task'
          : 'prior-answer-prose'
  // An explicit “do not edit / do not run” is a constraint, whatever the route says.
  // Each forbidden effect is removed on its own: no edits keeps approved checks,
  // no commands keeps the patch.
  const forbidden = effectConstraints(input.text)
  const noCommands = forbidden.execution || forbidden.verification
  const policy =
    input.plan.toolPolicy === 'none' || referenceBlocked
      ? 'none'
      : input.plan.mode === 'ask' || (forbidden.edit && (noCommands || input.plan.intent !== 'run'))
        ? 'read'
        : noCommands && input.plan.toolPolicy === 'full'
          ? 'edit'
          : input.plan.toolPolicy
  const canEdit = (policy === 'edit' || policy === 'full') && !forbidden.edit
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
  const reading = interpretRequest({
    text: input.text,
    intent: input.plan.intent,
    canEdit,
    revision: 1,
    route: input.plan.routeTrace
  })
  const projectStack = detectProjectStack(selected)
  // Implementing referenced recommendations makes each one a separate obligation —
  // every selected item, never an implicit first ten. The full text stays on the
  // contract's recommendations; the obligation line is only a prompt-sized pointer.
  if (reading.artifact === 'patch' && recommendations.length)
    reading.obligations = [
      ...reading.obligations,
      ...recommendations.map((recommendation, index) => ({
        id: `recommendation-${recommendation.id}`,
        kind: 'implementation' as const,
        text: `Apply recommendation ${index + 1}: ${
          recommendation.text.length > 240
            ? `${recommendation.text.slice(0, 240)}… (full text in the task's recommendations)`
            : recommendation.text
        }`
      })),
      {
        id: 'accounting-recommendations',
        kind: 'answer' as const,
        text: `Account for all ${recommendations.length} recommendations by number: completed, deferred (with reason), blocked (with reason), or pending. Doing some in this turn is fine; leaving any unaccounted is not.`
      }
    ]
  if (reading.artifact === 'patch' && selection?.unresolved)
    reading.obligations = [
      ...reading.obligations,
      {
        id: 'clarify-recommendation-selection',
        kind: 'answer' as const,
        text: `Before editing, ask which earlier recommendations to apply: ${selection.unresolved}`
      }
    ]
  const scope = scopeApplicability(
    input.text,
    reading,
    Boolean(target && selected && !inheritedRoot),
    Boolean(selected),
    input.plan.intent,
    Boolean(inheritedRoot || recommendations.length)
  )
  const applicability = scope.applicability
  const interpretation: TaskInterpretation = {
    ...reading,
    // The project stack stays as a diagnostic; it is only compared when the project is in scope.
    projectStack,
    stackFit: applicability === 'generic' ? 'not-applicable' : stackFit(reading, projectStack),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    trace: {
      ...(reading.trace ?? { version: 1, artifactRule: 'unknown', rejected: [] }),
      scopeRule: scope.rule
    }
  }
  return {
    version: 2,
    taskId: input.taskId ?? randomUUID(),
    revision: 1,
    threadId: input.threadId ?? null,
    originalText: input.text,
    ...(input.referenceBinding
      ? {
          referenceBinding: referenceBlocked
            ? {
                ...input.referenceBinding.binding,
                status: referenceConflict
                  ? ('unavailable' as const)
                  : input.referenceBinding.binding.status,
                reason: referenceReason
              }
            : input.referenceBinding.binding
        }
      : {}),
    intent: input.plan.intent,
    deliverable,
    scope: {
      workspaceRoot: root,
      projectRoot: selected,
      projectId: selected ? createHash('sha256').update(selected).digest('hex').slice(0, 16) : null,
      state: selected ? 'resolved' : matches.length > 1 ? 'ambiguous' : 'missing',
      candidates: (selected ? [] : registry)
        .map((project) => (root ? relative(root, project.root) || '.' : project.name))
        .slice(0, 30),
      applicability
    },
    authority: {
      tools: policy,
      edit: canEdit,
      execute: noCommands
        ? 'none'
        : policy === 'full'
          ? 'approved'
          : policy !== 'none' &&
              input.plan.mode !== 'ask' &&
              (forbidden.edit
                ? ['review', 'verify'].includes(input.plan.intent)
                : ['edit', 'review', 'verify'].includes(input.plan.intent))
            ? 'verification'
            : 'none',
      externalEffects: policy === 'full' && !forbidden.external && !forbidden.commit
    },
    skillIds: input.skillIds ?? input.priorTask?.skillIds,
    recommendations,
    ...(selection && (selection.mode !== 'all' || selection.unresolved)
      ? {
          recommendationSelection: {
            mode: selection.mode,
            excludedIds: selection.excluded.map((item) => item.id),
            ...(selection.unresolved ? { unresolved: selection.unresolved } : {})
          }
        }
      : {}),
    ...(input.priorTask && input.priorTask.scope.workspaceRoot === root
      ? {
          continuation: {
            priorTaskId: input.priorTask.taskId,
            changedFiles: input.priorTask.result?.changedFiles ?? [],
            recommendationSource
          }
        }
      : {}),
    acceptanceCriteria: [
      ...acceptanceCriteriaFor(input.plan, deliverable, input.text, interpretation, applicability),
      ...(referenceBlocked
        ? [
            `Before editing or running commands, ask the user to clarify: ${referenceReason || 'which historical recommendation source to use'}`
          ]
        : [])
    ],
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
  interpretation: NonNullable<TaskContract['interpretation']>,
  applicability?: ScopeApplicability
): string[] {
  // The completion rule is built for the scope, not patched afterwards: a generic
  // request never carries a file-grounding criterion that a later line contradicts.
  const base =
    deliverable === 'answer' && (plan.intent === 'edit' || plan.intent === 'run')
      ? 'The requested change is described or shown in chat without claiming it was applied or verified.'
      : plan.executionPlan
        ? executionPlanFor(plan.mode, plan.intent, applicability).doneWhen
        : fallback
  // Each obligation is checked on its own; one satisfied part never completes the task.
  return [...new Set([base, ...interpretation.obligations.map((obligation) => obligation.text)])]
}

const MAX_INHERITED_REQUIREMENTS = 8
const MAX_PARENT_REQUEST_CHARS = 600
const MAX_INHERITED_FILES = 12

function mergedEffects(
  parent: TaskInterpretation['constraints'],
  child: TaskInterpretation['constraints']
): TaskInterpretation['constraints'] {
  if (!parent || !child) return parent ?? child
  return {
    edit: parent.edit || child.edit,
    verification: parent.verification || child.verification,
    execution: parent.execution || child.execution,
    commit: parent.commit || child.commit,
    external: parent.external || child.external,
    trace: [...parent.trace, ...child.trace]
  }
}

/**
 * A subgoal rarely restates what its parent asked for, so reading it alone loses the
 * stack and every stated limit. A child may narrow the parent's request. Picking one of
 * several languages the parent named is narrowing; naming a different one is a conflict,
 * which is recorded for the coordinator while the parent's requirement stands. Limits
 * only add up, and obligations and recommendations stay with the parent.
 */
function inheritRequirements(
  parent: TaskContract,
  goal: string,
  child: TaskInterpretation
): { interpretation: TaskInterpretation; inherited: InheritedRequirements } {
  const from = interpretationOf(parent)
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    Boolean(a && b && a.toLowerCase() === b.toLowerCase())
  const parentRequest =
    parent.inherited?.parentRequest ?? parent.originalText.slice(0, MAX_PARENT_REQUEST_CHARS)
  const narrows = namedLanguages(parent.originalText).some((name) => same(name, child.language))
  const namesSource = same(from.sourceLanguage, child.language)
  const conflict =
    from.language &&
    child.language &&
    !same(from.language, child.language) &&
    !namesSource &&
    !narrows
  const language = narrows && !namesSource ? child.language : (from.language ?? child.language)
  const frameworks = [...new Set([...from.frameworks, ...child.frameworks])]
  const lower = goal.toLowerCase()
  return {
    interpretation: {
      ...child,
      language,
      sourceLanguage: child.sourceLanguage ?? from.sourceLanguage,
      languageAmbiguity: language ? undefined : from.languageAmbiguity,
      frameworks,
      forbidsMutation: from.forbidsMutation || child.forbidsMutation,
      constraints: mergedEffects(from.constraints, child.constraints),
      projectStack: from.projectStack,
      stackFit: from.stackFit,
      conceptFit: child.conceptFit ?? from.conceptFit
    },
    inherited: {
      fromTaskId: parent.taskId,
      parentRequest,
      stack: [
        ...(language && !same(language, child.language) ? [language] : []),
        ...frameworks.filter((name) => !child.frameworks.includes(name))
      ],
      requirements: [
        ...new Set([
          ...(parent.inherited?.requirements ?? []),
          ...requestConstraints(parent.originalText).phrases
        ])
      ]
        .filter((phrase) => !lower.includes(phrase.toLowerCase()))
        .slice(0, MAX_INHERITED_REQUIREMENTS),
      files: [
        ...new Set([...(parent.inherited?.files ?? []), ...pathsIn(parent.originalText)])
      ].slice(0, MAX_INHERITED_FILES),
      conflicts: [
        ...(parent.inherited?.conflicts ?? []),
        ...(conflict
          ? [{ field: 'language' as const, parent: from.language!, child: child.language! }]
          : [])
      ]
    }
  }
}

function inheritedCriteria(inherited: InheritedRequirements, deliverable: string) {
  return [
    ...(inherited.stack.length && deliverable === 'patch'
      ? [`Use ${inherited.stack.join(', ')}, as the parent request requires.`]
      : []),
    ...inherited.requirements.map((phrase) => `Keep to the parent request: ${phrase}.`),
    ...inherited.conflicts.map(
      ({ parent, child }) =>
        `This goal names ${child} but the parent request requires ${parent}. Use ${parent} and report the conflict to your coordinator.`
    )
  ]
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
  const { interpretation, inherited } = inheritRequirements(
    parent,
    goal,
    interpretRequest({
      text: goal,
      intent: plan.intent,
      canEdit: edit,
      revision: parent.revision,
      route: plan.routeTrace
    })
  )
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
    // A child owns a bounded assignment; the parent's follow-up state is not its own.
    continuation: undefined,
    result: undefined,
    // The parent's selected recommendations are its work, not this assignment.
    recommendations: [],
    recommendationSelection: undefined,
    inherited,
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
    acceptanceCriteria: [
      ...acceptanceCriteriaFor(plan, deliverable, goal, interpretation, parent.scope.applicability),
      ...inheritedCriteria(inherited, deliverable)
    ],
    interpretation
  }
}
