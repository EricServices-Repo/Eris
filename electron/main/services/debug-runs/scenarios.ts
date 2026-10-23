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

const REVIEW = 'docs/reviews/eris-dev-10000-2026-10-23/AGENT-IMPROVEMENTS.md'

/** A disposable project for authentication questions, with an intentional missing-expiry defect. */
const PASSWORD_RESET_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'accounts', version: '1.0.0', type: 'module' }, null, 2),
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
  'src/auth/reset.ts': [
    "import { randomBytes } from 'crypto'",
    '',
    'const tokens = new Map<string, string>()',
    '',
    'export function issueResetToken(userId: string): string {',
    "  const token = randomBytes(32).toString('hex')",
    '  tokens.set(token, userId)',
    '  return token',
    '}',
    '',
    'export function consumeResetToken(token: string): string | null {',
    '  return tokens.get(token) ?? null',
    '}',
    ''
  ].join('\n'),
  'tests/reset.test.ts': [
    "import { issueResetToken, consumeResetToken } from '../src/auth/reset'",
    '',
    "test('a token resolves to its user', () => {",
    "  expect(consumeResetToken(issueResetToken('u1'))).toBe('u1')",
    '})',
    ''
  ].join('\n')
}

/** A small React project, so component questions have real components to read. */
const REACT_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'dashboard', dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } },
    null,
    2
  ),
  'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', strict: true } }),
  'src/components/UserList.tsx': [
    "import { useEffect, useState } from 'react'",
    '',
    'export function UserList({ load }: { load: () => Promise<string[]> }) {',
    '  const [users, setUsers] = useState<string[] | null>(null)',
    '  const [error, setError] = useState<string | null>(null)',
    '  useEffect(() => {',
    '    load().then(setUsers, (reason) => setError(String(reason)))',
    '  }, [load])',
    '  if (error) return <p role="alert">{error}</p>',
    '  if (!users) return <p>Loading…</p>',
    '  return <ul>{users.map((user) => <li key={user}>{user}</li>)}</ul>',
    '}',
    ''
  ].join('\n')
}

/** Two projects; only the named one may change. */
const MULTI_PROJECT_FIXTURE: Record<string, string> = {
  'apps/shop/package.json': JSON.stringify({ name: 'shop', version: '1.0.0' }),
  'apps/shop/src/cart.ts': [
    'export const TAX_RATE = 0.08',
    '',
    'export interface CartLine {',
    '  sku: string',
    '  quantity: number',
    '}',
    '',
    'export function lineCount(lines: CartLine[]): number {',
    '  return lines.reduce((count, line) => count + line.quantity, 0)',
    '}',
    '',
    'export function cartTotal(prices: number[]): number {',
    '  return prices.reduce((sum, price) => sum + price, 0)',
    '}',
    ''
  ].join('\n'),
  'apps/blog/package.json': JSON.stringify({ name: 'blog', version: '1.0.0' }),
  'apps/blog/src/cart.ts': [
    '// Unrelated sibling: a reading-list "cart" with no prices.',
    'export function cartTotal(posts: string[]): number {',
    '  return posts.length',
    '}',
    ''
  ].join('\n')
}

const SOFT_DELETE_EXAMPLE = [
  '```ts',
  'interface Row { id: string; deletedAt: Date | null }',
  'export class SoftDeleteStore<T extends Row> {',
  '  private rows = new Map<string, T>()',
  '  save(row: T) { this.rows.set(row.id, row) }',
  '  softDelete(id: string) { const row = this.rows.get(id); if (row) row.deletedAt = new Date() }',
  '  restore(id: string) { const row = this.rows.get(id); if (row) row.deletedAt = null }',
  '  list(): T[] { return [...this.rows.values()].filter((row) => row.deletedAt === null) }',
  '}',
  '```',
  'softDelete marks a row; restore clears the mark; list hides deleted rows.'
].join('\n')

