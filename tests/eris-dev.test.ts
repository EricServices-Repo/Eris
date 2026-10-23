import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseQuestions } from '../electron/dev/questions'
import { captureQuestion } from '../electron/dev/capture'
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.unstubAllGlobals()
})
describe('Eris-Dev question import', () => {
  it('preserves multiline JSON questions and accepts BOM, CRLF and JSONL', () => {
    expect(parseQuestions('\uFEFFfirst\r\n\r\nsecond', '.txt')).toEqual(['first', 'second'])
    expect(
      parseQuestions('[{"question":"Review code\\nRecommend improvements"}]', '.json')
    ).toEqual(['Review code\nRecommend improvements'])
    expect(parseQuestions('"first"\n{"text":"second"}', '.jsonl')).toEqual(['first', 'second'])
  })
  it('rejects invalid records and oversized batches rather than silently dropping them', () => {
    expect(() => parseQuestions('["valid",{}]', '.json')).toThrow('Question 2')
    expect(() => parseQuestions(Array(10001).fill('question').join('\n'), '.txt')).toThrow('10,000')
    expect(() => parseQuestions('', '.txt')).toThrow()
  })
})
describe('production agent request capture', () => {
  it.each([
    'Review the website build\nRecommend 5 improvements',
    'Fix division by zero in index.js'
  ])('captures %s without provider calls or source changes', async (question) => {
    const root = mkdtempSync(join(tmpdir(), 'eris-dev-capture-'))
    roots.push(root)
    const source = 'export function divide(a, b) { return a / b }\n'
    writeFileSync(join(root, 'index.js'), source)
    writeFileSync(join(root, 'package.json'), '{"name":"test-app"}')
    const fetch = vi.fn(() => {
      throw new Error('Unexpected provider/network call')
    })
    vi.stubGlobal('fetch', fetch)
    const result = await captureQuestion(
      0,
      question,
      root,
      8192,
      'agent',
      new AbortController().signal
    )
    expect(result.status, result.detail).toBe('captured')
    expect(result.requests.some((request) => request.purpose === 'agent')).toBe(true)
    expect(JSON.stringify(result.requests)).toContain(question.replaceAll('\n', '\\n'))
    expect(result.task).toBeDefined()
    expect(readFileSync(join(root, 'index.js'), 'utf8')).toBe(source)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('honors cancellation before processing a question', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eris-dev-cancel-'))
    roots.push(root)
    const controller = new AbortController()
    controller.abort()
    const result = await captureQuestion(
      0,
      'Review the code',
      root,
      8192,
      'agent',
      controller.signal
    )
    expect(result.status).toBe('cancelled')
    expect(result.requests).toHaveLength(0)
  })
})
