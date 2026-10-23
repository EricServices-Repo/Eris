/** OpenAI-compatible function tool definitions for Composer Full. */

export type OpenAIToolDef = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ToolAccess = 'read' | 'edit' | 'full'
export type ToolEffect = 'read' | 'workspace' | 'external' | 'command' | 'orchestration'
export type ToolApproval = 'none' | 'command' | 'push' | 'mcp'
export type ToolDiscovery = 'core' | 'deferred'

export type ToolContract = {
  access: ToolAccess
  effect: ToolEffect
  approval: ToolApproval
  discovery: ToolDiscovery
  /** Existing workspace targets must be read through the matching tool this turn before mutation. */
  readBeforeWrite?: 'file' | 'notebook'
  schema?: Record<string, unknown>
}
type ToolBuildOptions = Partial<Omit<ToolContract, 'schema'>> & {
  requiredAnyOf?: string[][]
}

/** Keep the prompt focused when an MCP connection exposes a large catalog. */
export const MAX_INLINE_MCP_TOOLS = 18

const pathProp = { type: 'string', description: 'Path relative to workspace root' }
const toolContracts = new Map<string, ToolContract>()

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  contract: ToolBuildOptions = {}
): OpenAIToolDef {
  const schema = {
    type: 'object',
    properties,
    required,
    ...(contract.requiredAnyOf?.length
      ? { anyOf: contract.requiredAnyOf.map((fields) => ({ required: fields })) }
      : {}),
    additionalProperties: false
  }
  toolContracts.set(name, {
    access: contract.access ?? 'read',
    effect: contract.effect ?? 'read',
    approval: contract.approval ?? 'none',
    discovery: contract.discovery ?? 'core',
    ...(contract.readBeforeWrite ? { readBeforeWrite: contract.readBeforeWrite } : {}),
    schema
  })
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: schema
    }
  }
}

export function getToolContract(name: string): ToolContract | undefined {
  return toolContracts.get(name)
}

