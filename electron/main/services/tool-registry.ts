/** OpenAI-compatible function tool definitions for Composer Full. */

export type OpenAIToolDef = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const pathProp = { type: 'string', description: 'Path relative to workspace root' }

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): OpenAIToolDef {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        required,
        additionalProperties: true
      }
    }
  }
}

/** Built-in workspace tools exposed via native tool calling. */
export const COMPOSER_OPENAI_TOOLS: OpenAIToolDef[] = [
  tool('tree', 'List a directory tree', { path: pathProp, maxDepth: { type: 'number' } }, [
    'path'
  ]),
  tool('list_dir', 'List directory entries', { path: pathProp }, ['path']),
  tool('read_file', 'Read a text file', { path: pathProp }, ['path']),
  tool(
    'search_replace',
    'Surgical edit: replace exact text in a file',
    {
      path: pathProp,
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' }
    },
    ['path', 'old_string', 'new_string']
  ),
  tool('apply_patch', 'Apply a unified/V4A patch', { patch: { type: 'string' } }, ['patch']),
  tool('write_file', 'Create or overwrite a file', { path: pathProp, content: { type: 'string' } }, [
    'path',
    'content'
  ]),
  tool('mkdir', 'Create a directory', { path: pathProp }, ['path']),
  tool('delete_path', 'Delete a file or directory', { path: pathProp }, ['path']),
  tool('rename_path', 'Rename or move a path', { path: pathProp, to: pathProp }, ['path', 'to']),
  tool('run', 'Run a shell command in the workspace', { command: { type: 'string' } }, [
    'command'
  ]),
  tool('grep', 'Search file contents', {
    pattern: { type: 'string' },
    glob: { type: 'string' }
  }, ['pattern']),
  tool('glob', 'Find files by path pattern', { pattern: { type: 'string' } }, ['pattern']),
  tool('search_symbols', 'Search the code symbol index', { query: { type: 'string' } }, [
    'query'
  ]),
  tool('find_references', 'Find definitions and references of a symbol', { name: { type: 'string' } }, [
    'name'
  ]),
  tool('semantic_search', 'Find files related to a natural-language query (embeddings + keywords)', {
    query: { type: 'string' }
  }, ['query']),
  tool('related_files', 'Files that share symbols with a path', { path: pathProp }, ['path']),
  tool('retrieve', 'Rank relevant files for a query', { query: { type: 'string' } }, ['query']),
  tool('read_context', 'Read workspace .eris/context.md notes', {}),
  tool(
    'update_context',
    'Append or set workspace context notes',
    {
      mode: { type: 'string', enum: ['append', 'summary'] },
      text: { type: 'string' }
    },
    ['mode', 'text']
  ),
  tool('git_status', 'Git status', {}),
  tool('git_diff', 'Git diff', { path: pathProp }),
  tool(
    'git_stage',
    'Stage paths',
    { paths: { type: 'array', items: { type: 'string' } } },
    ['paths']
  ),
  tool('git_commit', 'Create a commit', { message: { type: 'string' } }, ['message']),
  tool(
    'git_sync',
    'Fetch, pull, or push',
    { action: { type: 'string', enum: ['fetch', 'pull', 'push'] } },
    ['action']
  ),
  tool(
    'git_stash',
    'Stash push/pop/list',
    {
      action: { type: 'string', enum: ['push', 'pop', 'list'] },
      message: { type: 'string' }
    },
    ['action']
  ),
  tool('list_skills', 'List user and project skills with paths', {}),
  tool(
    'read_skill',
    'Read a skill by id',
    {
      id: { type: 'string' },
      scope: { type: 'string', enum: ['user', 'workspace'] }
    },
    ['id']
  ),
  tool(
    'write_skill',
    'Create or update a skill. Default scope is user (outside the project).',
    {
      skill_name: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      body: { type: 'string' },
      id: { type: 'string' },
      scope: { type: 'string', enum: ['user', 'workspace'] }
    },
    ['body']
  ),
  tool(
    'delegate_to_agent',
    'Spawn a specialist background agent with a structured handoff (orchestrator).',
    {
      agent_id: {
        type: 'string',
        description: 'Specialist id: coder | explainer | reviewer | fast (or project agent id)'
      },
      goal: { type: 'string', description: 'Concrete goal for the specialist' },
      summary: { type: 'string', description: 'Context the specialist needs' },
      files: { type: 'array', items: { type: 'string' } },
      open_questions: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number' },
      claim: { type: 'string', description: 'Short blackboard claim line' },
      wait: {
        type: 'boolean',
        description: 'If true, wait for this child (and siblings) before continuing'
      }
    },
    ['agent_id', 'goal', 'summary']
  ),
  tool(
    'await_children',
    'Wait for delegated child agents to finish and return their results.',
    {
      timeout_ms: {
        type: 'number',
        description: 'Max wait in ms (default 600000)'
      }
    },
    []
  )
]

/**
 * A permissive JSON schema describing a single tool call, for grammar-constrained
 * decoding on the local GGUF model. Forces valid JSON with a known tool name and
 * scalar arguments, so Composer Lite can't emit malformed/partial tool calls.
 * Used only on retries where a tool is required (never when a prose answer is OK).
 */
export function toolCallJsonSchema(extraNames: string[] = []): Record<string, unknown> {
  const names = [
    ...COMPOSER_OPENAI_TOOLS.map((t) => t.function.name),
    ...extraNames
  ].filter(Boolean)
  return {
    type: 'object',
    properties: {
      name: { enum: Array.from(new Set(names)) }
    },
    additionalProperties: { type: ['string', 'number', 'boolean'] }
  }
}

export function mcpToolsToOpenAI(
  tools: Array<{ fqName: string; description?: string }>
): OpenAIToolDef[] {
  return tools.map((t) =>
    tool(
      t.fqName,
      t.description || `MCP tool ${t.fqName}`,
      {},
      []
    )
  )
}