const DATA_MODEL_QUESTIONS: Array<{ id: string; topic: string; q: string }> = [
  {
    id: 'data-model-infinite-scroll',
    topic: 'infinite scroll using cursor pagination',
    q: 'Q2813'
  },
  {
    id: 'data-model-transactional-email',
    topic: 'transactional emails using templates',
    q: 'Q8123'
  },
  { id: 'data-model-rbac', topic: 'role-based access control', q: 'Q8882' }
]

/**
 * Labeled regressions from the 10,000-question review. Expectations come from the
 * request wording, not from the router; several intents are acceptable when they
 * deliver the same artifact under the same authority.
 */
const CORPUS_SCENARIOS: DebugScenarioInput[] = [
  {
    id: 'complete-example-soft-delete',
    title: 'A complete example request gets code, not a plan',
    description: 'Q2: a minimal but complete TypeScript example of soft delete with restore.',
    tags: ['answer', 'code-example', 'corpus-regression'],
    modes: ['simulated', 'real-model'],
    request: {
      text: 'Can you generate a minimal but complete example of soft deletes with the ability to restore in TypeScript?'
    },
    fixture: FIXTURE,
    label: {
      source: 'review-derived',
      reference: `${REVIEW} · Q2`,
      rationale:
        'The requested artifact is a working example in chat. A plan of future steps or a workspace edit changes it.'
    },
    expect: {
      intent: ['answer', 'explore'],
      artifact: ['code-example'],
      forbiddenIntents: ['plan', 'edit', 'verify', 'capability'],
      mutation: 'forbidden',
      checks: [{ type: 'answer_matches', pattern: 'restore' }],
      terminal: 'complete'
    },
    script: { agent: [reply(SOFT_DELETE_EXAMPLE)] }
  },
  {
    id: 'seed-data-not-verification',
    title: '“Test data” is a feature, not a verification request',
    description: 'Q524: an implementation of seeding realistic test data.',
    tags: ['answer', 'code-example', 'corpus-regression'],
    modes: ['simulated', 'real-model'],
    request: {
      text: 'Write a TypeScript implementation of seeding realistic test data that prioritizes clarity?'
    },
    fixture: FIXTURE,
    label: {
      source: 'review-derived',
      reference: `${REVIEW} · Q524`,
      rationale: '“Test data” describes data to create; nothing existing is to be verified.'
    },
    expect: {
      artifact: ['code-example', 'patch'],
      forbiddenIntents: ['verify', 'capability'],
      terminal: 'complete'
    },
    script: {
      agent: [
        reply(
          [
            '```ts',
            'export function seedUsers(count: number) {',
            '  return Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `User ${i + 1}` }))',
            '}',
            '```'
          ].join('\n')
        )
      ]
    }
  },
  ...DATA_MODEL_QUESTIONS.map(({ id, topic, q }): DebugScenarioInput => ({
    id,
    title: `Data model and API design for ${topic}`,
    description: `${q}: an application data model, not the Eris model catalog.`,
    tags: ['design', 'corpus-regression'],
    modes: ['simulated', 'real-model'],
    request: { text: `How would you design the data model and API for ${topic}?` },
    fixture: FIXTURE,
    label: {
      source: 'review-derived',
      reference: `${REVIEW} · ${q}`,
      rationale:
        '“Data model and API” refers to application design; the AI-model catalog cannot answer it.'
    },
    expect: {
      artifact: ['design'],
      forbiddenIntents: ['capability', 'edit', 'run'],
      mutation: 'forbidden',
      terminal: 'complete'
    },
    script: {
      agent: [
        reply(
          'Data model: a table keyed by id with created_at. API: GET /items?cursor=…&limit=…. Tradeoff: cursors are stable under inserts; offsets are not.'
        )
      ]
    }
  })),
  {
    id: 'password-reset-review-grounded',
    title: 'An authentication review reads the real reset flow',
    description: 'A representative fixture with an intentional missing-expiry defect.',
    tags: ['review', 'read-only', 'representative-fixture'],
    modes: ['simulated', 'real-model'],
    request: {
      text: 'Review the password reset flow in src/auth/reset.ts for security problems.'
    },
    fixture: PASSWORD_RESET_FIXTURE,
    expect: {
      intent: ['review', 'explore'],
      mutation: 'forbidden',
      checks: [{ type: 'answer_matches', pattern: 'expir|single.use|one.time|reuse' }],
      terminal: 'complete'
    },
    script: {
      agent: [
        tool('read_file', { path: 'src/auth/reset.ts' }),
        reply(
          'Findings for src/auth/reset.ts:\n1. Tokens never expire.\n2. consumeResetToken does not delete the token, so it can be reused.\n3. Tokens are stored in plain text in memory.'
        )
      ],
      outcome: [verdict('supported', 'Findings cite the inspected reset flow.')]
    }
  },
  {
    id: 'react-component-explained',
    title: 'A component question reads the React component',
    description: 'A representative React fixture: the answer must come from the component.',
    tags: ['explore', 'read-only', 'representative-fixture'],
    modes: ['simulated', 'real-model'],
    request: { text: 'Explain how UserList handles loading and errors in this project.' },
    fixture: REACT_FIXTURE,
    expect: {
      intent: ['explore', 'answer'],
      mutation: 'forbidden',
      checks: [{ type: 'answer_matches', pattern: 'UserList' }],
      terminal: 'complete'
    },
    script: {
      agent: [
        tool('read_file', { path: 'src/components/UserList.tsx' }),
        reply(
          'src/components/UserList.tsx: UserList shows “Loading…” until load() resolves and renders the error in a role="alert" paragraph when it rejects.'
        )
      ],
      intent: [intentReply('explore')]
    }
  },
  {
    id: 'multi-project-named-target',
    title: 'An edit to the named project leaves its sibling alone',
    description: 'Two projects define cart.ts; only the shop app may change.',
    tags: ['edit', 'scope', 'representative-fixture'],
    modes: ['simulated', 'real-model'],
    request: { text: 'In the shop app, fix cartTotal so it includes TAX_RATE.' },
    fixture: MULTI_PROJECT_FIXTURE,
    expect: {
      intent: ['edit'],
      mutation: 'required',
      allowedPaths: ['apps/shop/'],
      requiredPaths: ['apps/shop/src/cart.ts'],
      terminal: 'complete'
    },
    script: {
      agent: [
        tool('read_file', { path: 'apps/shop/src/cart.ts' }),
        tool('search_replace', {
          path: 'apps/shop/src/cart.ts',
          old_string: '  return prices.reduce((sum, price) => sum + price, 0)',
          new_string: '  return prices.reduce((sum, price) => sum + price, 0) * (1 + TAX_RATE)'
        }),
        reply('DONE: apps/shop/src/cart.ts now applies TAX_RATE; verification passed.')
      ],
      outcome: [verdict('supported', 'The diff applies TAX_RATE in the shop project only.')],
      verify: [{ ok: true, command: 'npm test', detail: 'simulated: 1 test passed' }]
    }
  }
]

