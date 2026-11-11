import { describe, expect, it } from 'vitest'
import {
  argString,
  extractBalancedJsonObjects,
  hasExecutableToolCall,
  parseJsonObject,
  parseToolCalls,
  stripToolBlocks,
  thinkingBeforeTools,
  proseOutsideTools,
  postedAnswer
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

  it('does not treat a tool log as the reply', () => {
    expect(
      postedAnswer(
        'Finished: Review the internet\n\nWhat I did:\n• Inspected .\n• Failed read_file steve-embling/.eris/rules/README.md',
        'Steve Embling is the person named in the public pages that were opened.'
      )
    ).toContain('Steve Embling')
  })

  it('keeps the full reply that follows a tool call', () => {
    const text =
      '<<<TOOL>>>\n{"name":"read_file","path":"README.md"}\n<<<END>>>\n\n' +
      'This project is a calculator. src/main.ts adds numbers and src/App.tsx draws the keypad.'
    expect(proseOutsideTools(text)).toContain('This project is a calculator')
    expect(postedAnswer(text, 'Finished: task\n\nWhat I did:\n• Inspected .')).toContain(
      'src/App.tsx'
    )
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

describe('narrated fenced tool calls (#506)', () => {
  const T2 =
    'I created hello.html with the heading and the button. Next, I will run a cat command to verify.\n\n```json\n{"name":"run","arguments":{"command":"cat hello.html"}}\n```'

  it('executes one fenced envelope announced by the prose before it', () => {
    const calls = parseToolCalls(T2)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('run')
    expect(argString(calls[0]!.args, 'command')).toBe('cat hello.html')
    expect(stripToolBlocks(T2)).not.toMatch(/"name"/)
    expect(proseOutsideTools(T2)).toMatch(/^I created hello\.html/)
  })

  it.each([
    ['documentation without an intent phrase', 'To list files, the agent sends:\n```json\n{"name":"tree","path":"."}\n```'],
    ['prose after the fence', "I'll run this:\n```json\n{\"name\":\"run\",\"command\":\"ls\"}\n```\nThis is how it works."],
    ['two fences', "I'll run these:\n```json\n{\"name\":\"run\",\"command\":\"ls\"}\n```\n```json\n{\"name\":\"tree\",\"path\":\".\"}\n```"],
    ['an unknown tool name', 'Let me save the user:\n```json\n{"name":"Alice","age":3}\n```'],
    ['long prose', `${'This page explains the protocol. '.repeat(15)}I'll show one:\n\`\`\`json\n{"name":"tree","path":"."}\n\`\`\``]
  ])('keeps %s as an example', (_label, text) => {
    expect(parseToolCalls(text)).toHaveLength(0)
    expect(stripToolBlocks(text)).toContain('```')
  })
})
