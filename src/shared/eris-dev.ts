/** Export formats. v1 files remain readable through readCaptureRecord. */
export const CAPTURE_FORMAT = 'eris-dev-capture-v2'
export const LEGACY_CAPTURE_FORMAT = 'eris-dev-capture-v1'

/**
 * How intent-model requests are answered during capture. fallback replies with
 * confidence 0; malformed sends invalid JSON; timeout never replies. A question
 * record may carry its own scripted reply, which is labeled as supplied.
 */
export type IntentReplyMode = 'fallback' | 'malformed' | 'timeout'

/** One imported question with a content-derived ID that survives reordering and chunking. */
export interface DevQuestion {
  /** sha256(text) prefix plus occurrence, e.g. `3f2a9c1b04de-1`. */
  id: string
  text: string
  /** One-based line (TXT/JSONL) or record (JSON) number in the original file. */
  sourceLine: number
  /** One-based occurrence of identical text, so duplicates stay addressable. */
  occurrence: number
  /** Scripted intent reply supplied by the corpus, never by a model. */
  intentReply?: { intent: string; confidence: number }
  /** Earlier turns, so a follow-up (“implement those”) is captured as a follow-up. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface DevImportPreview {
  name: string
  corpusId: string
  questions: DevQuestion[]
  /** Lines that were not imported, each with the reason. Nothing is dropped silently. */
  excluded: Array<{ sourceLine: number; text: string; reason: string }>
  /** Normalizations applied, in plain words. */
  normalization: string[]
}

/** A deterministic request-level finding. It never grades an answer. */
export interface DevFinding {
  id: string
  severity: 'defect' | 'review'
  detail: string
}

/**
 * Independent stages. Reaching the model boundary says nothing about routing
 * coherence, and neither says anything about answer quality.
 */
export interface DevStages {
  /** The request reached the model transport boundary. */
  reachability: 'captured' | 'blocked' | 'error' | 'cancelled'
  /** Deterministic invariants over the task, prompt and tools. */
  requestValidity: 'no-findings' | 'review' | 'defects' | 'not-assessed'
  inference: 'not-run'
  answerQuality: 'not-evaluated'
}

export interface DevSummary {
  /** Zero-based position in this run; display adds one. */
  index: number
  questionId: string
  sourceLine: number
  question: string
  status: DevStages['reachability']
  stages: DevStages
  agent?: string
  intent?: string
  artifact?: string
  calls: number
  findings: { defect: number; review: number }
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
  /** Context compiler manifest for this request: blocks, trust, truncation, budget. */
  context?: unknown
  /** Tool capability record in effect for this request. */
  toolManifest?: unknown
}

export interface DevResult extends DevSummary {
  task?: unknown
  requests: DevCapture[]
  /** Model output. Capture never generates one; responseReason says why it is absent. */
  response: null
  responseReason: 'not-generated' | 'not-observed-v1'
  sourceMode: 'capture'
  intentReplySource: 'fallback' | 'malformed' | 'timeout' | 'question-script' | 'none'
  routeDecision?: unknown
  retrieval?: unknown
  workflowLint?: unknown
  findingsDetail: DevFinding[]
  events: string[]
  /** Local pre-inference phases. Not model latency and not generation speed. */
  phases: { routeMs: number; resolveMs: number; promptMs: number; toBoundaryMs: number }
  timing: 'pre-inference'
  durationMs: number
}

export interface DevRunHeader {
  format: typeof CAPTURE_FORMAT
  created: string
  app: { name: 'Eris-Dev'; version: string; gitSha: string; dirty: boolean | null }
  versions: { routing: string; prompt: string; schema: typeof CAPTURE_FORMAT }
  /** sha256 of the capture settings; settings never contain credentials in capture. */
  settingsDigest: string
  corpus: { id: string; name: string; total: number; excluded: number }
  fixture: {
    kind: 'sample' | 'project' | 'none'
    digest: string | null
    files: number
    omitted: Array<{ category: string; count: number; examples: string[] }>
  }
  context: number
  mode: 'ask' | 'agent'
  intentReplyMode: IntentReplyMode
  responses: 'none'
  answerQuality: 'not-evaluated'
}

export interface DevProgress {
  running: boolean
  completed: number
  total: number
  result?: DevSummary
  error?: string
}

export interface DevApi {
  importQuestions(): Promise<DevImportPreview | null>
  chooseProject(): Promise<string | null>
  setProjectKind(kind: 'sample' | 'none'): Promise<void>
  start(input: {
    context: number
    mode: 'ask' | 'agent'
    intentReplyMode: IntentReplyMode
  }): Promise<void>
  stop(): Promise<void>
  result(index: number): Promise<DevResult>
  exportRun(): Promise<string | null>
  onProgress(listener: (event: DevProgress) => void): () => void
}

const ZERO_PHASES = { routeMs: 0, resolveMs: 0, promptMs: 0, toBoundaryMs: 0 }

/**
 * Read one exported record of either format. A v1 record never claims a
 * response: its detail was the capture-stop message, not model output.
 */
export function readCaptureRecord(record: Record<string, unknown>): DevResult {
  if (record.responseReason) return record as unknown as DevResult
  const status = (record.status as DevStages['reachability']) ?? 'error'
  return {
    index: Number(record.index ?? 0),
    questionId: String(record.questionId ?? `v1-${record.index ?? 0}`),
    sourceLine: Number(record.index ?? 0) + 1,
    question: String(record.question ?? ''),
    status,
    stages: {
      reachability: status,
      requestValidity: 'not-assessed',
      inference: 'not-run',
      answerQuality: 'not-evaluated'
    },
    agent: record.agent as string | undefined,
    intent: record.intent as string | undefined,
    calls: Number(record.calls ?? 0),
    findings: { defect: 0, review: 0 },
    detail: record.detail as string | undefined,
    task: record.task,
    requests: (record.requests as DevCapture[]) ?? [],
    response: null,
    responseReason: 'not-observed-v1',
    sourceMode: 'capture',
    intentReplySource: 'fallback',
    findingsDetail: [],
    events: (record.events as string[]) ?? [],
    phases: ZERO_PHASES,
    timing: 'pre-inference',
    durationMs: Number(record.durationMs ?? 0)
  }
}
