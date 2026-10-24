import {
  interpretationOf,
  taskContractConflicts,
  type TaskContract
} from '../../../../src/shared/task-contract'
import { asksForVerification } from '../../../../src/shared/agent-contract'
import { requestTextForIntent } from '../../../../src/shared/task-interpretation'
import { INVARIANT_VERSION } from '../../../../src/shared/agent-versions'

/**
 * Deterministic request-level invariants from the 10,000-question review. They
 * judge whether a request is coherent before inference; they never grade an
 * answer, and a request with no findings is not evidence of answer quality.
 */
export interface InvariantFinding {
  /** Stable ID used by exports, release gates and trend reports. */
  id: string
  /** defect: confirmed incoherence. review: a candidate needing adjudication. */
  severity: 'defect' | 'review'
  detail: string
}

export interface CapturedRequestShape {
  purpose: string
  messages: unknown[]
  tools: unknown[]
}

const SHARED_RULES_HEADER = 'Shared rules (every role inherits these)'

/**
 * Bumped (in agent-versions) when a check is added or changed, so exports say which rules
 * judged them. Re-exported rather than redeclared so the two can never disagree.
 */
export const INVARIANT_RULES_VERSION = INVARIANT_VERSION

/*
 * Expectations below are written independently of the routing helpers that build the
 * contract (asksForCodeExample, requestedComponents, …). If those helpers regress, these
 * patterns still fire; reusing the helpers would make every check agree with the bug.
 */
/** An explicit request for a code example or implementation shown in chat. */
const EXPLICIT_EXAMPLE =
  /^(?:please\s+)?(?:i\s+(?:need|want|would\s+like)\s+(?:an?\s+|some\s+)?(?:[\w-]+\s+){0,2}(?:example|sample|snippet|implementation)s?\s+(?:of|for)\b|(?:can\s+you\s+)?(?:show|give)\s+me\s+(?:an?\s+|some\s+|both\s+)?(?:[\w-]+\s+){0,4}(?:example|sample|snippet|implementation|version)s?\b)/i
/** Two requested versions of one deliverable. */
const TWO_VERSIONS =
  /\bboth\s+(?:an?\s+)?\w+\s+and\s+(?:an?\s+)?(?:more\s+)?\w+\s+(?:version|implementation)s?\b|\bsimple\b[\s\S]{0,30}\b(?:and|vs\.?|versus)\b[\s\S]{0,30}\brobust\b/i
/** Completion rules and instructions that require inspected project sources. */
const FILE_GROUNDING =
  /grounded in (?:the )?(?:inspected files|files that were read)|Inspect the relevant (?:files|sources)|Return findings with file paths|Answer with paths and evidence|real file paths and symbols it read|Read the matching source files/i

function systemText(request: CapturedRequestShape): string {
  return request.messages
    .filter((message): message is { role: string; content: string } =>
      Boolean(
        message &&
        typeof message === 'object' &&
        (message as { role?: unknown }).role === 'system' &&
        typeof (message as { content?: unknown }).content === 'string'
      )
    )
    .map((message) => message.content)
    .join('\n')
}

function toolNames(request: CapturedRequestShape): string[] {
  return request.tools
    .map((tool) => (tool as { function?: { name?: unknown } })?.function?.name)
    .filter((name): name is string => typeof name === 'string')
}