const RETRY_GUARD = {
  path: 'src/retry.ts',
  old_string: '  return Math.min(250 * 2 ** attempt, 4_000)',
  new_string: [
    '  // Reject attempts outside the policy instead of returning surprising delays.',
    '  if (!Number.isInteger(attempt) || attempt < 0 || attempt > MAX_RETRIES)',
    '    throw new RangeError(`attempt must be an integer from 0 to ${MAX_RETRIES}`)',
    '  return Math.min(250 * 2 ** attempt, 4_000)'
  ].join('\n')
}

/** Review → “implement those” → “what changed?”, with the review in a given format. */
function reviewThenImplement(
  id: string,
  format: string,
  review: string,
  followUp: string
): DebugScenarioInput {
  return {
    id,
    title: `Review, then implement the recommendations (${format})`,
    description: `A ${format} review must stay read-only; “${followUp}” applies its recommendations in the same project; “What did you change?” reports the actual diff.`,
    tags: ['multi-turn', 'follow-up', 'recommendations'],
    modes: ['simulated', 'real-model'],
    request: { text: 'Review src/retry.ts and recommend improvements to the retry logic.' },
    fixture: FIXTURE,
    label: {
      source: 'review-derived',
      reference: `${REVIEW} · AG-052/AG-053`,
      rationale:
        'The recurring product failure: a follow-up that refers to earlier recommendations must apply them without the user repeating them.'
    },
    expect: { intent: ['review'], mutation: 'forbidden', terminal: 'complete' },
    followUps: [
      {
        text: followUp,
        expect: {
          intent: ['edit'],
          mutation: 'required',
          allowedPaths: ['src/'],
          requiredPaths: ['src/retry.ts'],
          recommendations: { min: 2, source: 'prior-task' },
          terminal: 'complete'
        }
      },
      {
        text: 'What did you change?',
        expect: {
          intent: ['explore', 'answer'],
          mutation: 'forbidden',
          priorChangedFiles: ['src/retry.ts'],
          checks: [{ type: 'answer_matches', pattern: 'src/retry\\.ts' }],
          terminal: 'complete'
        }
      }
    ],
    script: {
      agent: [
        tool('read_file', { path: 'src/retry.ts' }),
        reply(review),
        tool('read_file', { path: 'src/retry.ts' }),
        tool('search_replace', RETRY_GUARD),
        reply(
          'DONE: retryDelay in src/retry.ts now rejects negative, fractional and over-limit attempts.'
        ),
        tool('read_file', { path: 'src/retry.ts' }),
        reply(
          'I changed src/retry.ts: retryDelay now throws a RangeError for attempts outside 0–MAX_RETRIES.'
        )
      ],
      outcome: [
        verdict('supported', 'Findings cite src/retry.ts.'),
        verdict('supported', 'The diff applies both recommendations.'),
        verdict('supported', 'The summary matches the diff.')
      ],
      verify: [{ ok: true, command: 'npm test', detail: 'simulated: 2 tests passed' }]
    }
  }
}