/** Built-in workspace tools exposed via native tool calling. */
export const COMPOSER_OPENAI_TOOLS: OpenAIToolDef[] = [
  tool(
    'generate_image',
    'Generate a PNG image using the configured local Hugging Face model or image API automatically and save it to a NEW workspace path. Never use write_file for binary images. The provider must be enabled in Settings. Existing files are never overwritten.',
    {
      prompt: { type: 'string', minLength: 1, maxLength: 16000 },
      path: pathProp,
      size: {
        type: 'string',
        enum: ['512x512', '768x512', '512x768', '1024x1024', '1536x1024', '1024x1536']
      }
    },
    ['prompt', 'path'],
    { access: 'edit', effect: 'workspace' }
  ),
  tool('tree', 'List a directory tree', { path: pathProp, maxDepth: { type: 'number' } }, ['path']),
  tool('list_dir', 'List directory entries', { path: pathProp }, ['path']),
  tool(
    'read_file',
    'Read a text file; use line ranges to inspect large files',
    {
      path: pathProp,
      start_line: { type: 'integer', minimum: 1 },
      end_line: { type: 'integer', minimum: 1 }
    },
    ['path']
  ),
  tool(
    'notebook_read',
    'Read a Jupyter notebook as indexed cells with compact text outputs',
    {
      path: pathProp,
      cell_index: { type: 'integer', description: 'Optional zero-based cell to read by itself' }
    },
    ['path'],
    { discovery: 'deferred' }
  ),
  tool(
    'notebook_edit',
    'Edit one Jupyter notebook cell. Read the existing notebook with notebook_read first. Replacing code clears stale execution outputs.',
    {
      path: pathProp,
      operation: {
        type: 'string',
        enum: ['replace_source', 'insert_before', 'insert_after', 'delete']
      },
      cell_index: { type: 'integer', description: 'Zero-based cell index' },
      source: { type: 'string', description: 'Cell source for replace or insert operations' },
      cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'] }
    },
    ['path', 'operation', 'cell_index'],
    { access: 'edit', effect: 'workspace', discovery: 'deferred', readBeforeWrite: 'notebook' }
  ),
  tool(
    'search_replace',
    'Surgical edit: read the existing file with read_file first, then replace exact text',
    {
      path: pathProp,
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      newString: { type: 'string' },
      oldString: { type: 'string' },
      replace_all: { type: 'boolean' },
      replaceAll: { type: 'boolean' }
    },
    ['path'],
    {
      access: 'edit',
      effect: 'workspace',
      readBeforeWrite: 'file',
      requiredAnyOf: [
        ['old_string', 'new_string'],
        ['old_string', 'newString'],
        ['oldString', 'new_string'],
        ['oldString', 'newString']
      ]
    }
  ),
  tool(
    'apply_patch',
    'Apply a unified/V4A patch. Read an existing target file with read_file first.',
    { patch: { type: 'string' }, diff: { type: 'string' } },
    [],
    {
      access: 'edit',
      effect: 'workspace',
      readBeforeWrite: 'file',
      requiredAnyOf: [['patch'], ['diff']]
    }
  ),
  tool(
    'write_file',
    'Create a file, or overwrite an existing file after reading it with read_file',
    { path: pathProp, content: { type: 'string' } },
    ['path', 'content'],
    { access: 'edit', effect: 'workspace', readBeforeWrite: 'file' }
  ),
  tool('mkdir', 'Create a directory', { path: pathProp }, ['path'], {
    access: 'edit',
    effect: 'workspace'
  }),
  tool('delete_path', 'Delete a file or directory', { path: pathProp }, ['path'], {
    access: 'edit',
    effect: 'workspace'
  }),
  tool('rename_path', 'Rename or move a path', { path: pathProp, to: pathProp }, ['path', 'to'], {
    access: 'edit',
    effect: 'workspace'
  }),
  tool(
    'run',
    'Run a shell command in the selected project',
    {
      command: { type: 'string' },
      cwd: {
        type: 'string',
        description: 'Directory relative to the workspace; defaults to the task project'
      }
    },
    ['command'],
    { access: 'full', effect: 'command', approval: 'command' }
  ),
  tool(
    'grep',
    'Search file contents',
    {
      pattern: { type: 'string' },
      query: { type: 'string' },
      glob: { type: 'string' }
    },
    [],
    { requiredAnyOf: [['pattern'], ['query']] }
  ),
  tool('glob', 'Find files by path pattern', { pattern: { type: 'string' } }, ['pattern']),
  tool(
    'search_symbols',
    'Search the code symbol index',
    { query: { type: 'string' }, pattern: { type: 'string' } },
    [],
    { requiredAnyOf: [['query'], ['pattern']], discovery: 'deferred' }
  ),
  tool(
    'find_references',
    'Find definitions and references of a symbol',
    { symbol: { type: 'string' }, name: { type: 'string' }, query: { type: 'string' } },
    [],
    { requiredAnyOf: [['symbol'], ['name'], ['query']], discovery: 'deferred' }
  ),
  tool(
    'lsp',
    'Query the configured Language Server for precise symbol information at a file position',
    {
      action: { type: 'string', enum: ['hover', 'definition', 'references', 'completion'] },
      path: pathProp,
      line: { type: 'integer', description: 'One-based line number' },
      character: { type: 'integer', description: 'One-based character column' }
    },
    ['action', 'path', 'line', 'character'],
    { discovery: 'deferred' }
  ),
  tool(
    'semantic_search',
    'Find files related to a natural-language query (embeddings + keywords)',
    {
      query: { type: 'string' },
      pattern: { type: 'string' }
    },
    [],
    { requiredAnyOf: [['query'], ['pattern']], discovery: 'deferred' }
  ),
  tool(
    'related_files',
    'Files that share symbols with a path',
    { path: pathProp, file: pathProp },
    [],
    { requiredAnyOf: [['path'], ['file']], discovery: 'deferred' }
  ),
  tool(
    'retrieve',
    'Rank relevant files for a query',
    { query: { type: 'string' }, pattern: { type: 'string' } },
    [],
    { requiredAnyOf: [['query'], ['pattern']] }
  ),
  tool(
    'web_search',
    'Search the public web in a browser and return titles, links, and snippets',
    { query: { type: 'string', description: 'Search words, not a URL' } },
    ['query']
  ),
  tool(
    'web_open',
    'Open an https page in the browser and read its text',
    { url: { type: 'string', description: 'https address to open' } },
    ['url']
  ),
  tool(
    'search_tools',
    'Search Eris built-in and connected MCP tools; matching tools become available on the next step',
    { query: { type: 'string', description: 'Tool capability, file type, or workflow to find' } },
    ['query'],
    { access: 'read', effect: 'read' }
  ),
  tool(
    'search_mcp_tools',
    'Search a large connected MCP tool catalog; matching tools become available on the next step',
    { query: { type: 'string', description: 'Integration or capability to find' } },
    ['query'],
    { access: 'read', effect: 'read' }
  ),
  tool('read_context', 'Read workspace .eris/context.md notes', {}),
  tool(
    'update_context',
    'Append or set workspace context notes',
    {
      mode: { type: 'string', enum: ['append', 'summary', 'set_summary'] },
      text: { type: 'string' },
      content: { type: 'string' },
      note: { type: 'string' }
    },
    [],
    {
      access: 'edit',
      effect: 'workspace',
      discovery: 'deferred',
      requiredAnyOf: [['text'], ['content'], ['note']]
    }
  ),
  tool('git_status', 'Git status', {}),
  tool('git_diff', 'Git diff', { path: pathProp }),
  tool(
    'git_stage',
    'Stage paths',
    { paths: { type: 'array', items: { type: 'string' } }, path: { type: 'string' } },
    [],
    {
      access: 'edit',
      effect: 'workspace',
      discovery: 'deferred',
      requiredAnyOf: [['paths'], ['path']]
    }
  ),
  tool('git_commit', 'Create a commit', { message: { type: 'string' } }, ['message'], {
    access: 'edit',
    effect: 'workspace',
    discovery: 'deferred'
  }),
  tool(
    'git_sync',
    'Fetch, pull, or push',
    { action: { type: 'string', enum: ['fetch', 'pull', 'push'] } },
    ['action'],
    { access: 'full', effect: 'external', approval: 'push', discovery: 'deferred' }
  ),
  tool(
    'git_stash',
    'Stash push/pop/list',
    {
      action: { type: 'string', enum: ['push', 'pop', 'list'] },
      message: { type: 'string' }
    },
    ['action'],
    { access: 'edit', effect: 'workspace', discovery: 'deferred' }
  ),
  tool('list_skills', 'List user and project skills with paths', {}, [], { discovery: 'deferred' }),
  tool(
    'read_skill',
    'Read a skill by id',
    {
      id: { type: 'string' },
      skill_id: { type: 'string' },
      name: { type: 'string' },
      scope: { type: 'string', enum: ['user', 'workspace'] }
    },
    [],
    { requiredAnyOf: [['id'], ['skill_id'], ['name']], discovery: 'deferred' }
  ),
  tool(
    'write_skill',
    'Create or update a skill. Default scope is user (outside the project).',
    {
      skill_name: { type: 'string' },
      name: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      desc: { type: 'string' },
      body: { type: 'string' },
      content: { type: 'string' },
      instructions: { type: 'string' },
      id: { type: 'string' },
      skill_id: { type: 'string' },
      scope: { type: 'string', enum: ['user', 'workspace'] }
    },
    [],
    {
      access: 'edit',
      effect: 'external',
      discovery: 'deferred',
      requiredAnyOf: [
        ['skill_name', 'body'],
        ['skill_name', 'content'],
        ['skill_name', 'instructions'],
        ['name', 'body'],
        ['name', 'content'],
        ['name', 'instructions'],
        ['title', 'body'],
        ['title', 'content'],
        ['title', 'instructions']
      ]
    }
  ),
  tool(
    'delegate_to_agent',
    'Spawn a specialist background agent with a structured handoff (orchestrator).',
    {
      agent_id: {
        type: 'string',
        description: 'Specialist id: coder | explainer | reviewer | fast (or project agent id)'
      },
      agentId: { type: 'string' },
      goal: { type: 'string', description: 'Concrete goal for the specialist' },
      summary: { type: 'string', description: 'Context the specialist needs' },
      files: { type: 'array', items: { type: 'string' } },
      open_questions: { type: 'array', items: { type: 'string' } },
      openQuestions: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number' },
      claim: { type: 'string', description: 'Short blackboard claim line' },
      wait: {
        type: 'boolean',
        description: 'If true, wait for this child (and siblings) before continuing'
      }
    },
    ['goal'],
    {
      access: 'full',
      effect: 'orchestration',
      discovery: 'deferred',
      requiredAnyOf: [['agent_id'], ['agentId']]
    }
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
    [],
    { access: 'full', effect: 'orchestration', discovery: 'deferred' }
  ),
  tool(
    'ask_user',
    'Ask the user a short clarifying question before continuing. Wait up to five minutes for an inline reply; if there is no reply, proceed with best judgment.',
    {
      question: { type: 'string', description: 'One clear question for the user' },
      prompt: { type: 'string' },
      text: { type: 'string' },
      choices: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional short reply chips (max 6)'
      }
    },
    [],
    { requiredAnyOf: [['question'], ['prompt'], ['text']] }
  )
]

