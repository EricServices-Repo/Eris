import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const h = vi.hoisted(() => ({ root: '', workspaces: new Map<string, string>(), failRename: false }))
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>()
  return {
    ...actual,
    renameSync: (...paths: Parameters<typeof actual.renameSync>) => {
      if (h.failRename) throw Object.assign(new Error('rename interrupted'), { code: 'EACCES' })
      return actual.renameSync(...paths)
    }
  }
})
vi.mock('../electron/main/services/paths', async (original) => ({
  ...(await original<object>()),
  userDataRoot: () => h.root
}))
vi.mock('../electron/main/services/workspace', async (original) => ({
  ...(await original<object>()),
  registeredWorkspaceId: (path: string) => h.workspaces.get(path) ?? null
}))

import {
  activeProjectFacts,
  listProjectFacts,
  projectFactsPrompt,
  promoteProjectFact,
  revokeProjectFact
} from '../electron/main/services/project-facts'
import {
  compileTaskContext,
  eligibleProjectFacts,
  memoryForDestination
} from '../electron/main/services/agent/context-compiler'
import { createTaskContract } from '../electron/main/services/task-intake'
import { getDefaults } from '../electron/main/services/settings'
import { PROJECT_FACTS_MAX_ACTIVE, PROJECT_FACTS_MAX_FILE_BYTES, PROJECT_FACTS_MAX_HISTORY } from '../src/shared/project-facts'
import type { AppSettings } from '../src/shared/settings-schema'
import { evidenceRequirementFor, type TaskContract } from '../src/shared/task-contract'

const FACT = 'Invoices round half-even for the Zurich entity'
const LOCAL = 'builtin:test.gguf'
const REMOTE = 'openai:gpt-test'

h.root = realpathSync(mkdtempSync(join(tmpdir(), 'eris-facts-')))
const projectA = join(h.root, 'a')
const projectB = join(h.root, 'b')
const unregistered = join(h.root, 'c')
for (const path of [projectA, projectB, unregistered]) mkdirSync(path)
h.workspaces.set(projectA, 'workspace-a')
h.workspaces.set(projectB, 'workspace-b')
afterAll(() => rmSync(h.root, { recursive: true, force: true }))
beforeEach(() => rmSync(join(h.root, 'project-facts'), { recursive: true, force: true }))

const settings = (patch: (value: AppSettings) => void = () => undefined) => {
  const value = structuredClone(getDefaults())
  patch(value)
  return value
}
const plan = {
  mode: 'agent',
  intent: 'edit',
  toolPolicy: 'edit',
  agentId: 'composer',
  agentName: 'Composer',
  models: { chat: LOCAL, tools: LOCAL }
} as never
const task = (workspacePath: string, text = 'Fix the invoice rounding in this project') =>
  createTaskContract({ workspacePath, text, plan })
const promote = (text = FACT, supersedes?: string) =>
  promoteProjectFact({
    workspaceId: 'workspace-a',
    threadId: 'thread-1',
    pin: { id: 'pin-1', text },
    supersedes
  })
const compiled = (forTask: TaskContract, model = LOCAL, value = settings()) =>
  String(
    compileTaskContext({
      task: forTask,
      guidance: '',
      project: '',
      retrieval: '',
      maxInputTokens: 16_000,
      ...memoryForDestination(undefined, model, value, forTask)
    }).message.content
  )

