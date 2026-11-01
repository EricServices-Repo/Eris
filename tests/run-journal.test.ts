import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'

import {
  GLOBAL_JOURNAL_MAX_BYTES,
  JOURNAL_CHUNK_BYTES,
  RUN_JOURNAL_MAX_BYTES,
  journalBusyMarker,
  RunJournal,
  runJournalUsage,
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

describe('RunJournal admission', () => {
  const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
  /** Records the size of every reservation, and can refuse from a given size up. */
  function store(refuseFrom = Infinity) {
    const real = new ContextMemoryStore()
    real.configure(ContextMemorySettingsSchema.parse({ maxMemoryMiB: 512 }))
    const sizes: number[] = []
    const released = vi.fn()
    const reserve = real.reserve.bind(real)
    real.reserve = (key, bytes) => {
      sizes.push(bytes)
      if (bytes >= refuseFrom) return null
      const held = reserve(key, bytes)
      if (!held) return null
      const release = held.release
      held.release = () => {
        released(bytes)
        release()
      }
      return held
    }
    return { store: real, sizes, released }
  }
  const owned = (memory: ContextMemoryStore) => {
    const created = new RunJournal({ runId: 'r', taskId: 't', memoryKey: 'k' }, memory)
    journals.push(created)
    return created
  }

  it('encodes nothing for an entry that is over the run cap', async () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encodeInto')
    const from = vi.spyOn(Buffer, 'from')
    const content = 'x'.repeat(RUN_JOURNAL_MAX_BYTES + 1)
    const entry = await append(journal(), content)
    expect(encode).not.toHaveBeenCalled()
    expect(from.mock.calls.some(([value]) => value === content)).toBe(false)
    encode.mockRestore()
    from.mockRestore()
    expect(entry).toMatchObject({ omitted: 'over-run-cap', bytes: content.length })
    expect(entry.contentDigest).toBe(sha(content))
  })

  it('encodes nothing when the store refuses the entry', async () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encodeInto')
    const { store: memory } = store(1)
    const entry = await append(owned(memory), 'refused content')
    expect(entry.omitted).toBe('over-budget')
    expect(encode).not.toHaveBeenCalled()
    encode.mockRestore()
  })

  it('reserves before it encodes', async () => {
    const order: string[] = []
    const { store: memory } = store()
    const reserve = memory.reserve.bind(memory)
    memory.reserve = (key, bytes) => (order.push('reserve'), reserve(key, bytes))
    const encode = vi
      .spyOn(TextEncoder.prototype, 'encodeInto')
      .mockImplementationOnce((text, into) => {
        order.push('encode')
        encode.mockRestore()
        return new TextEncoder().encodeInto(text, into)
      })
    await append(owned(memory), 'admitted content')
    expect(order).toEqual(['reserve', 'encode'])
  })

  it('returns the reservation and keeps the marker if encoding fails', async () => {
    const { store: memory, released } = store()
    const target = owned(memory)
    const encode = vi.spyOn(TextEncoder.prototype, 'encodeInto').mockImplementationOnce(() => {
      throw new RangeError('Array buffer allocation failed')
    })
    const entry = await append(target, 'lost to allocation')
    encode.mockRestore()
    expect(entry.omitted).toBe('memory-pressure')
    expect(released).toHaveBeenCalledTimes(1)
    expect(target.residentBytes).toBe(0)
    expect(await target.read(entry.ref)).toMatchObject({ status: 'omitted' })
  })

  it.each([
    ['ascii', 'a'.repeat(3 * 1024 * 1024)],
    ['a pair across every chunk', '🙂'.repeat(1024 * 1024)],
    ['wide text over a slice edge', `${'a'.repeat(256 * 1024 - 1)}🙂${'é'.repeat(300_000)}`],
    ['a pair across a chunk edge', `${'a'.repeat(JOURNAL_CHUNK_BYTES - 1)}🙂tail`],
    ['a lone surrogate', `before\ud83dafter`],
    ['empty', '']
  ])('keeps exact bytes for %s', async (_name, content) => {
    const target = journal()
    const entry = await append(target, content)
    const encoded = Buffer.from(content, 'utf8')
    expect(entry.bytes).toBe(encoded.length)
    expect(entry.contentDigest).toBe(sha(content))
    const read = await target.read(entry.ref)
    expect(read.status).toBe('found')
    if (read.status === 'found')
      expect(Buffer.from(read.content, 'utf8').equals(encoded)).toBe(true)
  })

  it('splits what it keeps into bounded chunks', async () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encodeInto')
    await append(journal(), 'a'.repeat(JOURNAL_CHUNK_BYTES * 3 + 5))
    expect(encode.mock.calls).toHaveLength(4)
    for (const [, into] of encode.mock.calls)
      expect(into.length).toBeLessThanOrEqual(JOURNAL_CHUNK_BYTES)
    encode.mockRestore()
  })
})

