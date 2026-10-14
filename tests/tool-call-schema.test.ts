import { describe, expect, it } from 'vitest'
import { COMPOSER_OPENAI_TOOLS, toolCallJsonSchema } from '../electron/main/services/tool-registry'

describe('tool-call grammar schema', () => {
  it('constrains name to the known tool set plus any MCP tools', () => {
    const schema = toolCallJsonSchema(['mcp__demo__do_thing'])
    const props = schema.properties as { name: { enum: string[] } }
    expect(props.name.enum).toContain('write_file')
    expect(props.name.enum).toContain('read_file')
    expect(props.name.enum).toContain('run')
    expect(props.name.enum).toContain('mcp__demo__do_thing')
    expect(props.name.enum.length).toBe(COMPOSER_OPENAI_TOOLS.length + 1)
  })

  it('allows only scalar argument values', () => {
    const schema = toolCallJsonSchema()
    expect(schema.type).toBe('object')
    const addl = schema.additionalProperties as { type: string[] }
    expect(addl.type).toEqual(['string', 'number', 'boolean'])
  })

  it('deduplicates tool names', () => {
    const schema = toolCallJsonSchema(['write_file'])
    const props = schema.properties as { name: { enum: string[] } }
    expect(props.name.enum.length).toBe(COMPOSER_OPENAI_TOOLS.length)
  })
})
