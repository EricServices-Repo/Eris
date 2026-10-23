import {
  interpretationOf,
  taskContractConflicts,
  type TaskContract
} from '../../../../src/shared/task-contract'
import { asksForVerification } from '../../../../src/shared/agent-contract'
import { requestTextForIntent } from '../../../../src/shared/task-interpretation'

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

  for (const request of input.requests.filter((item) => item.purpose === 'agent')) {
    const system = systemText(request)
    const tools = toolNames(request)
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
