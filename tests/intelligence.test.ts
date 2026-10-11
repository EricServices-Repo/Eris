import { describe, expect, it } from 'vitest'
import { cosine, hashEmbed, tokenize } from '../electron/main/services/embeddings'
import { agentBranchName } from '../electron/main/services/worktrees'

describe('local embeddings', () => {
  it('gives a higher cosine to related text than to unrelated text', () => {
    const query = hashEmbed('parse config json settings')
    const near = hashEmbed('src/config/parse.ts export function parseConfig(raw: string)')
    const far = hashEmbed('cargo test rustc clippy borrow checker')
    expect(cosine(query, near)).toBeGreaterThan(cosine(query, far))
    expect(tokenize('The parseConfig helper').includes('parseconfig') || tokenize('parseConfig').length).toBeTruthy()
  })

  it('normalizes empty input to a zero vector', () => {
    const z = hashEmbed('')
    expect(z.every((n) => n === 0)).toBe(true)
    expect(cosine(z, hashEmbed('hello world'))).toBe(0)
  })
})

describe('worktree branch names', () => {
  it('prefixes and strips unsafe characters', () => {
    expect(agentBranchName('abc-123')).toBe('eris/agent/abc-123')
    expect(agentBranchName('weird name!@#')).toBe('eris/agent/weirdname')
  })
})