export function requestInvariantFindings(input: {
  task: TaskContract
  requests: CapturedRequestShape[]
  imagesEnabled: boolean
  mcpToolCount: number
}): InvariantFinding[] {
  const findings: InvariantFinding[] = []
  const add = (id: string, severity: InvariantFinding['severity'], detail: string) => {
    if (!findings.some((finding) => finding.id === id)) findings.push({ id, severity, detail })
  }
  const { task } = input
  const reading = interpretationOf(task)
  const text = requestTextForIntent(task.originalText)

  for (const conflict of taskContractConflicts(task)) add('contract-conflict', 'defect', conflict)
  if (
    task.deliverable === 'answer' &&
    !task.authority.edit &&
    task.acceptanceCriteria.some((criterion) =>
      /\bis implemented\b|verification results are reported/i.test(criterion)
    )
  )
    add(
      'answer-requires-mutation',
      'defect',
      'A tool-free answer is required to implement and verify changes.'
    )
  if (
    task.intent === 'capability' &&
    /\b(?:data|domain|database)\s+models?\b|\bmodels?\s+and\s+(?:an?\s+)?api\b/i.test(text)
  )
    add(
      'domain-model-as-capability',
      'defect',
      'An application data-model question is restricted to the Eris model catalog.'
    )
  if (task.intent === 'verify' && !asksForVerification(text))
    add(
      'verification-without-request',
      'review',
      'Verification was selected, but the request does not ask to check existing behavior.'
    )
  if (reading.artifact === 'code-example' && task.intent === 'plan')
    add('code-example-as-plan', 'review', 'A requested code example is routed as a plan.')
  // FR-007: every selected recommendation is an obligation; a batch limit is not a scope limit.
  const recommendationObligations = reading.obligations.filter((item) =>
    item.id.startsWith('recommendation-')
  ).length
  if (
    reading.artifact === 'patch' &&
    task.recommendations.length &&
    recommendationObligations < task.recommendations.length
  )
    add(
      'recommendations-truncated',
      'defect',
      `${task.recommendations.length} recommendations were selected, but only ${recommendationObligations} became obligations.`
    )
  // FR-003: a forbidden effect must not survive into the granted authority.
  if (reading.constraints?.edit && task.authority.edit)
    add(
      'forbidden-edit-granted',
      'defect',
      'The request forbids edits, but edit authority was granted.'
    )
  if (
    (reading.constraints?.execution || reading.constraints?.verification) &&
    task.authority.execute !== 'none'
  )
    add(
      'forbidden-run-granted',
      'defect',
      'The request forbids running commands, but execution was granted.'
    )

  // LR-001/LR-017: a generic request must not be made to ground its answer in the project.
  const generic = task.scope.applicability === 'generic'
  if (generic && task.acceptanceCriteria.some((criterion) => FILE_GROUNDING.test(criterion)))
    add(
      'generic-requires-project-evidence',
      'defect',
      'The request does not depend on the open project, but acceptance requires project files.'
    )
  const implementations = reading.obligations.filter((item) => item.kind === 'implementation')
  if (EXPLICIT_EXAMPLE.test(text) && !implementations.length && reading.artifact !== 'review')
    add(
      'explicit-example-without-implementation',
      'defect',
      `The request asks for an example, but the ${reading.artifact} contract has no implementation obligation.`
    )
  if (
    TWO_VERSIONS.test(text) &&
    implementations.length > 0 &&
    new Set(implementations.map((item) => item.component ?? item.id)).size < 2
  )
    add(
      'output-cardinality-loss',
      'defect',
      'The request asks for two versions, but only one implementation obligation exists.'
    )
  if (
    /\bwith\s+good\s+test\s+coverage\b/i.test(text) &&
    !reading.obligations.some((item) => item.kind === 'tests') &&
    !reading.constraints?.verification
  )
    add(
      'coverage-without-tests-obligation',
      'review',
      'The request asks for good test coverage, but no testing obligation was recorded.'
    )

  for (const request of input.requests.filter((item) => item.purpose === 'agent')) {
    const system = systemText(request)
    const tools = toolNames(request)
    if (generic && FILE_GROUNDING.test(system))
      add(
        'generic-requires-project-evidence',
        'defect',
        'The compiled prompt asks a generic request to ground itself in project files.'
      )
    if (
      !task.authority.edit &&
      ['code-example', 'design', 'explanation', 'plan'].includes(reading.artifact) &&
      /Return findings with file paths/.test(system)
    )
      add(
        'read-only-findings-format',
        'defect',
        `A read-only ${reading.artifact} request is told to return a findings report.`
      )
    if (generic && tools.some((name) => ['tree', 'git_status', 'git_diff'].includes(name)))
      add(
        'generic-scope-workspace-tools',
        'review',
        'A generic request is offered workspace inspection tools.'
      )
    if (!system.includes('TASK CONTRACT'))
      add('missing-task-contract', 'defect', 'An agent request has no compiled task contract.')
    if (tools.length === 0 && /Make the requested changes|Run relevant verification/.test(system))
      add(
        'tool-free-mutation-plan',
        'defect',
        'A request without tools tells the model to edit or run verification.'
      )
    if (system.split(SHARED_RULES_HEADER).length - 1 > 1)
      add('duplicate-shared-rules', 'defect', 'The shared rules block appears more than once.')
    if (
      !task.authority.edit &&
      /"name"\s*:\s*"(?:write_file|search_replace|apply_patch)"/.test(system)
    )
      add('read-only-write-example', 'defect', 'A read-only request shows a write tool example.')
    if (!input.imagesEnabled && tools.includes('generate_image'))
      add('disabled-tool-exposed', 'defect', 'generate_image is offered while images are disabled.')
    if (input.mcpToolCount === 0 && tools.includes('search_mcp_tools'))
      add('mcp-discovery-without-catalog', 'defect', 'MCP discovery is offered with no MCP tools.')
    if (
      tools.length > 0 &&
      task.authority.edit &&
      task.authority.execute === 'verification' &&
      !tools.includes('run')
    )
      add(
        'verification-without-run-tool',
        'defect',
        'The edit task must verify, but no restricted run tool is available.'
      )
  }
  return findings
}