const FOLLOW_UP_SCENARIOS: DebugScenarioInput[] = [
  reviewThenImplement(
    'follow-up-bullets',
    'bulleted',
    'Recommendations for src/retry.ts:\n- Reject negative attempts in retryDelay so callers cannot get sub-250 ms delays.\n- Enforce MAX_RETRIES inside retryDelay.',
    'Implement those recommendations.'
  ),
  reviewThenImplement(
    'follow-up-paragraphs',
    'paragraph',
    'retryDelay in src/retry.ts should reject negative attempts, because they produce delays shorter than 250 ms.\n\nConsider enforcing MAX_RETRIES inside retryDelay as well, so no caller can exceed the policy.',
    'Apply those.'
  ),
  {
    id: 'unrelated-edit-not-progress',
    title: 'Editing an unrelated file does not complete a named-file fix',
    description:
      'The request names src/divide.ts; a scripted model edits a different file and claims DONE.',
    tags: ['edit', 'progress', 'injected-failure'],
    modes: ['simulated'],
    request: {
      text: 'Fix safeDivide in src/divide.ts so that dividing by zero returns 0 instead of Infinity.'
    },
    fixture: FIXTURE,
    label: {
      source: 'review-derived',
      reference: `${REVIEW} · AG-057`,
      rationale: 'An unrelated file edit must not count as progress on the requested behavior.'
    },
    expect: {
      intent: ['edit'],
      terminal: 'incomplete',
      checks: [
        { type: 'answer_matches', pattern: 'none of them changed' },
        { type: 'file_contains', path: 'src/divide.ts', text: '  return left / right' }
      ]
    },
    script: {
      agent: [
        tool('read_file', { path: 'src/divide.ts' }),
        tool('write_file', {
          path: 'notes/divide.md',
          content: '# Notes\n\nDivision needs a zero guard.\n'
        }),
        reply('DONE: documented the division change.'),
        reply('DONE: documented the division change.'),
        reply('DONE: documented the division change.')
      ]
    }
  }
]

let cache: DebugScenario[] | null = null

/** Parsed built-in scenarios; an invalid definition fails loudly. */
export function builtinDebugScenarios(): DebugScenario[] {
  cache ??= [...BUILTIN_SCENARIOS, ...CORPUS_SCENARIOS, ...FOLLOW_UP_SCENARIOS].map((item) =>
    DebugScenarioSchema.parse(item)
  )
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
