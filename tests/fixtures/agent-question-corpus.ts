export type CorpusIntent = 'answer' | 'explore' | 'edit' | 'review' | 'plan' | 'verify'
export type CorpusAgent = 'explainer' | 'fast' | 'composer' | 'reviewer' | 'planner' | 'verifier'
export type CorpusCategory = 'coding' | 'design' | 'applications'

export type AgentQuestionCase = {
  id: string
  category: CorpusCategory
  question: string
  simulatedAnswer: string
  simulatedResponses: string[]
  expectedToken: string
  intent: CorpusIntent
  agent: CorpusAgent
  mode: 'ask' | 'agent'
  outputPath?: string
}

const intents: CorpusIntent[] = ['answer', 'explore', 'edit', 'review', 'plan', 'verify']

const topics: Record<CorpusCategory, string[]> = {
  coding: [
    'async cancellation', 'retry backoff', 'type narrowing', 'dependency injection',
    'error boundaries', 'stream parsing', 'cache invalidation', 'database transactions',
    'API pagination', 'authentication tokens', 'rate limiting', 'event queues',
    'file synchronization', 'schema validation', 'command execution', 'worker threads',
    'context compaction', 'tool dispatch', 'checkpoint recovery', 'model routing',
    'structured logging', 'telemetry sampling', 'test isolation', 'memory management',
    'concurrency control', 'incremental indexing', 'semantic search', 'diff generation',
    'configuration loading', 'release automation'
  ],
  design: [
    'editor navigation', 'chat hierarchy', 'loading feedback', 'empty states',
    'error recovery UI', 'keyboard navigation', 'accessibility contrast', 'responsive panels',
    'command palette', 'diff review flow', 'approval dialogs', 'agent progress display',
    'model picker', 'settings organization', 'onboarding flow', 'notification design',
    'search experience', 'terminal layout', 'file explorer density', 'status indicators',
    'design tokens', 'focus management', 'drag and drop', 'mobile breakpoints',
    'visual hierarchy', 'form validation', 'undo feedback', 'session history',
    'dashboard metrics', 'dark theme readability'
  ],
  applications: [
    'desktop note editor', 'inventory dashboard', 'customer support portal', 'photo review tool',
    'booking application', 'team chat client', 'expense tracker', 'document manager',
    'analytics console', 'project planner', 'code review client', 'media organizer',
    'calendar application', 'knowledge base', 'issue tracker', 'deployment console',
    'monitoring dashboard', 'learning platform', 'content scheduler', 'workflow builder',
    'CRM workspace', 'email client', 'local AI assistant', 'database browser',
    'API testing client', 'design system explorer', 'release manager', 'research notebook',
    'financial reporting tool', 'automation studio'
  ]
}

const contexts: Record<CorpusCategory, string[]> = {
  coding: ['TypeScript', 'JavaScript', 'Node.js', 'Electron', 'React', 'Python', 'Rust', 'Go'],
  design: ['desktop IDE', 'developer tool', 'admin console', 'data dashboard', 'creative app'],
  applications: ['offline use', 'large teams', 'small screens', 'high data volume', 'slow networks']
}

const targets: Record<CorpusCategory, number> = {
  coding: 4_000,
  design: 3_000,
  applications: 3_000
}

const agentForIntent: Record<CorpusIntent, CorpusAgent> = {
  answer: 'explainer',
  explore: 'fast',
  edit: 'composer',
  review: 'reviewer',
  plan: 'planner',
  verify: 'verifier'
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function sourceModule(id: string, question: string): string {
  return [
    `/** Deterministic implementation fixture for ${id}. */`,
    `export const caseId = '${id}'`,
    `export const request = ${JSON.stringify(question)}`,
    '',
    'export function describe(): string {',
    '  return `${caseId}: ${request}`',
    '}',
    '',
    '// This generated module is intentionally larger than a placeholder stub.',
    '// It exercises mutation tracking, checkpoint recording, and completion checks.',
    ''
  ].join('\n')
}

function buildCase(category: CorpusCategory, categoryIndex: number, intent: CorpusIntent): AgentQuestionCase {
  const ordinal = String(categoryIndex + 1).padStart(4, '0')
  const id = `${category}-${intent}-${ordinal}`
  const topic = topics[category][categoryIndex % topics[category].length]!
  const context = contexts[category][Math.floor(categoryIndex / topics[category].length) % contexts[category].length]!
  const symbol = `${slug(topic).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}${ordinal}`
  let question = ''
  let simulatedAnswer = ''
  let outputPath: string | undefined
  let toolResponse: string | undefined

  switch (intent) {
    case 'answer':
      question = `Explain the concept of ${topic} for ${context} systems. Reference scenario ${ordinal}.`
      simulatedAnswer = `Simulated answer ${id}: ${topic} in ${context} systems is explained with its purpose, tradeoffs, and one concrete example.`
      break
    case 'explore':
      question = `Where is ${symbol} defined?`
      simulatedAnswer = `Located ${symbol} in src/catalog.ts for simulated lookup ${id}.`
      toolResponse = JSON.stringify({ name: 'read_file', path: 'src/catalog.ts' })
      break
    case 'edit':
      outputPath = `src/generated/${category}/${slug(topic)}-${ordinal}.ts`
      question = `Create a TypeScript module for ${topic} in the ${context} scenario ${ordinal}.`
      simulatedAnswer = `DONE: Created ${outputPath} for simulated implementation ${id}.`
      toolResponse = JSON.stringify({
        name: 'write_file', path: outputPath, content: sourceModule(id, question)
      })
      break
    case 'review':
      question = `Review the codebase for ${topic} risks in the ${context} scenario ${ordinal}.`
      simulatedAnswer = `Review complete ${id}: README.md was inspected and the ${topic} risk has a concrete recommendation for the ${context} scenario.`
      toolResponse = JSON.stringify({ name: 'read_file', path: 'README.md' })
      break
    case 'plan':
      question = `Create a plan for ${topic} in this project's ${context} scenario ${ordinal}.`
      simulatedAnswer = `Plan complete ${id}: inspect the current flow, implement ${topic}, add regression coverage, and verify the ${context} result.`
      toolResponse = JSON.stringify({ name: 'read_file', path: 'README.md' })
      break
    case 'verify':
      question = `Verify the changes for ${topic} in the ${context} scenario ${ordinal}.`
      simulatedAnswer = `Verification complete ${id}: the simulated test command passed for ${topic} in the ${context} scenario.`
      toolResponse = JSON.stringify({ name: 'run', command: 'npm test' })
      break
  }

  return {
    id,
    category,
    question,
    simulatedAnswer,
    simulatedResponses: toolResponse ? [toolResponse, simulatedAnswer] : [simulatedAnswer],
    expectedToken: id,
    intent,
    agent: agentForIntent[intent],
    mode: intent === 'answer' ? 'ask' : 'agent',
    outputPath
  }
}

export const AGENT_QUESTION_CORPUS: AgentQuestionCase[] = (
  Object.keys(targets) as CorpusCategory[]
).flatMap((category) =>
  Array.from({ length: targets[category] }, (_, index) =>
    buildCase(category, index, intents[index % intents.length]!)
  )
)
