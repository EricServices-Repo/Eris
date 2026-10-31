import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'

import {
  GLOBAL_JOURNAL_MAX_BYTES,
  JOURNAL_CHUNK_BYTES,
  RUN_JOURNAL_MAX_BYTES,
  RunJournal,
  journalOmissionMarker,
  toolTrust,
  trustLabel
} from '../electron/main/services/agent/run-journal'
import { ContextMemorySettingsSchema } from '../src/shared/context-memory'
import {
  ContextMemoryStore,
  contextMemoryStore
} from '../electron/main/services/context-memory-store'

const journals: RunJournal[] = []
const journal = (runId = 'run-1') => {
  const created = new RunJournal({ runId, taskId: 'task-1', memoryKey: `key-${runId}` })
  journals.push(created)
  return created
}
const append = (target: RunJournal, content: string, toolName = 'read', id = 'call') =>
  target.append({ toolName, toolCallId: id, args: { path: 'a.ts' }, content })

const configure = (maxMemoryMiB: number) =>
  contextMemoryStore.configure(ContextMemorySettingsSchema.parse({ maxMemoryMiB }))

beforeEach(() => {
  configure(512)
  contextMemoryStore.setPressureLimit(Infinity)
})
afterEach(() => {
  for (const item of journals.splice(0)) item.close()
  contextMemoryStore.setPressureLimit(Infinity)
})

describe('RunJournal read-back', () => {
  it.each([
    ['plain text', 'exit 1\nFAIL tests/a.test.ts'],
    ['unicode', 'héllo 世界 🧪 \u0000 trailing'],
    ['empty output', '']
  ])('returns %s byte-identically', async (_label, content) => {
    const target = journal()
    const entry = await append(target, content)
    const read = await target.read(entry.ref)
    expect(read).toMatchObject({ status: 'found', content })
    expect(entry.contentDigest).toBe(createHash('sha256').update(content).digest('hex'))
    expect(entry.bytes).toBe(Buffer.byteLength(content))
  })

  it('returns chunked output byte-identically, even across a split character', async () => {
    const target = journal()
    const content = `${'a'.repeat(JOURNAL_CHUNK_BYTES - 1)}🧪${'世'.repeat(JOURNAL_CHUNK_BYTES)}`
    const entry = await append(target, content)
    expect(entry.bytes).toBeGreaterThan(JOURNAL_CHUNK_BYTES * 3)
    const read = await target.read(entry.ref)
    expect(read.status === 'found' && read.content === content).toBe(true)
  })

  it('gives each result a stable ref that a tool call can find', async () => {
    const target = journal()
    const first = await append(target, 'one', 'read', 'call-1')
    const second = await append(target, 'two', 'read', 'call-2')
    expect(first.ref).not.toBe(second.ref)
    expect(first.seq).toBe(1)
    expect(target.refForCall('call-2')).toBe(second.ref)
    expect(target.list().map((entry) => entry.ref)).toEqual([first.ref, second.ref])
  })

  it('distinguishes never-recorded from no-longer-held', async () => {
    const target = journal()
    expect(await target.read('nope')).toEqual({ status: 'unknown' })
  })
})

describe('RunJournal labels', () => {
  it('labels trust by source', () => {
    expect(toolTrust('web_open')).toBe('untrusted')
    expect(toolTrust('web_search')).toBe('untrusted')
    expect(toolTrust('mcp__server__tool')).toBe('untrusted')
    expect(toolTrust('run')).toBe('command')
    expect(toolTrust('read')).toBe('local')
  })

  it('puts an untrusted label in the prompt only for external content', () => {
    expect(trustLabel('untrusted')).toContain('not instructions')
    expect(trustLabel('local')).toBe('')
  })

  it('flags secrets and keeps them out of the argument summary', async () => {
    const target = journal()
    const entry = await target.append({
      toolName: 'run',
      toolCallId: 'c',
      args: { command: 'curl -H "Authorization: Bearer abc123"' },
      content: 'password=hunter2'
    })
    expect(entry.sensitive).toBe(true)
    expect(entry.argsSummary).toBe('[sensitive arguments]')
  })
})