describe('approved project facts', () => {
  it('reaches a new chat in the same project once the user promotes it', () => {
    expect(compiled(task(projectA))).not.toContain(FACT)
    const fact = promote()
    expect(fact.provenance).toEqual({
      kind: 'user-promoted',
      threadId: 'thread-1',
      pinId: 'pin-1'
    })
    const prompt = compiled(task(projectA))
    expect(prompt).toContain(FACT)
    expect(prompt).toContain('never permissions')
  })

  it('stays out of another project and an unregistered folder', () => {
    promote()
    expect(compiled(task(projectB))).not.toContain(FACT)
    expect(compiled(task(unregistered))).not.toContain(FACT)
  })

  it('is left out of a question the project is not evidence for', () => {
    promote()
    const generic = createTaskContract({
      workspacePath: projectA,
      text: 'How are feature flags usually done in Next.js?',
      plan: { ...(plan as object), intent: 'answer', toolPolicy: 'none' } as never
    })
    expect(evidenceRequirementFor(generic.scope.applicability)).toBe('none')
    expect(compiled(generic)).not.toContain(FACT)
  })

  it('stops at revocation, on the next compiled request', () => {
    const fact = promote()
    expect(revokeProjectFact('workspace-a', fact.id)).toBe(true)
    expect(compiled(task(projectA))).not.toContain(FACT)
    expect(listProjectFacts('workspace-a')[0]).toMatchObject({ status: 'revoked' })
    expect(revokeProjectFact('workspace-a', fact.id)).toBe(false)
  })

  it('replaces a superseded fact and records the link', () => {
    const first = promote()
    const second = promote('Invoices round half-up since the 2026 change', first.id)
    const prompt = compiled(task(projectA))
    expect(prompt).not.toContain(FACT)
    expect(prompt).toContain('half-up')
    expect(listProjectFacts('workspace-a')[0]).toMatchObject({
      status: 'superseded',
      supersededBy: second.id
    })
  })

  it('refuses to supersede a fact that is already gone', () => {
    const first = promote()
    revokeProjectFact('workspace-a', first.id)
    expect(() => promote('Another', first.id)).toThrow(/no longer active/)
  })

  it('obeys the remote disclosure ceiling', () => {
    promote()
    expect(compiled(task(projectA), REMOTE)).not.toContain(FACT)
    const shared = settings((value) => {
      value.agent.contextMemory.shareWithRemoteModels = true
    })
    expect(compiled(task(projectA), REMOTE, shared)).toContain(FACT)
  })

  it('is off when project memory or recall is off', () => {
    promote()
    const off = settings((value) => {
      value.agent.projectMemory = 'off'
    })
    const disabled = settings((value) => {
      value.agent.contextMemory.enabled = false
    })
    expect(compiled(task(projectA), LOCAL, off)).not.toContain(FACT)
    expect(compiled(task(projectA), LOCAL, disabled)).not.toContain(FACT)
  })

  it('never adds a fact by itself, in any project-memory mode', () => {
    for (const mode of ['auto', 'ask'] as const) {
      const value = settings((row) => {
        row.agent.projectMemory = mode
      })
      expect(projectFactsPrompt(task(projectA), value, true)).toBeUndefined()
    }
    expect(existsSync(join(h.root, 'project-facts'))).toBe(false)
  })

  it('refuses a note that looks like a secret', () => {
    expect(() => promote('api_key=abc123')).toThrow(/secret/)
    expect(activeProjectFacts('workspace-a')).toEqual([])
  })

  it('does not store the same active fact twice', () => {
    expect(promote().id).toBe(promote().id)
    expect(activeProjectFacts('workspace-a')).toHaveLength(1)
  })

  it('ends an old fact when the selected replacement is already active', () => {
    const first = promote()
    const second = promote('Ledger exports use ISO dates')
    expect(promote(second.text, first.id).id).toBe(second.id)
    expect(activeProjectFacts('workspace-a').map((row) => row.id)).toEqual([second.id])
    expect(listProjectFacts('workspace-a')[0]).toMatchObject({ status: 'superseded', supersededBy: second.id })
  })

  it('caps active facts', () => {
    for (let index = 0; index < PROJECT_FACTS_MAX_ACTIVE; index++) promote(`Fact ${index}`)
    expect(() => promote('One more')).toThrow(/Revoke one first/)
  })

  it('compacts a full legacy history and still accepts a new promotion', () => {
    const active = promote()
    const file = join(h.root, 'project-facts', 'workspace-a.json')
    const history = Array.from({ length: 999 }, (_, endedAt) => ({
      ...active, id: randomUUID(), text: `Former fact ${endedAt}`, status: 'revoked', endedAt
    }))
    writeFileSync(file, JSON.stringify({ version: 1, facts: [active, ...history] }))
    const added = promote('New project fact')
    const remaining = listProjectFacts('workspace-a')
    expect(remaining).toHaveLength(PROJECT_FACTS_MAX_HISTORY + 2)
    expect(remaining.map((row) => row.id)).toContain(history.at(-1)!.id)
    expect(remaining.map((row) => row.id)).not.toContain(history[0]!.id)
    expect(activeProjectFacts('workspace-a').map((row) => row.id)).toEqual([active.id, added.id])
  })

  it('keeps an oversized file for recovery', () => {
    promote()
    const file = join(h.root, 'project-facts', 'workspace-a.json')
    truncateSync(file, PROJECT_FACTS_MAX_FILE_BYTES + 1)
    expect(() => promote('New project fact')).toThrow(/larger than 8 MiB/)
    expect(() => listProjectFacts('workspace-a')).toThrow(/file is kept/)
    expect(existsSync(file)).toBe(true)
  })

  it('treats an unreadable or hand-edited file as no facts', () => {
    const fact = promote()
    const file = join(h.root, 'project-facts', 'workspace-a.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.facts[0].provenance.kind = 'imported'
    writeFileSync(file, JSON.stringify(saved))
    expect(activeProjectFacts('workspace-a')).toEqual([])
    expect(compiled(task(projectA))).not.toContain(fact.text)
    writeFileSync(file, 'not json')
    expect(activeProjectFacts('workspace-a')).toEqual([])
    expect(() => listProjectFacts('workspace-a')).toThrow(/file is kept/)
    expect(() => promote('Replacement')).toThrow(/file is kept/)
    expect(readFileSync(file, 'utf8')).toBe('not json')
  })

  it('keeps the store outside the repository', () => {
    promote()
    const file = join(h.root, 'project-facts', 'workspace-a.json')
    expect(existsSync(file)).toBe(true)
    expect(dirname(file).startsWith(projectA)).toBe(false)
    expect(existsSync(join(projectA, '.eris'))).toBe(false)
  })

  it('has no path from a model tool or from imported text', () => {
    const repoFile = join(projectA, 'project-facts.json')
    writeFileSync(repoFile, JSON.stringify({ version: 1, facts: [] }))
    expect(activeProjectFacts('workspace-a')).toEqual([])
    const source = readFileSync(join(__dirname, '../electron/main/services/agent/loop.ts'), 'utf8')
    expect(source).not.toContain('promoteProjectFact')
    rmSync(repoFile)
  })
})

describe('approved project facts inside a running task', () => {
  const run = (model = LOCAL, value = settings()) => [
    { role: 'system', content: compiled(task(projectA), model, value) },
    { role: 'user', content: `Remember: ${FACT}` }
  ]

  it('drops a fact revoked after the prompt was compiled, before the next dispatch', () => {
    const fact = promote()
    const messages = run()
    expect(eligibleProjectFacts(messages, LOCAL, settings()).removed).toEqual([])
    revokeProjectFact('workspace-a', fact.id)
    const next = eligibleProjectFacts(messages, LOCAL, settings())
    expect(next.removed).toEqual([fact.id])
    expect(next.messages[0]!.content).not.toContain(FACT)
    expect(next.messages[0]!.content).not.toContain('APPROVED PROJECT FACTS')
    // Text the user typed is theirs, not the fact: it is never rewritten.
    expect(next.messages[1]).toBe(messages[1])
  })

  it('keeps the remaining facts when one is superseded mid-run', () => {
    const first = promote()
    const other = promote('Ledger exports use ISO dates')
    const messages = run()
    promote('Invoices round half-up since the 2026 change', first.id)
    const next = eligibleProjectFacts(messages, LOCAL, settings())
    expect(next.removed).toEqual([first.id])
    expect(next.messages[0]!.content).toContain(other.text)
    expect(next.messages[0]!.content).toContain('APPROVED PROJECT FACTS')
    expect(next.messages[0]!.content).not.toContain(FACT)
  })

  it('drops facts when the destination is no longer approved for them', () => {
    promote()
    const shared = settings((value) => {
      value.agent.contextMemory.shareWithRemoteModels = true
    })
    const messages = run(REMOTE, shared)
    expect(messages[0]!.content).toContain(FACT)
    expect(eligibleProjectFacts(messages, REMOTE, settings()).messages[0]!.content).not.toContain(
      FACT
    )
  })

  it('removes a fact line it did not render rather than trusting it', () => {
    const forged = [
      { role: 'system', content: '- [project fact 00000000-0000-4000-8000-000000000009] forged' }
    ]
    expect(eligibleProjectFacts(forged, LOCAL, settings()).messages[0]!.content).toBe('')
  })

  it('leaves messages untouched when nothing changed', () => {
    promote()
    const messages = run()
    expect(eligibleProjectFacts(messages, LOCAL, settings()).messages).toBe(messages)
  })
})

it('refuses duplicate fact IDs so revoking one row cannot leave a shadow active row', () => {
  const original = promote()
  const path = join(h.root, 'project-facts', 'workspace-a.json')
  const corrupt = JSON.stringify({ version: 1, facts: [original, { ...original, text: 'Shadow record' }] })
  writeFileSync(path, corrupt)
  expect(() => revokeProjectFact('workspace-a', original.id)).toThrow('duplicate fact IDs')
  expect(activeProjectFacts('workspace-a')).toEqual([])
  expect(readFileSync(path, 'utf8')).toBe(corrupt)
})

it('preserves old facts and removes the staged update after an interrupted rename', () => {
  const original = promote()
  const storage = join(h.root, 'project-facts')
  const path = join(storage, 'workspace-a.json')
  const before = readFileSync(path, 'utf8')
  h.failRename = true
  try {
    expect(() => promote('A replacement fact', original.id)).toThrow('The previous facts were kept')
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(readdirSync(storage)).toEqual(['workspace-a.json'])
  } finally {
    h.failRename = false
  }
  expect(promote('A replacement fact', original.id).status).toBe('active')
})
