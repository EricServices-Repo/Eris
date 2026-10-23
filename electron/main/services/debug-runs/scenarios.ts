import {
  DebugScenarioSchema,
  type DebugScenario,
  type DebugScenarioInfo,
  type DebugScenarioInput
} from '../../../../src/shared/debug-runs'
import { shortHash } from './model-adapters'

/**
 * Curated diagnostics scenarios. Each one runs the production chat turn in a
 * disposable copy of FIXTURE. Scripts drive simulated runs (and the injected
 * failures they contain); real-model runs reuse only the request and oracle.
 */
const FIXTURE: Record<string, string> = {
  'README.md': [
    '# Eris diagnostics fixture',
    '',
    'A disposable TypeScript project used only by Eris diagnostics runs.',
    ''
  ].join('\n'),
  'src/divide.ts': [
    '/**',
    ' * Divide two values for the reporting pipeline.',
    ' */',
    'export function safeDivide(left: number, right: number): number {',
    '  return left / right',
    '}',
    '',
    'export function formatRatio(left: number, right: number): string {',
    '  return safeDivide(left, right).toFixed(2)',
    '}',
    ''
  ].join('\n'),
  'src/retry.ts': [
    'export const MAX_RETRIES = 3',
    '',
    'export function retryDelay(attempt: number): number {',
    '  return Math.min(250 * 2 ** attempt, 4_000)',
    '}',
    ''
  ].join('\n')
}

const tool = (name: string, args: Record<string, unknown>) => ({
  text: JSON.stringify({ name, ...args })
})
const reply = (text: string) => ({ text })
const verdict = (value: 'supported' | 'partial' | 'unresolved', reason: string) =>
  reply(JSON.stringify({ verdict: value, reason }))
const intentReply = (intent: string) => reply(JSON.stringify({ intent, confidence: 0.95 }))

const DIVIDE_FIX = {
  name: 'search_replace',
  args: {
    path: 'src/divide.ts',
    old_string: '  return left / right',
    new_string: '  if (right === 0) return 0\n  return left / right'
  }
}

