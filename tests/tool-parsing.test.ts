import { describe, expect, it } from 'vitest'
import {
  argString,
  extractBalancedJsonObjects,
  hasExecutableToolCall,
  parseJsonObject,
  parseToolCalls,
  stripToolBlocks,
  thinkingBeforeTools
} from '../electron/main/services/agent-runner'

describe('parseToolCalls', () => {
  it('parses <<<TOOL>>> blocks', () => {
    const calls = parseToolCalls('Let me look.\n<<<TOOL>>>\n{"name":"tree","path":"."}\n<<<END>>>')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('tree')
    expect(argString(calls[0]!.args, 'path')).toBe('.')
  })

  it('parses json fences', () => {
    const calls = parseToolCalls('```json\n{"name":"read_file","path":"src/a.ts"}\n```')
    expect(calls.map((c) => c.name)).toEqual(['read_file'])
  })

  it('parses multiple calls in order', () => {
    const text =
      '<<<TOOL>>>{"name":"mkdir","path":"src"}<<<END>>>\n' +
      '<<<TOOL>>>{"name":"write_file","path":"src/a.ts","content":"x"}<<<END>>>'
    expect(parseToolCalls(text).map((c) => c.name)).toEqual(['mkdir', 'write_file'])
  })

  it('ignores prose without tool calls', () => {
    expect(parseToolCalls('I would call tree next.')).toEqual([])
    expect(hasExecutableToolCall('Done. All tests pass.')).toBe(false)
  })

  it('hides a tool payload from the thinking text', () => {
    expect(
      thinkingBeforeTools(
        'read_file README.md\n{"name":"write_file","path":"App.js","content":"x"}'
      )
    ).toBe('read_file README.md')
  })

  it('keeps braces inside string content', () => {
    const calls = parseToolCalls(
      '<<<TOOL>>>{"name":"write_file","path":"a.js","content":"function f() { return \\"}\\" }"}<<<END>>>'
    )
    expect(calls).toHaveLength(1)
    expect(argString(calls[0]!.args, 'content')).toContain('return "}"')
  })
})

describe('stripToolBlocks', () => {
  it('removes tool blocks but keeps prose', () => {
    const out = stripToolBlocks('Before\n<<<TOOL>>>{"name":"tree"}<<<END>>>\nAfter')
    expect(out).toContain('Before')
    expect(out).toContain('After')
    expect(out).not.toContain('<<<TOOL>>>')
  })
})

describe('JSON helpers', () => {
  it('extracts balanced objects from noisy text', () => {
    expect(extractBalancedJsonObjects('x {"a":1} y {"b":{"c":2}} z')).toEqual([
      '{"a":1}',
      '{"b":{"c":2}}'
    ])
  })

  it('parseJsonObject rejects arrays and garbage', () => {
    expect(parseJsonObject('[1,2]')).toBeNull()
    expect(parseJsonObject('nope')).toBeNull()
    expect(parseJsonObject('prefix {"ok":true}')).toEqual({ ok: true })
  })
})