/**
 * A JSON schema describing one visible tool call for local grammar decoding.
 * Structured mode derives a separate arguments object from each tool contract;
 * the legacy scalar format remains available for callers that request it.
 * Used only on retries where a tool is required (never when a prose answer is OK).
 */
export function toolCallJsonSchema(
  extraNames: string[] = [],
  availableNames?: string[],
  allowStructuredArguments = false
): Record<string, unknown> {
  const names = (
    availableNames ?? [...COMPOSER_OPENAI_TOOLS.map((t) => t.function.name), ...extraNames]
  ).filter(Boolean)
  if (allowStructuredArguments) {
    // llama.cpp treats declared object properties as mandatory. Include only
    // required fields in retry grammars; optional fields remain available in
    // ordinary tool calls. Never let a generic scalar stand in for arguments.
    const requiredSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
      if (schema.type === 'object' || schema.properties) {
        const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
        const required = (schema.required ?? []) as string[]
        const alternatives = Array.isArray(schema.anyOf)
          ? (schema.anyOf as Array<{ required?: string[] }>).map((item) => item.required ?? [])
          : [[]]
        const variants = alternatives.map((extra) => {
          const fields = [...new Set([...required, ...extra])]
          return {
            type: 'object',
            properties: Object.fromEntries(
              fields.map((key) => [key, requiredSchema(properties[key] ?? {})])
            ),
            required: fields,
            additionalProperties: false
          }
        })
        return variants.length === 1 ? variants[0]! : { oneOf: variants }
      }
      if (schema.type === 'array')
        return { ...schema, items: requiredSchema((schema.items ?? {}) as Record<string, unknown>) }
      return schema
    }
    const variants = [...new Set(names)].flatMap((name) => {
      const schema = getToolContract(name)?.schema
      if (!schema) return []
      return [
        {
          type: 'object',
          properties: {
            name: { const: name },
            arguments: requiredSchema(schema)
          },
          required: ['name', 'arguments'],
          additionalProperties: false
        }
      ]
    })
    if (!variants.length)
      throw new Error('No tool schemas are available for constrained generation.')
    return { oneOf: variants }
  }
  return {
    type: 'object',
    properties: {
      name: { type: 'string', enum: Array.from(new Set(names)) }
    },
    required: ['name'],
    additionalProperties: { type: ['string', 'number', 'boolean'] }
  }
}

