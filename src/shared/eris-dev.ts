export interface DevSummary {
  index: number
  question: string
  status: 'captured' | 'blocked' | 'error' | 'cancelled'
  agent?: string
  intent?: string
  calls: number
  detail?: string
}
export interface DevCapture {
  purpose: string
  model: string
  messages: unknown[]
  tools: unknown[]
  temperature: number
  toolChoice?: string
  schema?: Record<string, unknown>
}
export interface DevResult extends DevSummary {
  task?: unknown
  requests: DevCapture[]
  events: string[]
  durationMs: number
}
export interface DevProgress {
  running: boolean
  completed: number
  total: number
  result?: DevSummary
  error?: string
}
export interface DevApi {
  importQuestions(): Promise<{ name: string; questions: string[] } | null>
  chooseProject(): Promise<string | null>
  start(input: { context: number; mode: 'ask' | 'agent' }): Promise<void>
  stop(): Promise<void>
  result(index: number): Promise<DevResult>
  exportRun(): Promise<string | null>
  onProgress(listener: (event: DevProgress) => void): () => void
}
