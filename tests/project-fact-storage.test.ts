import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const h = vi.hoisted(() => ({ root: '', failRename: false }))
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>()
  return {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (h.failRename) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
      return actual.renameSync(from, to)
    }
  }
})
vi.mock('../electron/main/services/paths', async (original) => ({
  ...(await original<object>()),
  userDataRoot: () => h.root
}))

import {
  activeProjectFacts,
  listProjectFacts,
  promoteProjectFact,
  revokeProjectFact
} from '../electron/main/services/project-facts'
import {
  PROJECT_FACTS_MAX_ACTIVE,
  PROJECT_FACTS_MAX_FILE_BYTES,
  PROJECT_FACTS_MAX_HISTORY
} from '../src/shared/project-facts'

h.root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'eris-fact-store-')))
const dir = join(h.root, 'project-facts')
const file = join(dir, 'w.json')
afterAll(() => fs.rmSync(h.root, { recursive: true, force: true }))
beforeEach(() => fs.rmSync(dir, { recursive: true, force: true }))
afterEach(() => {
  h.failRename = false
  vi.useRealTimers()
})

let clock = 1_000
const promote = (text: string, supersedes?: string) => {
  vi.setSystemTime(++clock)
  return promoteProjectFact({
    workspaceId: 'w',
    threadId: 't',
    pin: { id: 'p', text },
    supersedes
  })
}
const revoke = (id: string) => {
  vi.setSystemTime(++clock)
  return revokeProjectFact('w', id)
}

describe('project fact storage (#328)', () => {
  it('accepts a promotion when the file already holds the most rows it may', () => {
    // A store written before history was bounded: 999 revoked rows and one active one.
    const row = (i: number, status: 'active' | 'revoked') => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      text: `Fact ${i}`,
      provenance: { kind: 'user-promoted', threadId: 't', pinId: 'p' },
      promotedAt: i,
      status,
      ...(status === 'revoked' ? { endedAt: i + 1 } : {})
    })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        facts: Array.from({ length: 1000 }, (_, i) => row(i, i === 0 ? 'active' : 'revoked'))
      })
    )
    const fact = promote('Promotable again')
    const facts = listProjectFacts('w')
    expect(activeProjectFacts('w').map((item) => item.text)).toEqual(['Fact 0', fact.text])
    expect(facts.filter((item) => item.status === 'revoked')).toHaveLength(
      PROJECT_FACTS_MAX_HISTORY
    )
    // The most recently ended rows are the ones kept.
    expect(facts.some((item) => item.text === 'Fact 999')).toBe(true)
    expect(facts.some((item) => item.text === 'Fact 1')).toBe(false)
  })

  it('bounds history under real churn and keeps the newest of it', () => {
    vi.useFakeTimers()
    const keep = promote('Keep: the API is versioned under /v2')
    for (let i = 0; i < PROJECT_FACTS_MAX_HISTORY + 50; i++)
      expect(revoke(promote(`Churn ${i}`).id)).toBe(true)
    let previous = promote('Old naming rule')
    for (let i = 0; i < 50; i++) previous = promote(`Naming rule ${i}`, previous.id)
    const fresh = promote('Still promotable')

    const facts = listProjectFacts('w')
    const ended = facts.filter((fact) => fact.status !== 'active')
    expect(ended).toHaveLength(PROJECT_FACTS_MAX_HISTORY)
    expect(activeProjectFacts('w').map((fact) => fact.id)).toEqual([keep.id, previous.id, fresh.id])
    // The newest history survives, including the supersede chain that led to the
    // current rule; the oldest churn is what was pruned.
    expect(ended.some((fact) => fact.text === 'Naming rule 48')).toBe(true)
    expect(ended.find((fact) => fact.text === 'Naming rule 48')?.supersededBy).toBe(previous.id)
    expect(facts.some((fact) => fact.text === 'Churn 0')).toBe(false)
    expect(facts.some((fact) => fact.text === 'Churn 249')).toBe(true)
  })

  it('still caps active facts after pruning', () => {
    for (let i = 0; i < PROJECT_FACTS_MAX_ACTIVE; i++) promote(`Fact ${i}`)
    expect(() => promote('One more')).toThrow(/Revoke one first/)
  })

  it.each([
    ['not JSON', 'not json', /not valid JSON/],
    [
      'hand-edited',
      JSON.stringify({ version: 1, facts: [{ id: 'x', text: 'y' }] }),
      /expected format/
    ]
  ])('refuses to change a %s file and leaves it as it was', (_label, content, reason) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, content)
    expect(activeProjectFacts('w')).toEqual([])
    expect(() => promote('New fact')).toThrow(reason)
    expect(() => promote('New fact')).toThrow(/nothing was changed[\s\S]*Fix or move it/)
    expect(() => revokeProjectFact('w', '00000000-0000-4000-8000-000000000000')).toThrow(
      /could not be read/
    )
    expect(fs.readFileSync(file, 'utf8')).toBe(content)
  })

  it('does not decode an oversized file', () => {
    promote('A real fact')
    fs.appendFileSync(file, ' '.repeat(PROJECT_FACTS_MAX_FILE_BYTES))
    const before = fs.statSync(file).size
    expect(activeProjectFacts('w')).toEqual([])
    expect(() => promote('Another')).toThrow(/larger than 8 MiB/)
    expect(fs.statSync(file).size).toBe(before)
  })

  it('keeps the previous facts and no staging file when a save fails', () => {
    const first = promote('First fact')
    const before = fs.readFileSync(file, 'utf8')
    h.failRename = true
    expect(() => promote('Second fact')).toThrow(
      'Project facts could not be saved (ENOSPC). The previous facts were kept.'
    )
    expect(() => revokeProjectFact('w', first.id)).toThrow(/could not be saved/)
    h.failRename = false
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readdirSync(dir)).toEqual(['w.json'])
    expect(activeProjectFacts('w').map((fact) => fact.text)).toEqual(['First fact'])
  })
})
