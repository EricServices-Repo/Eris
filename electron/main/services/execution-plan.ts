import type { ChatIntent, TurnPlan } from '../../../src/shared/settings-schema'
import type { ScopeApplicability } from '../../../src/shared/task-contract'
import { evidenceRequirementFor } from '../../../src/shared/task-contract'

/**
 * The workflow a turn follows, from its intent and whether the open project is
 * evidence for it. A generic request never gets a source-inspection step or a
 * file-grounded completion rule; a project request keeps both.
 */
export function executionPlanFor(
  mode: 'ask' | 'agent',
  intent: ChatIntent,
  applicability?: ScopeApplicability
): NonNullable<TurnPlan['executionPlan']> {
  const evidence = evidenceRequirementFor(applicability)
  if (intent === 'capability') {
    return {
      steps: ['Check Eris model and provider catalog'],
      needs: ['none'],
      doneWhen: 'Answer from the current catalog.'
    }
  }
  // A tool-free answer cannot inspect, mutate, or verify. Its plan is the reply itself.
  if (intent === 'answer') {
    return {
      steps: [
        'Identify the requested deliverable, language, and constraints',
        'Answer directly; when code is requested, include a complete example with its dependencies and limitations'
      ],
      needs: ['none', 'none'],
      doneWhen:
        'The question is answered in chat. No workspace edits, command runs, or verification are claimed.'
    }
  }
  if (intent === 'plan') {
    if (evidence === 'none')
      return {
        steps: [
          'Identify the goal, constraints, and stated stack',
          'Return ordered steps with dependencies, risks, and completion checks'
        ],
        needs: ['none', 'none'],
        doneWhen:
          'The plan is built from the request with its assumptions stated, without citing the open project as evidence.'
      }
    if (evidence === 'optional')
      return {
        steps: [
          'Decide whether the open project is relevant; inspect it only if so',
          'Return ordered steps with dependencies, risks, and completion checks'
        ],
        needs: ['read', 'none'],
        doneWhen:
          'The plan separates decisions from assumptions and cites project files only when they were inspected and relevant.'
      }
    return {
      steps: [
        'Inspect the relevant sources and project conventions',
        'Trace dependencies and integration points',
        'Return ordered steps with files, risks, and completion checks'
      ],
      needs: ['read', 'read', 'none'],
      doneWhen:
        'The plan is grounded in inspected files and clearly distinguishes decisions from assumptions.'
    }
  }
  if (intent === 'verify') {
    return {
      steps: [
        'Inspect the implementation and relevant tests',
        'Probe likely edge cases and failure paths',
        'Run relevant approved verification commands',
        'Report observed results and remaining risks'
      ],
      needs: ['read', 'read', 'run', 'none'],
      doneWhen:
        'Every claimed result is supported by inspection or command output, with no files edited.'
    }
  }
  if (mode === 'ask' || intent === 'explore') {
    if (evidence === 'none')
      return {
        steps: ['Identify what is being asked', 'Answer from the request and stated assumptions'],
        needs: ['none', 'none'],
        doneWhen:
          'The question is answered without citing the open project, which is not evidence for it.'
      }
    if (evidence === 'optional')
      return {
        steps: [
          'Decide whether the answer depends on the open project',
          'Read the matching files only if it does',
          'Answer, citing paths only for files actually read'
        ],
        needs: ['read', 'read', 'none'],
        doneWhen:
          'The answer cites project files only when they were read and relevant, and states assumptions otherwise.'
      }
    return {
      steps: [
        'Find relevant workspace sources',
        'Read the matching files',
        'Answer with paths and evidence'
      ],
      needs: ['read', 'read', 'none'],
      doneWhen: 'The answer is grounded in the files that were read.'
    }
  }
  if (intent === 'review') {
    return {
      steps: [
        'Map the requested scope',
        'Inspect relevant implementation and tests',
        'Rank findings with evidence'
      ],
      needs: ['read', 'read', 'none'],
      doneWhen: 'Each finding has a path, impact, and actionable fix.'
    }
  }
  if (intent === 'run') {
    return {
      steps: [
        'Inspect the requested run target if needed',
        'Run it with required approval',
        'Report the result'
      ],
      needs: ['read', 'run', 'none'],
      doneWhen: 'The command result and any remaining failure are stated accurately.'
    }
  }
  return {
    steps: [
      'Inspect affected code and project rules',
      'Make the requested changes',
      'Run relevant verification',
      'Summarize the diff'
    ],
    needs: ['read', 'edit', 'run', 'none'],
    doneWhen: 'The requested behavior is implemented and verification results are reported.'
  }
}