const BUILTIN_SCENARIOS: DebugScenarioInput[] = [
  {
    id: 'edit-explicit-fix',
    title: 'Explicit edit produces a scoped, verified diff',
    description:
      'An explicit fix request must route to edit, change only src/, and report verification.',
    tags: ['edit', 'verification'],
    modes: ['simulated', 'real-model'],
    request: {
      text: 'Fix safeDivide in src/divide.ts so that dividing by zero returns 0 instead of Infinity.'
    },
    fixture: FIXTURE,
    expect: {
      intent: ['edit'],
      mutation: 'required',
      allowedPaths: ['src/'],
      requiredPaths: ['src/divide.ts'],
      checks: [
        {
          type: 'file_matches',
          path: 'src/divide.ts',
          pattern: '(===|==)\\s*0|!\\s*right|Number\\.isFinite'
        }
      ],
      terminal: 'complete'
    },
    script: {
      agent: [
        tool('read_file', { path: 'src/divide.ts' }),
        tool(DIVIDE_FIX.name, DIVIDE_FIX.args),
        reply('DONE: safeDivide now returns 0 when the divisor is zero; verification passed.')
      ],
      outcome: [
        verdict('supported', 'The diff adds a zero-divisor guard and verification passed.')
      ],
      verify: [{ ok: true, command: 'npm test', detail: 'simulated: 2 tests passed' }]
    }
  },
  {
    id: 'review-website-build-issue-45',
    title: 'Website review reaches the model',
    description:
      'Issue #45: a generic website review must use the current workspace and return grounded recommendations.',
    tags: ['review', 'read-only', 'regression'],
    modes: ['simulated', 'real-model'],
    request: { text: 'Review the website build\nRecommend 5 improvements' },
    fixture: FIXTURE,
    expect: { intent: ['review'], mutation: 'forbidden', terminal: 'complete' },
    script: {
      agent: [
        tool('read_file', { path: 'src/retry.ts' }),
        reply(
          '1. Validate negative attempts in src/retry.ts.\n2. Handle non-integer attempts.\n3. Reject non-finite inputs.\n4. Enforce MAX_RETRIES.\n5. Document the 4000 ms delay cap.'
        )
      ],
      outcome: [verdict('supported', 'Recommendations cite inspected retry logic.')]
    }
  },
  {
    id: 'review-read-only',
    title: 'Review stays read-only',
    description: 'A review request may inspect files but must not modify the project.',
    tags: ['review', 'read-only'],
    modes: ['simulated', 'real-model'],
    request: {
      text: 'Review the code in src/retry.ts and point out any problems with the retry delay logic.'
    },
    fixture: FIXTURE,
    expect: {
      intent: ['review', 'explore'],
      mutation: 'forbidden',
      terminal: 'complete'
    },
    script: {
      agent: [
        tool('read_file', { path: 'src/retry.ts' }),
        reply(
          'Findings for src/retry.ts:\n' +
            '1. retryDelay grows as 250 * 2 ** attempt and is capped at 4000 ms; negative attempts produce sub-250 ms delays.\n' +
            '2. MAX_RETRIES is exported but retryDelay does not enforce it.'
        )
      ],
      outcome: [verdict('supported', 'Findings cite src/retry.ts lines that were read.')]
    }
  },
  {
    id: 'explain-workspace',
    title: 'Workspace question is answered from inspected files',
    description:
      'A question about the project should read sources instead of asking to paste them.',
    tags: ['explore', 'read-only'],
    modes: ['simulated', 'real-model'],
    request: { text: 'How does retry timing work in this project?' },
    fixture: FIXTURE,
    expect: {
      intent: ['explore', 'answer'],
      mutation: 'forbidden',
      checks: [{ type: 'answer_matches', pattern: 'retry' }],
      terminal: 'complete'
    },
    script: {
      agent: [
        tool('read_file', { path: 'src/retry.ts' }),
        reply(
          'Retry timing is defined in src/retry.ts: three retries, with capped exponential backoff starting at 250 ms and limited to 4000 ms.'
        )
      ],
      intent: [intentReply('explore')]
    }
  },
  {
    id: 'false-done-rejected',
    title: 'A “done” claim without a diff is not accepted',
    description:
      'The scripted model claims completion before editing; only the later real edit may satisfy the task.',
    tags: ['edit', 'injected-failure'],
    modes: ['simulated'],
    request: {
      text: 'Add a describeRetry() function to src/retry.ts that returns a readable summary of the retry policy.'
    },
    fixture: FIXTURE,
    expect: {
      intent: ['edit'],
      mutation: 'required',
      allowedPaths: ['src/'],
      requiredPaths: ['src/retry.ts'],
      checks: [
        { type: 'file_contains', path: 'src/retry.ts', text: 'export function describeRetry' }
      ],
      terminal: 'complete'
    },
    script: {
      agent: [
        reply('DONE: describeRetry has been added to src/retry.ts.'),
        tool('read_file', { path: 'src/retry.ts' }),
        tool('search_replace', {
          path: 'src/retry.ts',
          old_string: 'export const MAX_RETRIES = 3\n',
          new_string:
            'export const MAX_RETRIES = 3\n\nexport function describeRetry(): string {\n  return `up to ${MAX_RETRIES} retries with capped exponential backoff`\n}\n'
        }),
        reply('DONE: Added describeRetry() to src/retry.ts; verification passed.')
      ],
      outcome: [verdict('supported', 'describeRetry was added by an observed edit.')],
      verify: [{ ok: true, command: 'npm test', detail: 'simulated: typecheck passed' }]
    }
  },
  {
    id: 'malformed-tool-recovery',
    title: 'Malformed tool arguments are rejected, then corrected',
    description:
      'The first tool call has an invalid argument type. It must not execute; the corrected call proceeds.',
    tags: ['edit', 'tool-protocol', 'injected-failure'],
    modes: ['simulated'],
    request: {
      text: 'Fix safeDivide in src/divide.ts so that dividing by zero returns 0 instead of Infinity.'
    },
    fixture: FIXTURE,
    expect: {
      intent: ['edit'],
      mutation: 'required',
      allowedPaths: ['src/'],
      requiredPaths: ['src/divide.ts'],
      checks: [{ type: 'file_contains', path: 'src/divide.ts', text: 'right === 0' }],
      terminal: 'complete'
    },
    script: {
      agent: [
        tool('read_file', { path: 7 }),
        tool('read_file', { path: 'src/divide.ts' }),
        tool(DIVIDE_FIX.name, DIVIDE_FIX.args),
        reply('DONE: Added a zero-divisor guard to safeDivide; verification passed.')
      ],
      outcome: [verdict('supported', 'The corrected edit is present in the observed diff.')],
      verify: [{ ok: true, command: 'npm test', detail: 'simulated: 2 tests passed' }]
    }
  },
  {
    id: 'command-refused',
    title: 'Shell commands are refused in diagnostics',
    description:
      'A run request reaches the command approval boundary and is refused without any prior approval. ' +
      'Characterizes a known gap: a run turn that changes no files cannot finish with DONE ' +
      '(agent/heuristics.ts shouldKeepWorking), so it ends incomplete at the step cap.',
    tags: ['run', 'approvals', 'injected-failure', 'known-gap'],
    modes: ['simulated'],
    request: { text: 'Run npm test and tell me whether it passes.' },
    fixture: FIXTURE,
    expect: {
      intent: ['run'],
      mutation: 'forbidden',
      blockedEffects: ['command'],
      terminal: 'incomplete'
    },
    script: {
      agent: [
        tool('run', { command: 'npm test' }),
        reply('DONE: npm test was not run because the command was not approved in this session.')
      ]
    }
  },
  {
    id: 'provider-error',
    title: 'Provider failure is reported, not hidden',
    description:
      'The model transport fails on the first agent call; the run must not report success.',
    tags: ['explore', 'provider', 'injected-failure'],
    modes: ['simulated'],
    request: { text: 'How does retry timing work in this project?' },
    fixture: FIXTURE,
    expect: {
      intent: ['explore', 'answer'],
      mutation: 'forbidden',
      terminal: 'error'
    },
    script: {
      agent: [{ error: 'simulated provider failure: 503 Service Unavailable' }],
      intent: [intentReply('explore')]
    }
  },
  {
    id: 'repeated-tool-loop',
    title: 'Identical repeated tool calls stop as incomplete',
    description:
      'A model that repeats the same mutating call must be stopped and marked incomplete.',
    tags: ['edit', 'recovery', 'injected-failure'],
    modes: ['simulated'],
    request: { text: 'Create notes/todo.md with a short list of next steps for this project.' },
    fixture: FIXTURE,
    expect: {
      intent: ['edit'],
      mutation: 'required',
      allowedPaths: ['notes/'],
      terminal: 'incomplete'
    },
    script: {
      agent: Array.from({ length: 6 }, () =>
        tool('write_file', { path: 'notes/todo.md', content: '- Add retry jitter\n' })
      )
    }
  }
]

let cache: DebugScenario[] | null = null

/** Parsed built-in scenarios; an invalid definition fails loudly. */
export function builtinDebugScenarios(): DebugScenario[] {
  cache ??= BUILTIN_SCENARIOS.map((item) => DebugScenarioSchema.parse(item))
  return cache
}

export function scenarioHash(scenario: DebugScenario): string {
  return shortHash(JSON.stringify(scenario))
}

export function findDebugScenario(id: string): DebugScenario | undefined {
  return builtinDebugScenarios().find((scenario) => scenario.id === id)
}

export function listDebugScenarioInfo(): DebugScenarioInfo[] {
  return builtinDebugScenarios().map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    tags: scenario.tags,
    modes: scenario.modes,
    expectedIntents: scenario.expect.intent ?? [],
    mutation: scenario.expect.mutation,
    hash: scenarioHash(scenario)
  }))
}