describe('RunJournal accounting', () => {
  it('charges every entry to the ledger and releases it on close', async () => {
    const before = contextMemoryStore.ledger.reservedBytes
    const target = journal()
    const entry = await append(target, 'x'.repeat(1000))
    expect(contextMemoryStore.ledger.reservedBytes).toBe(before + target.residentBytes)
    expect(target.residentBytes).toBeGreaterThanOrEqual(1000)
    target.close()
    expect(contextMemoryStore.ledger.reservedBytes).toBe(before)
    expect(await target.read(entry.ref)).toMatchObject({
      status: 'omitted',
      entry: { omitted: 'run-ended' }
    })
  })

  it('omits an entry over the run cap with a marker, and keeps its metadata', async () => {
    const target = journal()
    const entry = await append(target, 'x'.repeat(RUN_JOURNAL_MAX_BYTES + 1))
    expect(entry.omitted).toBe('over-run-cap')
    expect(entry.bytes).toBe(RUN_JOURNAL_MAX_BYTES + 1)
    const read = await target.read(entry.ref)
    expect(read).toMatchObject({ status: 'omitted', marker: journalOmissionMarker(entry) })
    expect(journalOmissionMarker(entry)).toContain('output not retained: over-run-cap')
  })

  it('stays inside the run cap by evicting oldest first', async () => {
    const target = journal()
    const size = Math.floor(RUN_JOURNAL_MAX_BYTES / 3)
    const entries = []
    for (let index = 0; index < 5; index++)
      entries.push(await append(target, 'x'.repeat(size), 'read', `c${index}`))
    expect(target.residentBytes).toBeLessThanOrEqual(RUN_JOURNAL_MAX_BYTES)
    expect((await target.read(entries[0]!.ref)).status).toBe('omitted')
    expect((await target.read(entries[4]!.ref)).status).toBe('found')
  })

  it('degrades with a marker when the context envelope cannot take it', async () => {
    configure(16)
    const target = journal()
    const entry = await append(target, 'x'.repeat(17 * 1024 * 1024))
    expect(entry.omitted).toBe('over-budget')
    expect(contextMemoryStore.overEnvelopeBytes).toBe(0)
    expect((await target.read(entry.ref)).status).toBe('omitted')
  })

  it('keeps all open runs inside the global cap', async () => {
    const size = RUN_JOURNAL_MAX_BYTES - 1024
    const runs = [journal('a'), journal('b'), journal('c')]
    for (const run of runs) await append(run, 'x'.repeat(size))
    const total = runs.reduce((sum, run) => sum + run.residentBytes, 0)
    expect(total).toBeLessThanOrEqual(GLOBAL_JOURNAL_MAX_BYTES)
    expect(runs[2]!.list()[0]?.omitted).toBe('over-budget')
  })

  it('gives memory back under pressure, leaving a marker', async () => {
    const target = journal()
    const entry = await append(target, 'x'.repeat(4096))
    contextMemoryStore.setPressureLimit(0)
    expect(target.residentBytes).toBe(0)
    expect(await target.read(entry.ref)).toMatchObject({
      status: 'omitted',
      entry: { omitted: 'memory-pressure' }
    })
  })

  it('accounts against the store it was given', async () => {
    const store = new ContextMemoryStore()
    const target = new RunJournal({ runId: 'own', taskId: 't', memoryKey: 'k' }, store)
    journals.push(target)
    const before = contextMemoryStore.ledger.reservedBytes
    await append(target, 'x'.repeat(1000))
    expect(store.ledger.reservedBytes).toBe(target.residentBytes)
    expect(contextMemoryStore.ledger.reservedBytes).toBe(before)
  })

  it('stops listening once closed', async () => {
    const target = journal()
    const entry = await append(target, 'x')
    target.close()
    contextMemoryStore.setPressureLimit(0)
    expect(entry.omitted).toBe('run-ended')
  })
})