export function mcpToolsToOpenAI(
  tools: Array<{ fqName: string; description?: string; inputSchema?: Record<string, unknown> }>
): OpenAIToolDef[] {
  return tools.map((t) => {
    const definition = tool(t.fqName, t.description || `MCP tool ${t.fqName}`, {}, [])
    const schema = t.inputSchema
    const inputSchema =
      schema &&
      typeof schema === 'object' &&
      (schema.type === 'object' || (schema.properties && typeof schema.properties === 'object'))
        ? {
            type: 'object',
            properties: {},
            additionalProperties: true,
            ...schema
          }
        : undefined
    if (inputSchema) definition.function.parameters = inputSchema
    toolContracts.set(t.fqName, {
      access: 'full',
      effect: 'external',
      approval: 'mcp',
      discovery: 'deferred',
      schema: inputSchema
    })
    return definition
  })
}

const WEB_TOOLS = new Set(['web_search', 'web_open'])

/** Why a built-in tool is or is not in the request, with a stable reason. */
export type ToolCapabilityStatus = 'available' | 'restricted' | 'deferred' | 'disabled' | 'blocked'
export interface ToolCapability {
  name: string
  status: ToolCapabilityStatus
  reason: string
  approval: ToolApproval
  schemaChars: number
}

/**
 * The one capability record for a step. Visible schemas, search_tools candidates
 * and the exported manifest all come from it, so a request never offers a tool
 * the runtime will always reject.
 */
export function resolveToolCapabilities(input: {
  /** The effective tool policy check for this route. */
  allowedByPolicy: (name: string) => boolean
  toolPolicy: string
  imagesEnabled: boolean
  /** Connected MCP tools; search_mcp_tools only helps when some are deferred. */
  mcpToolCount: number
  /** run is visible but the gateway limits it to test, typecheck and lint commands. */
  verificationRun: boolean
  discovered: ReadonlySet<string>
  /** The public web is irrelevant to this task: keep web tools discoverable, not inline. */
  deferWeb?: boolean
}): ToolCapability[] {
  return COMPOSER_OPENAI_TOOLS.map((definition) => {
    const name = definition.function.name
    const contract = toolContracts.get(name)
    const base = {
      name,
      approval: contract?.approval ?? 'none',
      schemaChars: JSON.stringify(definition).length
    }
    const as = (status: ToolCapabilityStatus, reason: string): ToolCapability => ({
      ...base,
      status,
      reason
    })
    if (name === 'generate_image' && !input.imagesEnabled)
      return as('disabled', 'feature-disabled:images')
    if (name === 'search_mcp_tools' && input.mcpToolCount <= MAX_INLINE_MCP_TOOLS)
      return as('disabled', input.mcpToolCount ? 'mcp-catalog-inline' : 'no-mcp-tools')
    if (!input.allowedByPolicy(name)) {
      if (name === 'run' && input.verificationRun)
        return as('restricted', 'verification-commands-only')
      return as('blocked', `tool-policy:${input.toolPolicy}`)
    }
    if (contract?.discovery === 'deferred' && !input.discovered.has(name))
      return as('deferred', 'search_tools')
    if (input.deferWeb && WEB_TOOLS.has(name) && !input.discovered.has(name))
      return as('deferred', 'task-irrelevant:web')
    return as('available', input.discovered.has(name) ? 'discovered' : 'core')
  })
}

export function isVisibleCapability(capability: ToolCapability): boolean {
  return capability.status === 'available' || capability.status === 'restricted'
}
