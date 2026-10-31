import type { AppSettings } from '../src/shared/settings-schema'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { contextMemoryStore } from '../electron/main/services/context-memory-store'
import { memoryKey } from '../electron/main/services/context-memory'
import { emptyMemoryControls } from '../src/shared/context-memory'
import { leaseMemoryEvidence, withEligibleMemory } from '../electron/main/services/memory-dispatch'
import { filterEvidenceMemory } from '../electron/main/services/context-evidence'
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import {
  captureContextEvidence,
  validateContextEvidence
} from '../electron/main/services/context-evidence-worker'
import {
  evidenceEpoch,
  evidenceEpochMatches,
  noteEvidenceChange
} from '../electron/main/services/context-evidence-epochs'

const DISPATCH_SETTINGS = { models: { connections: [] } } as unknown as AppSettings
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eris-evidence-deps-'))
  writeFileSync(join(root, 'app.ts'), 'export const currency="CAD"')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
it('retains matching sources and rejects rewritten, renamed, deleted and oversized sources', () => {
  const snapshot = captureContextEvidence(root, ['app.ts'])
  expect(snapshot.complete).toBe(true)
  expect(validateContextEvidence(root, [snapshot])).toEqual([true])
  writeFileSync(join(root, 'app.ts'), 'new code')
  expect(validateContextEvidence(root, [snapshot])).toEqual([false])
  renameSync(join(root, 'app.ts'), join(root, 'other.ts'))
  expect(validateContextEvidence(root, [snapshot])).toEqual([false])
  writeFileSync(join(root, 'huge'), Buffer.alloc(1024 ** 2 + 1))
  expect(captureContextEvidence(root, ['huge']).complete).toBe(false)
  expect(captureContextEvidence(root, ['../outside']).complete).toBe(false)
})
it('invalidates dirty documents and mid-compilation watcher changes without touching user preferences', () => {
  const snapshot = captureContextEvidence(root, ['app.ts'])
  snapshot.epoch = evidenceEpoch(root, ['app.ts'])
  expect(evidenceEpochMatches(snapshot)).toBe(true)
  noteEvidenceChange(root, 'unrelated.ts', true)
  expect(evidenceEpochMatches(snapshot)).toBe(false)
  noteEvidenceChange(root, 'app.ts', true)
  expect(evidenceEpochMatches(snapshot)).toBe(false)
  snapshot.epoch = evidenceEpoch(root, ['app.ts'])
  expect(evidenceEpochMatches(snapshot)).toBe(false)
  noteEvidenceChange(root, 'app.ts', false)
  expect(evidenceEpochMatches(snapshot)).toBe(false)
})
it('binds evidence to branch identity even when the file bytes stay unchanged', () => {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'fixture')
  git('add', 'app.ts')
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'fixture'
  )
  const snapshot = captureContextEvidence(root, ['app.ts'])
  expect(snapshot.complete).toBe(true)
  git('checkout', '-qb', 'other')
  expect(validateContextEvidence(root, [snapshot])).toEqual([false])
})

it('drops stale recalled code at actual dispatch while keeping preferences and requesting a fresh model session', async () => {
  vi.mocked(workspaceRequest).mockImplementation(async (req) =>
    req.type === 'context-evidence-validate'
      ? (validateContextEvidence(req.root, req.snapshots) as never)
      : (undefined as never)
  )
  const snapshot = captureContextEvidence(root, ['app.ts'])
  snapshot.epoch = evidenceEpoch(root, ['app.ts'])
  const key = memoryKey(root, 't'),
    messages = [
      {
        id: 'code',
        role: 'assistant' as const,
        content: 'Build succeeded SENTINEL_SOURCE',
        createdAt: 1,
        contextResult: {
          taskId: 'old',
          terminal: 'done',
          projectRoot: root,
          changedFiles: ['app.ts'],
          dependencies: snapshot
        }
      },
      {
        id: 'preference',
        role: 'user' as const,
        content: 'Remember: spelling British',
        createdAt: 1
      }
    ]
  contextMemoryStore.install(
    key,
    {
      revision: 1,
      total: 2,
      records: messages.map((message, ordinal) => ({ ordinal, message })),
      controls: emptyMemoryControls(),
      partial: false
    },
    contextMemoryStore.token(key)
  )
  const { prompt } = await contextMemoryStore.select(key, 'Build spelling')
  expect(prompt.text).toContain('SENTINEL_SOURCE')
  const release = leaseMemoryEvidence({ root, threadId: 't', taskId: 'new', prompt })
  try {
    const request = [
      { role: 'system', content: prompt.text },
      { role: 'user', content: 'Review current code' }
    ]
    expect(
      (await withEligibleMemory(request, 'builtin:test.gguf', DISPATCH_SETTINGS)).messages[0]
        .content
    ).toContain('SENTINEL_SOURCE')
    writeFileSync(join(root, 'app.ts'), 'changed after selection')
    const sent = await withEligibleMemory(
      [...request, { role: 'assistant', content: 'COMPACTED_STALE_PROOF: tests still pass.' }],
      'builtin:test.gguf',
      DISPATCH_SETTINGS
    )
    expect(sent.revoked).toBe(true)
    expect(JSON.stringify(sent.messages)).not.toContain('SENTINEL_SOURCE')
    expect(JSON.stringify(sent.messages)).not.toContain('COMPACTED_STALE_PROOF')
    expect(JSON.stringify(sent.messages)).toContain('spelling British')
    const filtered = await filterEvidenceMemory(root, prompt)
    expect(filtered.text).not.toContain('SENTINEL_SOURCE')
    expect(filtered.text).toContain('spelling British')
  } finally {
    release()
    contextMemoryStore.clear(key)
  }
})
