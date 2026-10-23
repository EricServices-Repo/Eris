import type { TurnPlan } from '../../../../src/shared/settings-schema'

export type WorkflowOperation = 'none' | 'read' | 'edit' | 'run'
export interface WorkflowConflict {
  step: string
  needs: Exclude<WorkflowOperation, 'none'>
  /** The layer that makes the step impossible. */
  layer: 'no-tools' | 'task-authority' | 'tool-policy'
}

const REPLACEMENT: Record<Exclude<WorkflowOperation, 'none'>, string> = {
  read: 'Answer from the conversation and supplied excerpts; workspace files cannot be read in this turn',
  edit: 'Describe or show the change without applying it; this turn cannot edit files',
  run: 'Name the checks that should run; no commands can run in this turn'
}

/**
 * Check each plan step against what this turn can actually do. Infeasible steps
 * are replaced with an honest alternative and returned as conflicts with the
 * layer responsible, so no prompt promises a workflow the runtime will refuse.
 */
export function lintExecutionPlan(
  executionPlan: TurnPlan['executionPlan'],
  can: { tools: boolean; read: boolean; edit: boolean; run: boolean; editAuthority: boolean }
): { executionPlan: TurnPlan['executionPlan']; conflicts: WorkflowConflict[] } {
  if (!executionPlan?.needs) return { executionPlan, conflicts: [] }
  const conflicts: WorkflowConflict[] = []
  const steps = executionPlan.steps.map((step, index) => {
    const needs = executionPlan.needs?.[index] ?? 'none'
    if (needs === 'none' || can[needs]) return step
    conflicts.push({
      step,
      needs,
      layer: !can.tools
        ? 'no-tools'
        : needs === 'edit' && !can.editAuthority
          ? 'task-authority'
          : 'tool-policy'
    })
    return REPLACEMENT[needs]
  })
  if (conflicts.length === 0) return { executionPlan, conflicts }
  return {
    executionPlan: {
      steps: [...new Set(steps)],
      needs: [],
      doneWhen: conflicts.some((conflict) => conflict.needs === 'edit')
        ? 'The requested change is described or shown in chat without claiming it was applied or verified.'
        : conflicts.some((conflict) => conflict.needs === 'run')
          ? `${executionPlan.doneWhen} Checks that could not run are named, not reported as passing.`
          : 'The answer uses only the conversation and supplied excerpts, without claiming files were read.'
    },
    conflicts
  }
}