describe('RunJournal read scratch', () => {
  const memoryWith = (refuse: (bytes: number) => boolean) => {
    const memory = new ContextMemoryStore()
    memory.configure(ContextMemorySettingsSchema.parse({ maxMemoryMiB: 512 }))
    const sizes: number[] = []
    const reserve = memory.reserve.bind(memory)
    memory.reserve = (key, bytes) => {
      sizes.push(bytes)
      return refuse(bytes) ? null : reserve(key, bytes)
    }
    const target = new RunJournal({ runId: 'r', taskId: 't', memoryKey: 'k' }, memory)
    journals.push(target)
    return { memory, sizes, target }
  }

  it('charges decoded text to the ledger and gives it back', async () => {
    const { memory, sizes, target } = memoryWith(() => false)
    const entry = await append(target, 'é'.repeat(1_000))
    const before = memory.reservedBytes
    expect((await target.read(entry.ref)).status).toBe('found')
    expect(sizes.at(-1)).toBe(entry.bytes * 2)
    expect(memory.reservedBytes).toBe(before)
  })

  it('says the entry is held, rather than decoding without admission', async () => {
    let tight = false
    const { target } = memoryWith(() => tight)
    const entry = await append(target, 'kept content')
    tight = true
    expect(await target.read(entry.ref)).toEqual({
      status: 'busy',
      entry,
      marker: journalBusyMarker(entry)
    })
    tight = false
    expect(await target.read(entry.ref)).toMatchObject({ status: 'found' })
  })

  it('search still finds a busy entry by metadata and never decodes it', async () => {
    let tight = false
    const { target, memory } = memoryWith(() => tight)
    await target.append({ toolName: 'grep', toolCallId: 'c', args: {}, content: 'needle' })
    tight = true
    const before = memory.reservedBytes
    const hits = await target.search('grep needle', 5)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.snippet).toContain('memory is too tight')
    expect(memory.reservedBytes).toBe(before)
  })

  it('releases scratch when work on the decoded text throws', async () => {
    const { target, memory } = memoryWith(() => false)
    const entry = await append(target, 'content')
    const before = memory.reservedBytes
    const internal = target as unknown as {
      resident: Map<string, unknown>
      withText: (e: unknown, r: unknown, n: number, use: () => void) => void
    }
    expect(() =>
      internal.withText(entry, internal.resident.get(entry.ref), 2, () => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(memory.reservedBytes).toBe(before)
  })

  it('reserves for every copy search holds', async () => {
    const { sizes, target } = memoryWith(() => false)
    const entry = await append(target, 'find this')
    await target.search('find', 5)
    expect(sizes.at(-1)).toBe(entry.bytes * 6)
  })
})

describe('active journal telemetry (#236)', () => {
  it('reports scoped live usage and drops closed runs without retaining text', async () => {
    const first = journal('telemetry-a')
    const other = journal('telemetry-b')
    await append(first, 'receipt evidence')
    await append(other, 'unrelated evidence')
    await first.search('receipt', 2)
    expect(runJournalUsage('key-telemetry-a')).toMatchObject({ searches: 1, runs: 1, evicted: 0 })
    expect(runJournalUsage('key-telemetry-a').bytes).toBe(first.residentBytes)
    expect(JSON.stringify(runJournalUsage())).not.toContain('receipt evidence')
    first.close()
    expect(runJournalUsage('key-telemetry-a')).toEqual({
      bytes: 0,
      searches: 0,
      evicted: 0,
      runs: 0
    })
  })
})
